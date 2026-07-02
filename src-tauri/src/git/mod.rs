pub mod discover;

use git2::{BranchType, DiffOptions, Patch, Repository};
use serde::Serialize;
use std::path::Path;
use std::process::Command;

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
    match Command::new("git")
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

/// All uncommitted changes (HEAD/index vs working tree) as structured per-file
/// hunks for the diff viewer.
pub fn diff(root: &Path) -> Result<Vec<FileDiff>, String> {
    let repo = Repository::discover(root).map_err(|e| e.to_string())?;

    let head_tree = repo
        .head()
        .ok()
        .and_then(|h| h.peel_to_tree().ok());

    let mut opts = DiffOptions::new();
    opts.include_untracked(true)
        .recurse_untracked_dirs(true)
        .context_lines(3);

    let diff = repo
        .diff_tree_to_workdir_with_index(head_tree.as_ref(), Some(&mut opts))
        .map_err(|e| e.to_string())?;

    let mut files: Vec<FileDiff> = Vec::new();
    let deltas = diff.deltas().len();
    for idx in 0..deltas {
        let delta = match diff.get_delta(idx) {
            Some(d) => d,
            None => continue,
        };
        let to_path = |p: Option<&Path>| {
            p.map(|p| p.to_string_lossy().replace('\\', "/"))
        };
        let new_path = to_path(delta.new_file().path());
        let old_path = to_path(delta.old_file().path());
        let path = new_path.clone().or_else(|| old_path.clone()).unwrap_or_default();

        let mut hunks: Vec<Hunk> = Vec::new();
        let mut binary = delta.flags().is_binary();

        match Patch::from_diff(&diff, idx) {
            Ok(Some(patch)) => {
                let num_hunks = patch.num_hunks();
                for h in 0..num_hunks {
                    let header = match patch.hunk(h) {
                        Ok((hunk, _)) => String::from_utf8_lossy(hunk.header()).trim_end().to_string(),
                        Err(_) => String::new(),
                    };
                    let line_count = patch.num_lines_in_hunk(h).unwrap_or(0);
                    let mut lines: Vec<DiffLine> = Vec::new();
                    for l in 0..line_count {
                        if let Ok(line) = patch.line_in_hunk(h, l) {
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
            Ok(None) => binary = true,
            Err(_) => binary = true,
        }

        files.push(FileDiff {
            path,
            old_path: old_path.filter(|o| Some(o) != new_path.as_ref()),
            status: status_label(delta.status()).to_string(),
            binary,
            hunks,
        });
    }

    Ok(files)
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
}
