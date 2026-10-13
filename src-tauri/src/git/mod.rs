pub mod discover;
pub mod message;

use git2::{BranchType, DiffOptions, Patch, Repository};
use serde::Serialize;
use std::io::Write as _;
use std::path::Path;
use std::process::Stdio;

#[derive(Serialize)]
pub struct GithubRepo {
    pub owner: String,
    pub repo: String,
}

#[derive(Serialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct GitInfo {
    pub is_repo: bool,
    pub branch: Option<String>,
    pub github_repo: Option<GithubRepo>,
    pub has_upstream: bool,
    pub ahead: usize,
    pub behind: usize,
    pub dirty: bool,
    /// Paths with any change, staged or not. A path counts once.
    pub changed: usize,
    pub default_branch: Option<String>,
}

fn parse_github_remote(url: &str) -> Option<GithubRepo> {
    let t = url.trim().trim_end_matches(".git");
    let tail = if let Some(rest) = t.strip_prefix("git@github.com:") {
        rest
    } else if let Some(rest) = t.strip_prefix("ssh://git@github.com/") {
        rest
    } else if let Some(idx) = t.find("github.com/") {
        &t[idx + "github.com/".len()..]
    } else {
        return None;
    };
    let (owner, repo) = tail.split_once('/')?;
    if owner.is_empty() || repo.is_empty() {
        return None;
    }
    Some(GithubRepo {
        owner: owner.to_string(),
        repo: repo.to_string(),
    })
}

pub fn get_info(root: &Path) -> GitInfo {
    let repo = match Repository::discover(root) {
        Ok(r) => r,
        Err(_) => return GitInfo::default(),
    };

    let mut info = GitInfo {
        is_repo: true,
        ..Default::default()
    };

    let head = repo.head().ok();
    let branch_name = head
        .as_ref()
        .filter(|h| h.is_branch())
        .and_then(|h| h.shorthand().map(String::from));
    info.branch = branch_name.clone();

    if let Ok(remote) = repo.find_remote("origin") {
        if let Some(url) = remote.url() {
            info.github_repo = parse_github_remote(url);
        }
    }

    if let Some(name) = &branch_name {
        if let Ok(local) = repo.find_branch(name, BranchType::Local) {
            if let Ok(upstream) = local.upstream() {
                info.has_upstream = true;
                if let (Some(local_oid), Some(up_oid)) = (
                    local.get().target(),
                    upstream.get().target(),
                ) {
                    if let Ok((ahead, behind)) = repo.graph_ahead_behind(local_oid, up_oid) {
                        info.ahead = ahead;
                        info.behind = behind;
                    }
                }
            }
        }
    }

    let mut status_opts = git2::StatusOptions::new();
    status_opts.include_untracked(true).recurse_untracked_dirs(true);
    if let Ok(statuses) = repo.statuses(Some(&mut status_opts)) {
        info.dirty = !statuses.is_empty();
        info.changed = statuses.len();
    }

    if let Ok(reference) = repo.find_reference("refs/remotes/origin/HEAD") {
        if let Some(target) = reference.symbolic_target() {
            info.default_branch = target
                .strip_prefix("refs/remotes/origin/")
                .map(String::from);
        }
    }

    info
}

/// Cheap working-tree dirty check for a single repo (opens exactly at `root`, no
/// upward walk, so a submodule can't report its parent's state).
pub fn is_dirty(root: &Path) -> bool {
    let repo = match Repository::open(root) {
        Ok(r) => r,
        Err(_) => return false,
    };
    let mut opts = git2::StatusOptions::new();
    opts.include_untracked(true).recurse_untracked_dirs(true);
    repo.statuses(Some(&mut opts))
        .map(|s| !s.is_empty())
        .unwrap_or(false)
}

pub fn push(root: &Path, branch: &str) -> (bool, String) {
    match crate::proc::hidden_command("git")
        .args(["push", "-u", "origin", branch])
        .current_dir(root)
        .env("LANG", "C")
        .env("LC_ALL", "C")
        .output()
    {
        Ok(out) => {
            let ok = out.status.success();
            let mut s = String::from_utf8_lossy(&out.stdout).to_string();
            let err = String::from_utf8_lossy(&out.stderr);
            if !err.is_empty() {
                if !s.is_empty() {
                    s.push('\n');
                }
                s.push_str(&err);
            }
            (ok, s.trim().to_string())
        }
        Err(e) => (false, e.to_string()),
    }
}

// ---- diff ----

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DiffLine {
    /// ' ' context, '+' added, '-' removed
    pub origin: String,
    pub content: String,
    pub old_lineno: Option<u32>,
    pub new_lineno: Option<u32>,
}

#[derive(Serialize)]
pub struct Hunk {
    pub header: String,
    pub lines: Vec<DiffLine>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct FileDiff {
    /// path relative to repo root, forward slashes
    pub path: String,
    pub old_path: Option<String>,
    /// added | modified | deleted | renamed | copied | typechange
    pub status: String,
    pub binary: bool,
    /// The diff was cut short (or left out) to keep the payload bounded.
    pub truncated: bool,
    pub hunks: Vec<Hunk>,
}

fn status_label(s: git2::Delta) -> &'static str {
    use git2::Delta;
    match s {
        Delta::Added | Delta::Untracked => "added",
        Delta::Deleted => "deleted",
        Delta::Renamed => "renamed",
        Delta::Copied => "copied",
        Delta::Typechange => "typechange",
        _ => "modified",
    }
}

/// Which changes a diff covers.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum DiffScope {
    /// HEAD against the index and working tree together.
    All,
    /// HEAD against the index: what a commit would contain.
    Staged,
    /// The index against the working tree, untracked files included.
    Unstaged,
}

impl DiffScope {
    pub fn parse(value: Option<&str>) -> Self {
        match value {
            Some("staged") => DiffScope::Staged,
            Some("unstaged") => DiffScope::Unstaged,
            _ => DiffScope::All,
        }
    }
}

// A new, un-ignored file is read in full for the Changes list, so the diff
// handed to the interface is bounded: per file by lines and bytes, and per
// call by total bytes, after which files are listed without their content.
const MAX_LINES_PER_FILE: usize = 5_000;
const MAX_BYTES_PER_FILE: usize = 512 * 1024;
const MAX_BYTES_PER_CALL: usize = 8 * 1024 * 1024;

fn files_from_diff(diff: &git2::Diff) -> Vec<FileDiff> {
    let mut files: Vec<FileDiff> = Vec::new();
    let mut total_bytes = 0usize;
    for idx in 0..diff.deltas().len() {
        let Some(delta) = diff.get_delta(idx) else {
            continue;
        };
        let to_path = |p: Option<&Path>| p.map(|p| p.to_string_lossy().replace('\\', "/"));
        let new_path = to_path(delta.new_file().path());
        let old_path = to_path(delta.old_file().path());
        let path = new_path.clone().or_else(|| old_path.clone()).unwrap_or_default();

        let mut hunks: Vec<Hunk> = Vec::new();
        let mut binary = delta.flags().is_binary();
        let mut kept = 0usize;
        let mut bytes = 0usize;
        let mut truncated = false;
        let over = |kept: usize, bytes: usize| kept >= MAX_LINES_PER_FILE || bytes >= MAX_BYTES_PER_FILE;

        // Past the call's budget the patch is not built at all, which is what
        // spares reading the file.
        let patch = if total_bytes >= MAX_BYTES_PER_CALL {
            truncated = true;
            Ok(None)
        } else {
            Patch::from_diff(diff, idx)
        };
        match patch {
            Ok(Some(patch)) => {
                for h in 0..patch.num_hunks() {
                    if over(kept, bytes) {
                        truncated = true;
                        break;
                    }
                    let header = match patch.hunk(h) {
                        Ok((hunk, _)) => String::from_utf8_lossy(hunk.header()).trim_end().to_string(),
                        Err(_) => String::new(),
                    };
                    let mut lines: Vec<DiffLine> = Vec::new();
                    for l in 0..patch.num_lines_in_hunk(h).unwrap_or(0) {
                        if over(kept, bytes) {
                            truncated = true;
                            break;
                        }
                        if let Ok(line) = patch.line_in_hunk(h, l) {
                            kept += 1;
                            bytes += line.content().len();
                            lines.push(DiffLine {
                                origin: line.origin().to_string(),
                                content: String::from_utf8_lossy(line.content())
                                    .trim_end_matches(['\n', '\r'])
                                    .to_string(),
                                old_lineno: line.old_lineno(),
                                new_lineno: line.new_lineno(),
                            });
                        }
                    }
                    hunks.push(Hunk { header, lines });
                }
            }
            Ok(None) | Err(_) => binary = !truncated,
        }
        total_bytes += bytes;

        files.push(FileDiff {
            path,
            old_path: old_path.filter(|o| Some(o) != new_path.as_ref()),
            status: status_label(delta.status()).to_string(),
            binary,
            truncated,
            hunks,
        });
    }
    files
}

/// Uncommitted changes as structured per-file hunks for the diff viewer.
///
/// Opens exactly `root`, never an enclosing repo: an uninitialised submodule's
/// empty folder must not show (and then stage) its parent's changes.
pub fn diff(root: &Path, scope: DiffScope) -> Result<Vec<FileDiff>, String> {
    let repo = Repository::open(root).map_err(|e| e.to_string())?;
    let head_tree = repo.head().ok().and_then(|h| h.peel_to_tree().ok());

    let mut opts = DiffOptions::new();
    opts.include_untracked(true)
        .recurse_untracked_dirs(true)
        .context_lines(3);

    let diff = match scope {
        DiffScope::All => repo.diff_tree_to_workdir_with_index(head_tree.as_ref(), Some(&mut opts)),
        DiffScope::Staged => repo.diff_tree_to_index(head_tree.as_ref(), None, Some(&mut opts)),
        DiffScope::Unstaged => {
            opts.show_untracked_content(true);
            repo.diff_index_to_workdir(None, Some(&mut opts))
        }
    }
    .map_err(|e| e.to_string())?;

    Ok(files_from_diff(&diff))
}

// ---- staging and committing ----

/// Runs the `git` program in `root` with no shell: arguments are passed as
/// given and `stdin` is written to its standard input.
///
/// Refuses a folder that is not a repository of its own, because git would
/// walk up and act on the enclosing one. Git's own credential prompt fails
/// instead of hanging the app. Nothing else in the environment is changed, so
/// the user's hooks behave as they do in a terminal.
fn run_git(root: &Path, args: &[&str], stdin: Option<&str>) -> (bool, String) {
    if !root.join(".git").exists() {
        return (false, "This folder is not a git repository of its own".to_string());
    }
    let mut cmd = crate::proc::hidden_command("git");
    cmd.args(args)
        .current_dir(root)
        .env("GIT_TERMINAL_PROMPT", "0")
        .stdin(if stdin.is_some() { Stdio::piped() } else { Stdio::null() })
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());
    let mut child = match cmd.spawn() {
        Ok(child) => child,
        Err(e) => return (false, e.to_string()),
    };
    // Written from its own thread: git reads the commit message only after its
    // hooks finish, and a hook that fills the output pipe meanwhile would
    // otherwise deadlock against a blocked write here.
    let writer = match (stdin, child.stdin.take()) {
        (Some(input), Some(mut pipe)) => {
            let input = input.to_string();
            Some(std::thread::spawn(move || {
                let _ = pipe.write_all(input.as_bytes());
            }))
        }
        _ => None,
    };
    let result = child.wait_with_output();
    if let Some(writer) = writer {
        let _ = writer.join();
    }
    match result {
        Ok(out) => {
            let mut text = String::from_utf8_lossy(&out.stdout).to_string();
            let err = String::from_utf8_lossy(&out.stderr);
            if !err.is_empty() {
                if !text.is_empty() {
                    text.push('\n');
                }
                text.push_str(&err);
            }
            (out.status.success(), text.trim().to_string())
        }
        Err(e) => (false, e.to_string()),
    }
}

// Paths from the lists are exact names: a file called `[id].txt` must not act
// as a glob that also matches `i.txt`. Passed as an option, not through the
// environment, so it does not leak into the user's hooks.
const LITERAL_PATHS: &str = "--literal-pathspecs";

/// Stage the given paths (relative to the repo root), or everything when none
/// are given. `-A` so a deleted file's removal is staged too.
pub fn stage(root: &Path, paths: &[String]) -> (bool, String) {
    let mut args: Vec<&str> = vec![LITERAL_PATHS, "add", "-A"];
    if !paths.is_empty() {
        args.push("--");
        args.extend(paths.iter().map(String::as_str));
    }
    run_git(root, &args, None)
}

/// Unstage the given paths, or everything when none are given. `git reset`
/// treats an unborn HEAD as the empty tree, so this also works before the
/// first commit.
///
/// Refused while a merge, rebase or cherry-pick is in progress: resetting a
/// conflicted path there discards the record that it is unresolved, and the
/// next commit would then take the conflict markers as content.
pub fn unstage(root: &Path, paths: &[String]) -> (bool, String) {
    let in_progress = Repository::open(root)
        .map(|repo| repo.state() != git2::RepositoryState::Clean)
        .unwrap_or(false);
    if in_progress {
        return (
            false,
            "A merge or rebase is in progress. Finish or abort it in the terminal before unstaging here."
                .to_string(),
        );
    }
    let mut args: Vec<&str> = vec![LITERAL_PATHS, "reset", "-q", "HEAD", "--"];
    if paths.is_empty() {
        args.push(".");
    } else {
        args.extend(paths.iter().map(String::as_str));
    }
    run_git(root, &args, None)
}

/// Commit what is staged. Goes through the `git` program so the user's hooks
/// and signing apply; the message travels on standard input.
pub fn commit(root: &Path, message: &str) -> (bool, String) {
    if message.trim().is_empty() {
        return (false, "Commit message is empty".to_string());
    }
    run_git(root, &["commit", "-F", "-"], Some(message))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_github_remotes() {
        for url in [
            "git@github.com:owner/repo.git",
            "https://github.com/owner/repo",
            "ssh://git@github.com/owner/repo.git",
            "https://user@github.com/owner/repo.git",
        ] {
            let g = parse_github_remote(url).expect(url);
            assert_eq!(g.owner, "owner");
            assert_eq!(g.repo, "repo");
        }
        assert!(parse_github_remote("https://gitlab.com/owner/repo").is_none());
    }

    fn init_repo() -> (tempfile::TempDir, Repository) {
        let dir = tempfile::tempdir().unwrap();
        let repo = Repository::init(dir.path()).unwrap();
        let hooks = dir.path().join(".git").join("no-hooks");
        std::fs::create_dir_all(&hooks).unwrap();
        let mut cfg = repo.config().unwrap();
        cfg.set_str("user.name", "Test").unwrap();
        cfg.set_str("user.email", "test@example.com").unwrap();
        cfg.set_bool("commit.gpgsign", false).unwrap();
        cfg.set_str("core.hooksPath", &hooks.to_string_lossy()).unwrap();
        (dir, repo)
    }

    fn write(root: &Path, name: &str, content: &str) {
        std::fs::write(root.join(name), content).unwrap();
    }

    fn paths(root: &Path, scope: DiffScope) -> Vec<String> {
        let mut out: Vec<String> = diff(root, scope).unwrap().into_iter().map(|f| f.path).collect();
        out.sort();
        out
    }

    #[test]
    fn info_counts_each_changed_path_once() {
        let (dir, _repo) = init_repo();
        let root = dir.path();
        assert_eq!(get_info(root).changed, 0);

        write(root, "a.txt", "one\n");
        write(root, "b.txt", "one\n");
        let (ok, out) = stage(root, &["a.txt".to_string()]);
        assert!(ok, "{out}");
        // a.txt is now both staged and modified again; b.txt is untracked.
        write(root, "a.txt", "two\n");

        let info = get_info(root);
        assert_eq!(info.changed, 2);
        assert!(info.dirty);
    }

    #[test]
    fn parses_diff_scopes() {
        assert_eq!(DiffScope::parse(Some("staged")), DiffScope::Staged);
        assert_eq!(DiffScope::parse(Some("unstaged")), DiffScope::Unstaged);
        assert_eq!(DiffScope::parse(Some("anything")), DiffScope::All);
        assert_eq!(DiffScope::parse(None), DiffScope::All);
    }

    #[test]
    fn stages_commits_and_separates_staged_from_unstaged() {
        let (dir, repo) = init_repo();
        let root = dir.path();

        write(root, "a.txt", "one\n");
        let (ok, out) = stage(root, &[]);
        assert!(ok, "{out}");
        assert_eq!(paths(root, DiffScope::Staged), ["a.txt"]);
        assert!(paths(root, DiffScope::Unstaged).is_empty());

        let (ok, out) = commit(root, "first\n\nbody line");
        assert!(ok, "{out}");
        let head = repo.head().unwrap().peel_to_commit().unwrap();
        assert_eq!(head.summary(), Some("first"));
        assert!(head.message().unwrap().contains("body line"));
        assert!(paths(root, DiffScope::All).is_empty());

        write(root, "a.txt", "one\ntwo\n");
        let (ok, out) = stage(root, &["a.txt".to_string()]);
        assert!(ok, "{out}");
        write(root, "a.txt", "one\ntwo\nthree\n");
        write(root, "b.txt", "new\n");

        assert_eq!(paths(root, DiffScope::Staged), ["a.txt"]);
        assert_eq!(paths(root, DiffScope::Unstaged), ["a.txt", "b.txt"]);
        assert_eq!(paths(root, DiffScope::All), ["a.txt", "b.txt"]);

        let unstaged = diff(root, DiffScope::Unstaged).unwrap();
        let untracked = unstaged.iter().find(|f| f.path == "b.txt").unwrap();
        assert_eq!(untracked.status, "added");
        assert!(!untracked.hunks.is_empty());
    }

    #[test]
    fn a_path_with_glob_characters_stages_only_itself() {
        let (dir, _repo) = init_repo();
        let root = dir.path();
        write(root, "[id].txt", "x\n");
        write(root, "i.txt", "x\n");
        write(root, "d.txt", "x\n");
        let (ok, out) = stage(root, &["[id].txt".to_string()]);
        assert!(ok, "{out}");
        assert_eq!(paths(root, DiffScope::Staged), ["[id].txt"]);

        let (ok, out) = unstage(root, &["[id].txt".to_string()]);
        assert!(ok, "{out}");
        assert!(paths(root, DiffScope::Staged).is_empty());
    }

    #[test]
    fn unstages_one_file_and_everything() {
        let (dir, _repo) = init_repo();
        let root = dir.path();
        write(root, "a.txt", "one\n");
        write(root, "b.txt", "one\n");
        assert!(stage(root, &[]).0);
        assert!(commit(root, "base").0);

        write(root, "a.txt", "two\n");
        write(root, "b.txt", "two\n");
        assert!(stage(root, &[]).0);
        assert_eq!(paths(root, DiffScope::Staged), ["a.txt", "b.txt"]);

        let (ok, out) = unstage(root, &["a.txt".to_string()]);
        assert!(ok, "{out}");
        assert_eq!(paths(root, DiffScope::Staged), ["b.txt"]);
        assert_eq!(paths(root, DiffScope::Unstaged), ["a.txt"]);

        let (ok, out) = unstage(root, &[]);
        assert!(ok, "{out}");
        assert!(paths(root, DiffScope::Staged).is_empty());
        assert_eq!(paths(root, DiffScope::Unstaged), ["a.txt", "b.txt"]);
    }

    #[test]
    fn unstages_before_the_first_commit_even_after_a_further_edit() {
        let (dir, _repo) = init_repo();
        let root = dir.path();
        write(root, "a.txt", "one\n");
        write(root, "b.txt", "one\n");
        assert!(stage(root, &[]).0);
        write(root, "a.txt", "two\n");

        let (ok, out) = unstage(root, &["a.txt".to_string()]);
        assert!(ok, "{out}");
        assert_eq!(paths(root, DiffScope::Staged), ["b.txt"]);

        let (ok, out) = unstage(root, &[]);
        assert!(ok, "{out}");
        assert!(paths(root, DiffScope::Staged).is_empty());
        assert_eq!(std::fs::read_to_string(root.join("a.txt")).unwrap(), "two\n");
        assert!(root.join("b.txt").exists());
    }

    #[test]
    fn commit_refuses_a_blank_message_and_reports_nothing_staged() {
        let (dir, _repo) = init_repo();
        let root = dir.path();
        write(root, "a.txt", "one\n");
        assert!(stage(root, &[]).0);

        let (ok, out) = commit(root, "  \n ");
        assert!(!ok);
        assert_eq!(out, "Commit message is empty");
        assert_eq!(paths(root, DiffScope::Staged), ["a.txt"]);

        assert!(commit(root, "base").0);
        let (ok, out) = commit(root, "again");
        assert!(!ok);
        assert!(!out.is_empty());
    }

    #[test]
    fn a_long_new_file_is_cut_off_and_says_so() {
        let (dir, _repo) = init_repo();
        let root = dir.path();
        write(root, "big.txt", &"line\n".repeat(MAX_LINES_PER_FILE + 500));
        write(root, "small.txt", "line\n");
        let files = diff(root, DiffScope::Unstaged).unwrap();
        let big = files.iter().find(|f| f.path == "big.txt").unwrap();
        let lines: usize = big.hunks.iter().map(|h| h.lines.len()).sum();
        assert_eq!(lines, MAX_LINES_PER_FILE);
        assert!(big.truncated);
        assert!(!files.iter().find(|f| f.path == "small.txt").unwrap().truncated);
    }

    #[test]
    fn a_file_with_one_enormous_line_is_cut_off_by_size() {
        let (dir, _repo) = init_repo();
        let root = dir.path();
        let line = "x".repeat(MAX_BYTES_PER_FILE + 10);
        write(root, "min.js", &format!("{line}\nsecond\nthird\n"));
        let files = diff(root, DiffScope::Unstaged).unwrap();
        let lines: usize = files[0].hunks.iter().map(|h| h.lines.len()).sum();
        assert_eq!(lines, 1);
        assert!(files[0].truncated);
    }

    #[test]
    fn a_folder_without_its_own_git_dir_never_touches_the_enclosing_repo() {
        let (dir, _repo) = init_repo();
        let root = dir.path();
        write(root, "a.txt", "one\n");
        let sub = root.join("uninitialised-submodule");
        std::fs::create_dir_all(&sub).unwrap();

        let (ok, out) = stage(&sub, &[]);
        assert!(!ok);
        assert_eq!(out, "This folder is not a git repository of its own");
        assert!(!commit(&sub, "oops").0);
        assert!(diff(&sub, DiffScope::Unstaged).is_err());
        assert!(paths(root, DiffScope::Staged).is_empty());
    }

    #[test]
    fn unstage_is_refused_while_a_merge_is_in_progress() {
        let (dir, _repo) = init_repo();
        let root = dir.path();
        write(root, "c.txt", "base\n");
        assert!(stage(root, &[]).0);
        assert!(commit(root, "base").0);
        assert!(run_git(root, &["checkout", "-q", "-b", "side"], None).0);
        write(root, "c.txt", "side\n");
        assert!(stage(root, &[]).0);
        assert!(commit(root, "side").0);
        assert!(run_git(root, &["checkout", "-q", "-"], None).0);
        write(root, "c.txt", "main\n");
        assert!(stage(root, &[]).0);
        assert!(commit(root, "main").0);
        assert!(!run_git(root, &["merge", "side"], None).0);

        let (ok, out) = unstage(root, &["c.txt".to_string()]);
        assert!(!ok);
        assert!(out.contains("merge or rebase is in progress"), "{out}");
        let (ok, _) = unstage(root, &[]);
        assert!(!ok);
    }
}
