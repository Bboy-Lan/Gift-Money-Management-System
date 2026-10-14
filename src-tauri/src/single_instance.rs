#[cfg(windows)]
mod windows {
    use std::ffi::c_void;
    #[link(name = "kernel32")]
    unsafe extern "system" {
        fn CreateMutexW(attributes: *const c_void, owner: i32, name: *const u16) -> *mut c_void;
        fn CloseHandle(handle: *mut c_void) -> i32;
        fn GetLastError() -> u32;
    }
    pub struct InstanceGuard(*mut c_void);
    impl InstanceGuard {
        pub fn acquire(name: &str) -> Result<Self, String> {
            let wide: Vec<u16> = name.encode_utf16().chain(Some(0)).collect();
            let handle = unsafe { CreateMutexW(std::ptr::null(), 0, wide.as_ptr()) };
            if handle.is_null() {
                return Err("无法获取隔离程序实例锁".to_string());
            }
            if unsafe { GetLastError() } == 183 {
                unsafe {
                    CloseHandle(handle);
                }
                return Err("礼金簿—改动已在本用户会话中运行，请使用现有窗口".to_string());
            }
            Ok(Self(handle))
        }
    }
    impl Drop for InstanceGuard {
        fn drop(&mut self) {
            unsafe {
                CloseHandle(self.0);
            }
        }
    }
}
#[cfg(windows)]
pub use windows::InstanceGuard;

#[cfg(test)]
mod tests {
    #[cfg(windows)]
    #[test]
    fn named_guard_rejects_second_instance_and_releases_without_stale_file() {
        use super::InstanceGuard;
        let name = format!("Global\\lijin-remediation-test-{}", uuid::Uuid::new_v4());
        let first = InstanceGuard::acquire(&name).unwrap();
        assert!(InstanceGuard::acquire(&name).is_err());
        drop(first);
        assert!(InstanceGuard::acquire(&name).is_ok());
    }
}
