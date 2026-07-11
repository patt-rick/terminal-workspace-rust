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

    #[cfg(test)]
    pub fn pids(&self) -> Vec<u32> {
        use windows_sys::Win32::System::JobObjects::{
            JobObjectBasicProcessIdList, QueryInformationJobObject,
        };

        // Mirrors JOBOBJECT_BASIC_PROCESS_ID_LIST but with room for many pids.
        #[repr(C)]
        struct ProcessIdList {
            number_of_assigned_processes: u32,
            number_of_process_ids_in_list: u32,
            process_id_list: [usize; 64],
        }

        let mut list: ProcessIdList = unsafe { std::mem::zeroed() };
        // SAFETY: buffer and length match; return length is optional (null).
        let ok = unsafe {
            QueryInformationJobObject(
                self.handle.as_raw_handle() as HANDLE,
                JobObjectBasicProcessIdList,
                &mut list as *mut _ as *mut _,
                std::mem::size_of::<ProcessIdList>() as u32,
                std::ptr::null_mut(),
            )
        };
        if ok == 0 {
            return Vec::new();
        }
        let n = (list.number_of_process_ids_in_list as usize).min(64);
        list.process_id_list[..n].iter().map(|&p| p as u32).collect()
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
            if job.pids().len() >= 2 {
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
            if job.pids().is_empty() {
                emptied = true;
                break;
            }
            std::thread::sleep(Duration::from_millis(100));
        }

        let _ = child.wait();
        assert!(emptied, "terminating the job should kill every member process");
    }
}
