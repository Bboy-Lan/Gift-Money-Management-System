use sha2::{Digest, Sha256};
use std::io::{Read, Seek, SeekFrom, Write};
use std::path::{Path, PathBuf};

pub fn validate_identity(value: &str, version: &str) -> Result<(), String> {
    let info: serde_json::Value =
        serde_json::from_str(value).map_err(|_| "无法读取安装包产品元数据，已拒绝安装")?;
    let product = info.get("ProductName").and_then(|v| v.as_str());
    let actual = info.get("ProductVersion").and_then(|v| v.as_str());
    if product != Some("礼金簿")
        || !actual.is_some_and(|v| v == version || v == format!("{version}.0"))
    {
        return Err(
            "安装包产品或版本不匹配：仅支持礼金簿当前通道安装包；不能安装其他产品或缺少元数据的包"
                .to_string(),
        );
    }
    Ok(())
}
pub fn verified_copy(source: &Path, expected: &str, target: &Path) -> Result<(), String> {
    if expected.len() != 64 || !expected.bytes().all(|b| b.is_ascii_hexdigit()) {
        return Err("SHA-256 清单格式无效".into());
    }
    let mut options = std::fs::OpenOptions::new();
    options.read(true);
    #[cfg(windows)]
    {
        use std::os::windows::fs::OpenOptionsExt;
        options.share_mode(1); // FILE_SHARE_READ: deny modification/deletion while verifying and copying.
    }
    let mut input = options.open(source).map_err(|e| e.to_string())?;
    let mut hasher = Sha256::new();
    let mut buffer = [0_u8; 65536];
    loop {
        let size = input.read(&mut buffer).map_err(|e| e.to_string())?;
        if size == 0 {
            break;
        }
        hasher.update(&buffer[..size]);
    }
    if !format!("{:x}", hasher.finalize()).eq_ignore_ascii_case(expected) {
        return Err("安装包 SHA-256 校验失败，未执行安装".into());
    }
    input.seek(SeekFrom::Start(0)).map_err(|e| e.to_string())?;
    let mut output = std::fs::OpenOptions::new()
        .write(true)
        .create_new(true)
        .open(target)
        .map_err(|e| e.to_string())?;
    let result = std::io::copy(&mut input, &mut output)
        .map_err(|e| e.to_string())
        .and_then(|_| {
            output
                .flush()
                .and_then(|_| output.sync_all())
                .map_err(|e| e.to_string())
        });
    drop(output);
    if result.is_err() {
        let _ = std::fs::remove_file(target);
    }
    result.map(|_| ())
}

fn reject_link(path: &Path) -> Result<(), String> {
    let info = std::fs::symlink_metadata(path).map_err(|e| e.to_string())?;
    if info.file_type().is_symlink() {
        return Err("更新路径不能是符号链接".into());
    }
    #[cfg(windows)]
    {
        use std::os::windows::fs::MetadataExt;
        if info.file_attributes() & 0x400 != 0 {
            return Err("更新路径不能是重解析点".into());
        }
    }
    Ok(())
}

pub fn prepare_installer(
    directory: &Path,
    file_name: &str,
    current_version: &str,
    runtime: &Path,
) -> Result<(PathBuf, String), String> {
    let candidate =
        super::candidate_from_path(Path::new(file_name)).ok_or("无效改动版安装包名称")?;
    if Path::new(file_name).file_name().and_then(|v| v.to_str()) != Some(file_name)
        || !super::parse_release_version(&candidate.version)
            .zip(super::parse_release_version(current_version))
            .is_some_and(|(a, b)| a > b)
    {
        return Err("只允许安装目录中更高版本的改动版安装包".into());
    }
    reject_link(directory)?;
    let source = directory.join(file_name);
    reject_link(&source)?;
    let manifest = directory.join("SHA256SUMS.txt");
    reject_link(&manifest)?;
    let text = std::fs::read_to_string(manifest)
        .map_err(|e| format!("无法读取本地 SHA256SUMS.txt：{e}"))?;
    let matches = text
        .lines()
        .filter_map(|line| {
            let parts: Vec<_> = line.split_whitespace().collect();
            (parts.len() == 2 && parts[1].trim_start_matches('*') == file_name)
                .then(|| parts[0].to_string())
        })
        .collect::<Vec<_>>();
    if matches.len() != 1 {
        return Err("校验清单必须有唯一匹配安装包".into());
    }
    std::fs::create_dir_all(runtime).map_err(|e| e.to_string())?;
    reject_link(runtime)?;
    if let Some(parent) = runtime.parent() {
        reject_link(parent)?;
    }
    let staging = runtime.join(format!("prepared-{}", uuid::Uuid::new_v4()));
    std::fs::create_dir(&staging).map_err(|e| e.to_string())?;
    let prepared = staging.join(file_name);
    let result = verified_copy(&source, &matches[0], &prepared).and_then(|_| {
        // File remains write/delete protected while Windows reads its real PE version resource.
        let mut options = std::fs::OpenOptions::new(); options.read(true);
        #[cfg(windows)] {
            use std::os::windows::fs::OpenOptionsExt; options.share_mode(1);
        }
        let _protected = options.open(&prepared).map_err(|e| e.to_string())?;
        let literal = super::powershell_path_literal(&prepared);
        let script = format!("[Console]::OutputEncoding = [System.Text.UTF8Encoding]::new(); (Get-Item -LiteralPath {literal}).VersionInfo | Select-Object ProductName,ProductVersion | ConvertTo-Json -Compress");
        let output = super::hidden_windows_command("powershell.exe").args(["-NoProfile", "-NonInteractive", "-Command", &script]).output().map_err(|e| e.to_string())?;
        if !output.status.success() { return Err("无法读取安装包 PE 元数据，已拒绝安装".into()); }
        validate_identity(String::from_utf8_lossy(&output.stdout).trim(), &candidate.version)
    });
    if let Err(error) = result {
        let _ = std::fs::remove_file(&prepared);
        let _ = std::fs::remove_dir(&staging);
        return Err(error);
    }
    Ok((prepared, matches[0].clone()))
}

#[cfg(test)]
mod tests {
    use super::*;
    use sha2::{Digest, Sha256};
    #[test]
    fn package_identity_rejects_original_renamed_missing_and_wrong_version() {
        for value in [
            r#"{"ProductName":"礼金簿管理","ProductVersion":"0.4.28"}"#,
            r#"{"ProductName":"礼金簿—改动","ProductVersion":"0.4.27"}"#,
            r#"{"ProductName":"","ProductVersion":"0.4.28"}"#,
            "{}",
        ] {
            assert!(validate_identity(value, "0.4.28").is_err(), "{value}");
        }
        assert!(validate_identity(
            r#"{"ProductName":"礼金簿","ProductVersion":"0.4.28"}"#,
            "0.4.28"
        )
        .is_ok());
    }
    #[test]
    fn checked_copy_refuses_corruption_and_existing_target() {
        let root = std::path::PathBuf::from(env!("CARGO_MANIFEST_DIR"))
            .join("target")
            .join(format!("update-test-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&root).unwrap();
        let source = root.join("source.exe");
        let target = root.join("prepared.exe");
        std::fs::write(&source, b"prepared fixture").unwrap();
        assert!(verified_copy(&source, &"0".repeat(64), &target).is_err());
        assert!(!target.exists());
        let hash = format!("{:x}", Sha256::digest(b"prepared fixture"));
        verified_copy(&source, &hash, &target).unwrap();
        assert_eq!(std::fs::read(&target).unwrap(), b"prepared fixture");
        assert!(verified_copy(&source, &hash, &target).is_err());
        std::fs::remove_dir_all(root).unwrap();
    }
}
