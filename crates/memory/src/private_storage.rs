use read_tools::ToolError;
use std::path::Path;

pub const READER_PRIVATE_STORAGE_UNAVAILABLE: &str = "READER_PRIVATE_STORAGE_UNAVAILABLE";

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ReaderPrivateStorageDiagnostic {
    pub error_code: String,
    pub message: String,
    pub occurred_at: String,
}

impl ReaderPrivateStorageDiagnostic {
    pub(crate) fn tool_error(&self) -> ToolError {
        ToolError {
            error_code: self.error_code.clone(),
            category: "permission".into(),
            message: self.message.clone(),
        }
    }
}

pub struct ReaderPrivateStorageGate;

impl ReaderPrivateStorageGate {
    pub fn enforce(memory_path: &Path) -> Result<(), ToolError> {
        let directory = memory_path
            .parent()
            .filter(|parent| !parent.as_os_str().is_empty())
            .ok_or_else(|| {
                private_storage_error("reader-private storage has no parent directory")
            })?;
        std::fs::create_dir_all(directory).map_err(|error| {
            private_storage_error(format!(
                "reader-private storage directory cannot be created: {error}"
            ))
        })?;
        platform::secure_tree(directory).map_err(|error| {
            private_storage_error(format!(
                "reader-private storage permissions cannot be enforced or verified: {error}"
            ))
        })
    }
}

pub(crate) fn secure_private_file(path: &Path) -> Result<(), ToolError> {
    platform::secure_file(path).map_err(|error| {
        private_storage_error(format!(
            "reader-private file permissions cannot be enforced or verified: {error}"
        ))
    })
}

fn private_storage_error(message: impl Into<String>) -> ToolError {
    ToolError {
        error_code: READER_PRIVATE_STORAGE_UNAVAILABLE.into(),
        category: "permission".into(),
        message: message.into(),
    }
}

#[cfg(unix)]
mod platform {
    use std::fs::Permissions;
    use std::os::unix::fs::{MetadataExt, PermissionsExt};
    use std::path::Path;

    pub(super) fn secure_tree(path: &Path) -> Result<(), String> {
        verify_root_directory(path)?;
        secure_path(path, true)?;
        for entry in std::fs::read_dir(path).map_err(|error| error.to_string())? {
            let entry = entry.map_err(|error| error.to_string())?;
            let child = entry.path();
            let metadata = std::fs::symlink_metadata(&child).map_err(|error| error.to_string())?;
            if metadata.file_type().is_symlink() {
                return Err("symbolic links are not allowed in reader-private storage".into());
            }
            if metadata.is_dir() {
                secure_tree(&child)?;
            } else if metadata.is_file() {
                secure_path(&child, false)?;
            } else {
                return Err("unsupported entry in reader-private storage".into());
            }
        }
        Ok(())
    }

    fn verify_root_directory(path: &Path) -> Result<(), String> {
        let metadata = std::fs::symlink_metadata(path).map_err(|error| error.to_string())?;
        if metadata.file_type().is_symlink() || !metadata.is_dir() {
            return Err("reader-private storage root must be a real directory".into());
        }
        Ok(())
    }

    pub(super) fn secure_file(path: &Path) -> Result<(), String> {
        secure_path(path, false)
    }

    fn secure_path(path: &Path, directory: bool) -> Result<(), String> {
        let mode = if directory { 0o700 } else { 0o600 };
        std::fs::set_permissions(path, Permissions::from_mode(mode))
            .map_err(|error| error.to_string())?;
        let actual = std::fs::symlink_metadata(path).map_err(|error| error.to_string())?;
        if actual.file_type().is_symlink()
            || actual.mode() & 0o777 != mode
            || (directory && !actual.is_dir())
            || (!directory && !actual.is_file())
        {
            return Err("reader-private POSIX mode verification failed".into());
        }
        Ok(())
    }
}

#[cfg(windows)]
mod platform {
    use std::ffi::c_void;
    use std::os::windows::ffi::OsStrExt;
    use std::path::Path;
    use std::ptr::{null, null_mut};
    use windows_sys::Win32::Foundation::{CloseHandle, LocalFree, GENERIC_ALL, HANDLE};
    use windows_sys::Win32::Security::Authorization::{
        GetExplicitEntriesFromAclW, GetNamedSecurityInfoW, SetEntriesInAclW, SetNamedSecurityInfoW,
        EXPLICIT_ACCESS_W, GRANT_ACCESS, NO_MULTIPLE_TRUSTEE, SET_ACCESS, SE_FILE_OBJECT,
        TRUSTEE_IS_SID, TRUSTEE_IS_USER, TRUSTEE_W,
    };
    use windows_sys::Win32::Security::{
        EqualSid, GetSecurityDescriptorControl, GetTokenInformation, IsValidSid, TokenUser, ACL,
        CONTAINER_INHERIT_ACE, DACL_SECURITY_INFORMATION, INHERIT_ONLY_ACE, OBJECT_INHERIT_ACE,
        PROTECTED_DACL_SECURITY_INFORMATION, PSID, SE_DACL_PROTECTED, TOKEN_QUERY, TOKEN_USER,
    };
    use windows_sys::Win32::Storage::FileSystem::FILE_ALL_ACCESS;
    use windows_sys::Win32::System::Threading::{GetCurrentProcess, OpenProcessToken};

    struct HandleGuard(HANDLE);

    impl Drop for HandleGuard {
        fn drop(&mut self) {
            unsafe {
                CloseHandle(self.0);
            }
        }
    }

    struct LocalGuard(*mut c_void);

    impl Drop for LocalGuard {
        fn drop(&mut self) {
            if !self.0.is_null() {
                unsafe {
                    LocalFree(self.0);
                }
            }
        }
    }

    pub(super) fn secure_tree(path: &Path) -> Result<(), String> {
        verify_root_directory(path)?;
        let (sid_buffer, _token) = current_user_sid()?;
        let sid = token_user_sid(&sid_buffer)?;
        secure_path(path, sid, true)?;
        for entry in std::fs::read_dir(path).map_err(|error| error.to_string())? {
            let entry = entry.map_err(|error| error.to_string())?;
            let child = entry.path();
            let metadata = std::fs::symlink_metadata(&child).map_err(|error| error.to_string())?;
            if metadata.file_type().is_symlink() {
                return Err("symbolic links are not allowed in reader-private storage".into());
            }
            if metadata.is_dir() {
                secure_tree(&child)?;
            } else if metadata.is_file() {
                secure_path(&child, sid, false)?;
            } else {
                return Err("unsupported entry in reader-private storage".into());
            }
        }
        Ok(())
    }

    fn verify_root_directory(path: &Path) -> Result<(), String> {
        let metadata = std::fs::symlink_metadata(path).map_err(|error| error.to_string())?;
        if metadata.file_type().is_symlink() || !metadata.is_dir() {
            return Err("reader-private storage root must be a real directory".into());
        }
        Ok(())
    }

    pub(super) fn secure_file(path: &Path) -> Result<(), String> {
        let (sid_buffer, _token) = current_user_sid()?;
        secure_path(path, token_user_sid(&sid_buffer)?, false)
    }

    fn current_user_sid() -> Result<(Vec<usize>, HandleGuard), String> {
        let mut token = null_mut();
        if unsafe { OpenProcessToken(GetCurrentProcess(), TOKEN_QUERY, &mut token) } == 0 {
            return Err(std::io::Error::last_os_error().to_string());
        }
        let token = HandleGuard(token);
        let mut required = 0_u32;
        unsafe {
            GetTokenInformation(token.0, TokenUser, null_mut(), 0, &mut required);
        }
        if required == 0 {
            return Err(std::io::Error::last_os_error().to_string());
        }
        let word = std::mem::size_of::<usize>();
        let mut buffer = vec![0_usize; (required as usize).div_ceil(word)];
        if unsafe {
            GetTokenInformation(
                token.0,
                TokenUser,
                buffer.as_mut_ptr().cast(),
                required,
                &mut required,
            )
        } == 0
        {
            return Err(std::io::Error::last_os_error().to_string());
        }
        token_user_sid(&buffer)?;
        Ok((buffer, token))
    }

    fn token_user_sid(buffer: &[usize]) -> Result<PSID, String> {
        let token_user = unsafe { &*buffer.as_ptr().cast::<TOKEN_USER>() };
        let sid = token_user.User.Sid;
        if sid.is_null() || unsafe { IsValidSid(sid) } == 0 {
            return Err("current Windows user SID is invalid".into());
        }
        Ok(sid)
    }

    fn secure_path(path: &Path, sid: PSID, directory: bool) -> Result<(), String> {
        let inheritance = if directory {
            CONTAINER_INHERIT_ACE | OBJECT_INHERIT_ACE
        } else {
            0
        };
        let access = EXPLICIT_ACCESS_W {
            grfAccessPermissions: GENERIC_ALL,
            grfAccessMode: SET_ACCESS,
            grfInheritance: inheritance,
            Trustee: TRUSTEE_W {
                pMultipleTrustee: null_mut(),
                MultipleTrusteeOperation: NO_MULTIPLE_TRUSTEE,
                TrusteeForm: TRUSTEE_IS_SID,
                TrusteeType: TRUSTEE_IS_USER,
                ptstrName: sid.cast(),
            },
        };
        let mut acl: *mut ACL = null_mut();
        let status = unsafe { SetEntriesInAclW(1, &access, null(), &mut acl) };
        if status != 0 {
            return Err(windows_error(status));
        }
        let acl_guard = LocalGuard(acl.cast());
        let mut wide = path
            .as_os_str()
            .encode_wide()
            .chain(std::iter::once(0))
            .collect::<Vec<_>>();
        let status = unsafe {
            SetNamedSecurityInfoW(
                wide.as_mut_ptr(),
                SE_FILE_OBJECT,
                DACL_SECURITY_INFORMATION | PROTECTED_DACL_SECURITY_INFORMATION,
                null_mut(),
                null_mut(),
                acl,
                null_mut(),
            )
        };
        drop(acl_guard);
        if status != 0 {
            return Err(windows_error(status));
        }
        verify_path_acl(&mut wide, sid, inheritance)
    }

    fn verify_path_acl(wide: &mut [u16], sid: PSID, inheritance: u32) -> Result<(), String> {
        let mut dacl: *mut ACL = null_mut();
        let mut descriptor = null_mut();
        let status = unsafe {
            GetNamedSecurityInfoW(
                wide.as_mut_ptr(),
                SE_FILE_OBJECT,
                DACL_SECURITY_INFORMATION,
                null_mut(),
                null_mut(),
                &mut dacl,
                null_mut(),
                &mut descriptor,
            )
        };
        if status != 0 {
            return Err(windows_error(status));
        }
        let descriptor_guard = LocalGuard(descriptor);
        if dacl.is_null() {
            return Err("reader-private Windows DACL is missing".into());
        }
        let mut control = 0_u16;
        let mut revision = 0_u32;
        if unsafe { GetSecurityDescriptorControl(descriptor, &mut control, &mut revision) } == 0 {
            return Err(std::io::Error::last_os_error().to_string());
        }
        let dacl_is_protected = control & SE_DACL_PROTECTED == SE_DACL_PROTECTED;
        let mut count = 0_u32;
        let mut entries: *mut EXPLICIT_ACCESS_W = null_mut();
        let status = unsafe { GetExplicitEntriesFromAclW(dacl, &mut count, &mut entries) };
        if status != 0 {
            return Err(windows_error(status));
        }
        let entries_guard = LocalGuard(entries.cast());
        let verified = dacl_is_protected
            && !entries.is_null()
            && count > 0
            && unsafe {
                let entries = std::slice::from_raw_parts(entries, count as usize);
                let all_current_user_full_control = entries.iter().all(|entry| {
                    matches!(entry.grfAccessMode, GRANT_ACCESS | SET_ACCESS)
                        && has_full_control(entry.grfAccessPermissions)
                        && entry.Trustee.TrusteeForm == TRUSTEE_IS_SID
                        && EqualSid(entry.Trustee.ptstrName.cast(), sid) != 0
                });
                let covers_current_path = entries
                    .iter()
                    .any(|entry| entry.grfInheritance & INHERIT_ONLY_ACE == 0);
                let covers_children = inheritance == 0
                    || entries
                        .iter()
                        .any(|entry| entry.grfInheritance & inheritance == inheritance);
                all_current_user_full_control && covers_current_path && covers_children
            };
        let diagnostic = if entries.is_null() {
            format!("dacl_protected={dacl_is_protected}, entry_count={count}, entries=null")
        } else {
            unsafe {
                let details = std::slice::from_raw_parts(entries, count as usize)
                    .iter()
                    .enumerate()
                    .map(|(index, entry)| {
                        let sid_matches = entry.Trustee.TrusteeForm == TRUSTEE_IS_SID
                            && EqualSid(entry.Trustee.ptstrName.cast(), sid) != 0;
                        format!(
                            "#{index}(mode={}, permissions=0x{:08x}, inheritance=0x{:08x}, trustee_form={}, sid_matches={sid_matches})",
                            entry.grfAccessMode,
                            entry.grfAccessPermissions,
                            entry.grfInheritance,
                            entry.Trustee.TrusteeForm,
                        )
                    })
                    .collect::<Vec<_>>()
                    .join(", ");
                format!(
                    "dacl_protected={dacl_is_protected}, entry_count={count}, entries=[{details}]"
                )
            }
        };
        drop(entries_guard);
        drop(descriptor_guard);
        if !verified {
            return Err(format!(
                "reader-private Windows DACL verification failed: {diagnostic}"
            ));
        }
        Ok(())
    }

    fn has_full_control(permissions: u32) -> bool {
        permissions & GENERIC_ALL == GENERIC_ALL || permissions & FILE_ALL_ACCESS == FILE_ALL_ACCESS
    }

    fn windows_error(status: u32) -> String {
        std::io::Error::from_raw_os_error(status as i32).to_string()
    }
}

#[cfg(not(any(unix, windows)))]
mod platform {
    use std::path::Path;

    pub(super) fn secure_tree(_path: &Path) -> Result<(), String> {
        Err("reader-private permissions are unsupported on this operating system".into())
    }

    pub(super) fn secure_file(_path: &Path) -> Result<(), String> {
        Err("reader-private permissions are unsupported on this operating system".into())
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::time::{SystemTime, UNIX_EPOCH};

    fn test_dir(name: &str) -> std::path::PathBuf {
        let nonce = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap()
            .as_nanos();
        std::env::temp_dir().join(format!(
            "ub-private-storage-{name}-{}-{nonce}",
            std::process::id()
        ))
    }

    #[test]
    fn gate_secures_and_verifies_existing_private_files() {
        let dir = test_dir("secure");
        std::fs::create_dir_all(&dir).unwrap();
        let memory = dir.join("memory.json");
        std::fs::write(&memory, "[]").unwrap();

        ReaderPrivateStorageGate::enforce(&memory).unwrap();
        secure_private_file(&memory).unwrap();

        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            assert_eq!(
                std::fs::metadata(&dir).unwrap().permissions().mode() & 0o777,
                0o700
            );
            assert_eq!(
                std::fs::metadata(&memory).unwrap().permissions().mode() & 0o777,
                0o600
            );
        }
        let _ = std::fs::remove_dir_all(dir);
    }

    #[test]
    fn gate_fails_closed_when_private_directory_is_a_file() {
        let blocker = test_dir("blocked");
        std::fs::write(&blocker, "not a directory").unwrap();
        let error = ReaderPrivateStorageGate::enforce(&blocker.join("memory.json")).unwrap_err();
        assert_eq!(error.error_code, READER_PRIVATE_STORAGE_UNAVAILABLE);
        let _ = std::fs::remove_file(blocker);
    }

    #[test]
    fn unavailable_store_exposes_diagnostic_and_never_writes() {
        let dir = test_dir("unavailable");
        let memory = dir.join("memory.json");
        let mut store = crate::MemoryStore::unavailable(
            &memory,
            private_storage_error("fixture permission failure"),
            "2026-07-14T00:00:00Z",
        );

        assert!(!store.private_storage_available());
        assert_eq!(
            store.private_storage_diagnostic().unwrap().error_code,
            READER_PRIVATE_STORAGE_UNAVAILABLE
        );
        assert_eq!(
            store
                .mark_read("book-a", "1.1", "now")
                .unwrap_err()
                .error_code,
            READER_PRIVATE_STORAGE_UNAVAILABLE
        );
        assert_eq!(
            store.write_profile_files().unwrap_err().error_code,
            READER_PRIVATE_STORAGE_UNAVAILABLE
        );
        assert!(!memory.exists());
        assert!(!dir.exists());
    }
}
