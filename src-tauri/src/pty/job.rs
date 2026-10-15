use std::os::windows::io::{AsRawHandle, FromRawHandle, OwnedHandle};
use windows_sys::Win32::Foundation::HANDLE;
use windows_sys::Win32::System::JobObjects::{
    AssignProcessToJobObject, CreateJobObjectW, JobObjectExtendedLimitInformation,
    SetInformationJobObject, TerminateJobObject, JOBOBJECT_EXTENDED_LIMIT_INFORMATION,
    JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE,
};
use windows_sys::Win32::System::Threading::{OpenProcess, PROCESS_SET_QUOTA, PROCESS_TERMINATE};

/// Owned Windows Job Object with kill-on-close semantics. Assigning the shell
/// process pulls its whole tree in (processes spawned by a job member join the
/// job automatically), so `terminate()` — or dropping the handle — kills the
/// shell, its children, and any grandchildren keeping the ConPTY alive.
pub struct JobObject {
    handle: OwnedHandle,
}

impl JobObject {
    pub fn new() -> std::io::Result<Self> {
        // SAFETY: null attributes and name are valid; a non-null return is a
        // fresh handle we take sole ownership of below.
        let raw = unsafe { CreateJobObjectW(std::ptr::null(), std::ptr::null()) };
        if raw.is_null() {
            return Err(std::io::Error::last_os_error());
        }
        // Own it immediately so the error path below closes it on drop.
        let handle = unsafe { OwnedHandle::from_raw_handle(raw as _) };

        let mut info: JOBOBJECT_EXTENDED_LIMIT_INFORMATION = unsafe { std::mem::zeroed() };
        info.BasicLimitInformation.LimitFlags = JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE;
        // SAFETY: `info` outlives the call and is exactly the size we pass.
        let ok = unsafe {
            SetInformationJobObject(
                handle.as_raw_handle() as HANDLE,
                JobObjectExtendedLimitInformation,
                &info as *const _ as *const _,
                std::mem::size_of::<JOBOBJECT_EXTENDED_LIMIT_INFORMATION>() as u32,
            )
        };
        if ok == 0 {
            return Err(std::io::Error::last_os_error());
        }
        Ok(Self { handle })
    }

    pub fn assign_pid(&self, pid: u32) -> std::io::Result<()> {
        // SAFETY: a non-null return is a process handle we own and close on drop.
        let raw = unsafe { OpenProcess(PROCESS_SET_QUOTA | PROCESS_TERMINATE, 0, pid) };
        if raw.is_null() {
            return Err(std::io::Error::last_os_error());
        }
        let proc = unsafe { OwnedHandle::from_raw_handle(raw as _) };
        // SAFETY: both handles are valid for the duration of the call.
        let ok = unsafe {
            AssignProcessToJobObject(
                self.handle.as_raw_handle() as HANDLE,
                proc.as_raw_handle() as HANDLE,
            )
        };
        if ok == 0 {
            return Err(std::io::Error::last_os_error());
        }
        Ok(())
    }

    pub fn terminate(&self) {
        // SAFETY: the job handle is valid; failure is not actionable here.
        unsafe {
            TerminateJobObject(self.handle.as_raw_handle() as HANDLE, 1);
        }
    }

    /// Every process in the job, or None if the query failed (including a
    /// tree too big for the buffer) — callers must treat None as "unknown".
    #[cfg(any(test, feature = "remote-access"))]
    pub fn pids(&self) -> Option<Vec<u32>> {
        use windows_sys::Win32::System::JobObjects::{
            JobObjectBasicProcessIdList, QueryInformationJobObject,
        };
        const CAP: usize = 1024;

        // Mirrors JOBOBJECT_BASIC_PROCESS_ID_LIST but with room for many pids.
        #[repr(C)]
        struct ProcessIdList {
            number_of_assigned_processes: u32,
            number_of_process_ids_in_list: u32,
            process_id_list: [usize; CAP],
        }

        let mut list: Box<ProcessIdList> = Box::new(unsafe { std::mem::zeroed() });
        // SAFETY: buffer and length match; return length is optional (null).
        let ok = unsafe {
            QueryInformationJobObject(
                self.handle.as_raw_handle() as HANDLE,
                JobObjectBasicProcessIdList,
                &mut *list as *mut _ as *mut _,
                std::mem::size_of::<ProcessIdList>() as u32,
                std::ptr::null_mut(),
            )
        };
        if ok == 0 {
            return None;
        }
        let n = (list.number_of_process_ids_in_list as usize).min(CAP);
        Some(list.process_id_list[..n].iter().map(|&p| p as u32).collect())
    }

    /// Full image paths of the job's processes, or None when the job can't be
    /// listed. A process that exited (or can't be opened) is skipped.
    #[cfg(feature = "remote-access")]
    pub fn image_paths(&self) -> Option<Vec<String>> {
        use windows_sys::Win32::System::Threading::{
            QueryFullProcessImageNameW, PROCESS_NAME_WIN32, PROCESS_QUERY_LIMITED_INFORMATION,
        };
        let mut out = Vec::new();
        for pid in self.pids()? {
            // SAFETY: a non-null return is a process handle we own and close on drop.
            let raw = unsafe { OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, 0, pid) };
            if raw.is_null() {
                continue;
            }
            let proc = unsafe { OwnedHandle::from_raw_handle(raw as _) };
            let mut buf = [0u16; 1024];
            let mut len = buf.len() as u32;
            // SAFETY: `buf` holds `len` u16s; the call writes at most that many.
            let ok = unsafe {
                QueryFullProcessImageNameW(
                    proc.as_raw_handle() as HANDLE,
                    PROCESS_NAME_WIN32,
                    buf.as_mut_ptr(),
                    &mut len,
                )
            };
            if ok != 0 {
                out.push(String::from_utf16_lossy(&buf[..len as usize]));
            }
        }
        Some(out)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::process::Command;
    use std::time::{Duration, Instant};

    #[test]
    fn terminating_job_kills_assigned_process() {
        let mut child = Command::new("cmd")
            .args(["/c", "ping -n 60 127.0.0.1 > NUL"])
            .spawn()
            .expect("spawn cmd");

        let job = JobObject::new().expect("create job");
        job.assign_pid(child.id()).expect("assign pid");
        job.terminate();

        let deadline = Instant::now() + Duration::from_secs(5);
        let mut exited = false;
        while Instant::now() < deadline {
            match child.try_wait() {
                Ok(Some(_)) => {
                    exited = true;
                    break;
                }
                Ok(None) => std::thread::sleep(Duration::from_millis(100)),
                Err(_) => break,
            }
        }

        let _ = child.kill();
        let _ = child.wait();
        assert!(exited, "assigned process should have been killed by the job");
    }

    #[test]
    fn terminating_job_kills_grandchild_processes() {
        let mut child = Command::new("cmd")
            .args(["/c", "ping -n 60 127.0.0.1 > NUL"])
            .spawn()
            .expect("spawn cmd");

        let job = JobObject::new().expect("create job");
        job.assign_pid(child.id()).expect("assign pid");

        // cmd is the child, ping is the grandchild; both should be job members.
        let deadline = Instant::now() + Duration::from_secs(10);
        let mut saw_tree = false;
        while Instant::now() < deadline {
            if job.pids().unwrap_or_default().len() >= 2 {
                saw_tree = true;
                break;
            }
            std::thread::sleep(Duration::from_millis(100));
        }
        assert!(saw_tree, "job should contain the shell and its grandchild");

        job.terminate();

        let deadline = Instant::now() + Duration::from_secs(5);
        let mut emptied = false;
        while Instant::now() < deadline {
            if job.pids().is_some_and(|p| p.is_empty()) {
                emptied = true;
                break;
            }
            std::thread::sleep(Duration::from_millis(100));
        }

        let _ = child.wait();
        assert!(emptied, "terminating the job should kill every member process");
    }
}
