use serde::{Deserialize, Serialize};
use serde_json::Value;
use sha2::{Digest, Sha256};
use std::io::{Read, Write};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Mutex;
use std::time::{Duration, Instant};
use tauri::{ipc::Channel, State};
use tauri_plugin_updater::{Update, UpdaterExt};

const PRODUCT: &str = "com.codex.lijinbook.remediation";
const TARGET: &str = "lijinbook-remediation-windows-x86_64";
const CACHE_TIME: Duration = Duration::from_secs(24 * 60 * 60);

#[derive(Clone, Default, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct Endpoint {
    download_url: Option<String>,
    manifest_url: Option<String>,
}

#[derive(Clone, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct ChannelConfig {
    product_id: String,
    channel: String,
    public_key: Option<String>,
    github: Endpoint,
    lanzou_url: Option<String>,
    lanzou_extraction_code: Option<String>,
    baidu_url: Option<String>,
    baidu_extraction_code: Option<String>,
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DownloadChannel {
    id: String,
    label: String,
    url: Option<String>,
    extraction_code: Option<String>,
}

impl ChannelConfig {
    #[cfg(test)]
    fn empty() -> Self {
        Self {
            product_id: PRODUCT.into(),
            channel: "stable".into(),
            public_key: None,
            github: Endpoint::default(),
            lanzou_url: None,
            lanzou_extraction_code: None,
            baidu_url: None,
            baidu_extraction_code: None,
        }
    }

    fn load() -> Result<Self, String> {
        let config: Self = serde_json::from_str(include_str!("../../update-channels.json"))
            .map_err(|_| "更新渠道配置无效")?;
        if config.product_id != PRODUCT || config.channel != "stable" {
            return Err("更新产品或通道配置不匹配".into());
        }
        for channel in config.channels() {
            if let Some(url) = channel.url {
                validate_https(&url)?;
            }
        }
        config.endpoints()?;
        Ok(config)
    }

    fn endpoints(&self) -> Result<Vec<(&'static str, reqwest::Url)>, String> {
        [("github", &self.github.manifest_url)]
            .into_iter()
            .filter_map(|(id, value)| value.as_ref().map(|value| (id, value)))
            .map(|(id, value)| validate_https(value).map(|url| (id, url)))
            .collect()
    }

    fn channels(&self) -> Vec<DownloadChannel> {
        vec![
            DownloadChannel {
                id: "github".into(),
                label: "GitHub 下载".into(),
                url: self.github.download_url.clone(),
                extraction_code: None,
            },
            DownloadChannel {
                id: "lanzou".into(),
                label: "蓝奏云".into(),
                url: self.lanzou_url.clone(),
                extraction_code: self.lanzou_extraction_code.clone(),
            },
            DownloadChannel {
                id: "baidu".into(),
                label: "百度网盘".into(),
                url: self.baidu_url.clone(),
                extraction_code: self.baidu_extraction_code.clone(),
            },
        ]
    }
}

fn validate_https(value: &str) -> Result<reqwest::Url, String> {
    let url = reqwest::Url::parse(value).map_err(|_| "下载地址格式无效")?;
    let host = url.host_str().ok_or("下载地址缺少域名")?;
    let local_ip = host.parse::<std::net::IpAddr>().is_ok_and(|ip| match ip {
        std::net::IpAddr::V4(ip) => {
            ip.is_private() || ip.is_loopback() || ip.is_unspecified() || ip.is_link_local()
        }
        std::net::IpAddr::V6(ip) => {
            ip.is_loopback()
                || ip.is_unspecified()
                || ip.is_unique_local()
                || ip.is_unicast_link_local()
        }
    });
    if url.scheme() != "https"
        || !url.username().is_empty()
        || url.password().is_some()
        || url.fragment().is_some()
        || value.chars().any(char::is_whitespace)
        || host.eq_ignore_ascii_case("localhost")
        || local_ip
    {
        return Err("下载地址必须为不含账号信息的公网 HTTPS 地址".into());
    }
    Ok(url)
}

fn validate_manifest(raw: &Value, version: &str) -> Result<(), String> {
    if raw.get("productId").and_then(Value::as_str) != Some(PRODUCT)
        || raw.get("channel").and_then(Value::as_str) != Some("stable")
    {
        return Err("更新包不属于本软件的稳定版本".into());
    }
    if !super::parse_release_version(version)
        .zip(super::parse_release_version(super::APP_VERSION))
        .is_some_and(|(new, current)| new > current)
    {
        return Err("更新版本无效或不高于当前版本".into());
    }
    Ok(())
}

fn require_candidate(known: &str, requested: &str, prepared: bool) -> Result<(), String> {
    if known != requested {
        return Err("更新候选已变化，请重新检查更新".into());
    }
    if !prepared {
        return Err("请先完成下载和校验".into());
    }
    Ok(())
}

fn outcome_message(target: &str, current: &str) -> String {
    if target == current {
        format!("已更新到 v{current}")
    } else {
        format!("上次更新到 v{target} 未完成，当前仍为 v{current}，可重新检查更新")
    }
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SoftwareCandidate {
    pub id: String,
    pub version: String,
    pub source: String,
    pub release_notes: Option<String>,
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SoftwareUpdateStatus {
    current_version: String,
    configured: bool,
    installed: bool,
    checked_at: Option<String>,
    candidate: Option<SoftwareCandidate>,
    channels: Vec<DownloadChannel>,
    error: Option<String>,
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct UpdateProgress {
    phase: String,
    received: u64,
    total: Option<u64>,
}

#[derive(Clone)]
enum Payload {
    Online(Box<Update>),
    Local { name: String, hash: String },
}
#[derive(Clone)]
struct Prepared {
    path: PathBuf,
    hash: String,
}
#[derive(Clone)]
struct Candidate {
    info: SoftwareCandidate,
    payload: Payload,
    prepared: Option<Prepared>,
}

#[derive(Default)]
struct Session {
    status: Option<SoftwareUpdateStatus>,
    candidate: Option<Candidate>,
    checked: Option<Instant>,
}

#[derive(Default)]
pub struct SoftwareUpdates {
    session: Mutex<Session>,
    busy: AtomicBool,
}

struct TaskGuard<'a>(&'a AtomicBool);
impl Drop for TaskGuard<'_> {
    fn drop(&mut self) {
        self.0.store(false, Ordering::Release);
    }
}
impl SoftwareUpdates {
    fn start(&self) -> Result<TaskGuard<'_>, String> {
        self.busy
            .compare_exchange(false, true, Ordering::AcqRel, Ordering::Acquire)
            .map_err(|_| "更新任务正在进行，请稍候")?;
        Ok(TaskGuard(&self.busy))
    }
    fn selected(&self, id: &str, ready: bool) -> Result<Candidate, String> {
        let session = self.session.lock().map_err(|_| "更新状态不可用")?;
        let candidate = session.candidate.clone().ok_or("请先检查更新")?;
        require_candidate(
            &candidate.info.id,
            id,
            !ready || candidate.prepared.is_some(),
        )?;
        Ok(candidate)
    }
}

fn installed() -> bool {
    std::env::current_exe()
        .ok()
        .and_then(|exe| exe.parent().map(|p| p.join("uninstall.exe")))
        .is_some_and(|path| path.is_file())
}

// Strictly owned staging folders only; never recursively delete or follow links.
fn is_link(metadata: &std::fs::Metadata) -> bool {
    #[cfg(windows)]
    {
        use std::os::windows::fs::MetadataExt;
        if metadata.file_attributes() & 0x400 != 0 {
            return true;
        }
    }
    metadata.file_type().is_symlink()
}

fn cleanup_packages(runtime: &Path) -> Result<(), String> {
    let metadata = match std::fs::symlink_metadata(runtime) {
        Ok(value) => value,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(()),
        Err(error) => return Err(error.to_string()),
    };
    if is_link(&metadata) || !metadata.is_dir() {
        return Err("更新缓存目录不能为链接".into());
    }
    for entry in std::fs::read_dir(runtime).map_err(|e| e.to_string())? {
        let entry = entry.map_err(|e| e.to_string())?;
        let name = entry.file_name();
        let name = name.to_string_lossy();
        let suffix = name
            .strip_prefix("download-")
            .or_else(|| name.strip_prefix("prepared-"));
        if !suffix.is_some_and(|id| uuid::Uuid::parse_str(id).is_ok()) {
            continue;
        }
        let meta = std::fs::symlink_metadata(entry.path()).map_err(|e| e.to_string())?;
        if is_link(&meta) || !meta.is_dir() {
            continue;
        }
        let children = std::fs::read_dir(entry.path())
            .map_err(|e| e.to_string())?
            .collect::<Result<Vec<_>, _>>()
            .map_err(|e| e.to_string())?;
        if children.iter().any(|child| {
            let Ok(meta) = std::fs::symlink_metadata(child.path()) else {
                return true;
            };
            let name = child.file_name();
            let name = name.to_string_lossy();
            let version = name
                .strip_prefix("礼金簿_")
                .and_then(|v| v.strip_suffix("_x64-setup.exe"));
            !meta.is_file()
                || is_link(&meta)
                || version.and_then(super::parse_release_version).is_none()
        }) {
            continue;
        }
        for child in children {
            std::fs::remove_file(child.path()).map_err(|e| e.to_string())?;
        }
        std::fs::remove_dir(entry.path()).map_err(|e| e.to_string())?;
    }
    Ok(())
}

#[tauri::command]
pub fn software_update_options() -> Result<SoftwareUpdateStatus, String> {
    let config = ChannelConfig::load()?;
    Ok(SoftwareUpdateStatus {
        current_version: super::APP_VERSION.into(),
        configured: !config.endpoints()?.is_empty()
            && config
                .public_key
                .as_ref()
                .is_some_and(|key| !key.trim().is_empty()),
        installed: installed(),
        checked_at: None,
        candidate: None,
        channels: config.channels(),
        error: None,
    })
}

fn local_manifest_hash(directory: &Path, file_name: &str) -> Result<String, String> {
    let text = std::fs::read_to_string(directory.join("SHA256SUMS.txt"))
        .map_err(|_| "本地安装包缺少校验清单")?;
    let matches: Vec<_> = text
        .lines()
        .filter_map(|line| {
            let parts: Vec<_> = line.split_whitespace().collect();
            (parts.len() == 2 && parts[1].trim_start_matches('*') == file_name)
                .then(|| parts[0].to_string())
        })
        .collect();
    if matches.len() != 1
        || matches[0].len() != 64
        || !matches[0].bytes().all(|b| b.is_ascii_hexdigit())
    {
        return Err("本地安装包校验清单无效".into());
    }
    Ok(matches[0].clone())
}

#[tauri::command]
pub async fn software_update_status(
    app: tauri::AppHandle,
    state: State<'_, SoftwareUpdates>,
    force: bool,
) -> Result<SoftwareUpdateStatus, String> {
    let _task = state.start()?;
    if !force {
        let session = state.session.lock().map_err(|_| "更新状态不可用")?;
        if session.checked.is_some_and(|at| at.elapsed() < CACHE_TIME) {
            if let Some(status) = &session.status {
                return Ok(status.clone());
            }
        }
    }
    let config = ChannelConfig::load()?;
    let endpoints = config.endpoints()?;
    let configured = !endpoints.is_empty()
        && config
            .public_key
            .as_ref()
            .is_some_and(|k| !k.trim().is_empty());
    let mut candidate = None;
    let mut errors = Vec::new();
    let mut remote_errors = Vec::new();
    // Local files are never allowed to turn an original-product package into a variant update.
    match super::local_update_candidate(&app) {
        Ok(Some((local, _))) => {
            match local_manifest_hash(&super::published_update_directory(&app), &local.file_name) {
                Ok(hash) => {
                    candidate = Some(Candidate {
                        info: SoftwareCandidate {
                            id: uuid::Uuid::new_v4().to_string(),
                            version: local.version,
                            source: "local".into(),
                            release_notes: local.release_notes,
                        },
                        payload: Payload::Local {
                            name: local.file_name,
                            hash,
                        },
                        prepared: None,
                    });
                }
                Err(error) => errors.push(error),
            }
        }
        Err(error) => errors.push(error),
        Ok(None) => {}
    }
    if configured {
        for (source, endpoint) in endpoints {
            let check = async {
                let builder = app
                    .updater_builder()
                    .pubkey(config.public_key.as_deref().unwrap_or_default())
                    .target(TARGET)
                    .installer_arg(format!(
                        "/D={}",
                        std::env::current_exe()
                            .map_err(|e| e.to_string())?
                            .parent()
                            .ok_or("安装路径无效")?
                            .display()
                    ))
                    .timeout(Duration::from_secs(12))
                    .endpoints(vec![endpoint])
                    .map_err(|e| e.to_string())?
                    .configure_client(|builder| {
                        builder.redirect(reqwest::redirect::Policy::custom(|attempt| {
                            if attempt.previous().len() > 5 || attempt.url().scheme() != "https" {
                                attempt.error("更新服务重定向不安全")
                            } else {
                                attempt.follow()
                            }
                        }))
                    });
                let update = builder
                    .build()
                    .map_err(|e| e.to_string())?
                    .check()
                    .await
                    .map_err(|e| e.to_string())?;
                if let Some(update) = &update {
                    validate_manifest(&update.raw_json, &update.version)?;
                    validate_https(update.download_url.as_str())?;
                }
                Ok::<_, String>(update)
            }
            .await;
            match check {
                Ok(remote) => {
                    remote_errors.clear();
                    if let Some(update) = remote {
                        let replace = candidate.as_ref().is_none_or(|c| {
                            super::parse_release_version(&update.version)
                                > super::parse_release_version(&c.info.version)
                        });
                        if replace {
                            candidate = Some(Candidate {
                                info: SoftwareCandidate {
                                    id: uuid::Uuid::new_v4().to_string(),
                                    version: update.version.clone(),
                                    source: source.into(),
                                    release_notes: update.body.clone(),
                                },
                                payload: Payload::Online(Box::new(update)),
                                prepared: None,
                            });
                        }
                    }
                    // A valid result (including up-to-date) is authoritative; no false fallback.
                    break;
                }
                Err(error) => remote_errors.push(format!("GitHub检查失败：{error}")),
            }
        }
    }
    errors.extend(remote_errors);
    let has_error = !errors.is_empty();
    let status = SoftwareUpdateStatus {
        current_version: super::APP_VERSION.into(),
        configured,
        installed: installed(),
        checked_at: Some(chrono::Utc::now().to_rfc3339()),
        candidate: candidate.as_ref().map(|c| c.info.clone()),
        channels: config.channels(),
        error: if has_error {
            Some(errors.join("；"))
        } else {
            None
        },
    };
    let mut session = state.session.lock().map_err(|_| "更新状态不可用")?;
    session.checked = if !has_error {
        Some(Instant::now())
    } else {
        None
    };
    // A fresh candidate invalidates the old download; clean only our staging files.
    if let Err(error) = cleanup_packages(&super::update_runtime_directory()) {
        eprintln!("更新缓存清理未完成：{error}");
    }
    session.candidate = candidate;
    session.status = Some(status.clone());
    Ok(status)
}

fn verify_product(path: &Path, version: &str) -> Result<(), String> {
    let literal = super::powershell_path_literal(path);
    let script = format!("[Console]::OutputEncoding = [System.Text.UTF8Encoding]::new(); (Get-Item -LiteralPath {literal}).VersionInfo | Select-Object ProductName,ProductVersion | ConvertTo-Json -Compress");
    let output = super::hidden_windows_command("powershell.exe")
        .args(["-NoProfile", "-NonInteractive", "-Command", &script])
        .output()
        .map_err(|e| e.to_string())?;
    if !output.status.success() {
        return Err("无法确认安装包产品信息".into());
    }
    super::update_security::validate_identity(
        String::from_utf8_lossy(&output.stdout).trim(),
        version,
    )
}

#[tauri::command]
pub async fn prepare_software_update(
    app: tauri::AppHandle,
    state: State<'_, SoftwareUpdates>,
    candidate_id: String,
    progress: Channel<UpdateProgress>,
) -> Result<(), String> {
    let _task = state.start()?;
    let candidate = state.selected(&candidate_id, false)?;
    if candidate.prepared.is_some() {
        return Ok(());
    }
    if !installed() {
        return Err("当前为便携运行，请先通过下方下载方式安装礼金簿".into());
    }
    let prepared = match &candidate.payload {
        Payload::Local { name, hash } => {
            let directory = super::published_update_directory(&app);
            let (path, actual_hash) = super::update_security::prepare_installer(
                &directory,
                name,
                super::APP_VERSION,
                &super::update_runtime_directory(),
            )?;
            if !actual_hash.eq_ignore_ascii_case(hash) {
                return Err("本地候选已变化，请重新检查更新".into());
            }
            Prepared {
                path,
                hash: actual_hash,
            }
        }
        Payload::Online(update) => {
            let mut update = update.clone();
            update.timeout = Some(Duration::from_secs(600));
            let mut received = 0_u64;
            let bytes = update
                .download(
                    |length, total| {
                        received += length as u64;
                        let _ = progress.send(UpdateProgress {
                            phase: "downloading".into(),
                            received,
                            total,
                        });
                    },
                    || {},
                )
                .await
                .map_err(|e| format!("下载或签名校验失败：{e}"))?;
            let _ = progress.send(UpdateProgress {
                phase: "verifying".into(),
                received,
                total: Some(received),
            });
            let directory = super::update_runtime_directory()
                .join(format!("download-{}", uuid::Uuid::new_v4()));
            std::fs::create_dir_all(&directory).map_err(|e| e.to_string())?;
            let path = directory.join(format!("礼金簿_{}_x64-setup.exe", candidate.info.version));
            let mut file = std::fs::OpenOptions::new()
                .create_new(true)
                .write(true)
                .open(&path)
                .map_err(|e| e.to_string())?;
            file.write_all(&bytes)
                .and_then(|_| file.sync_all())
                .map_err(|e| e.to_string())?;
            drop(file);
            let guard = protected_file(&path)?;
            if let Err(error) = verify_product(&path, &candidate.info.version) {
                drop(guard);
                let _ = std::fs::remove_file(&path);
                let _ = std::fs::remove_dir(&directory);
                return Err(error);
            }
            Prepared {
                path,
                hash: format!("{:x}", Sha256::digest(&bytes)),
            }
        }
    };
    let mut session = state.session.lock().map_err(|_| "更新状态不可用")?;
    let selected = session.candidate.as_mut().ok_or("候选已失效")?;
    require_candidate(&selected.info.id, &candidate_id, true)?;
    selected.prepared = Some(prepared);
    Ok(())
}

fn protected_file(path: &Path) -> Result<std::fs::File, String> {
    let mut options = std::fs::OpenOptions::new();
    options.read(true);
    #[cfg(windows)]
    {
        use std::os::windows::fs::OpenOptionsExt;
        options.share_mode(1);
    }
    options.open(path).map_err(|e| e.to_string())
}

#[derive(Serialize, Deserialize)]
struct PendingUpdate {
    target: String,
    acknowledged: bool,
}

fn pending_path() -> PathBuf {
    super::update_runtime_directory().join("pending-update.json")
}

fn record_pending(target: &str) -> Result<(), String> {
    let path = pending_path();
    std::fs::create_dir_all(path.parent().ok_or("更新目录无效")?).map_err(|e| e.to_string())?;
    std::fs::write(
        path,
        serde_json::to_vec(&PendingUpdate {
            target: target.into(),
            acknowledged: false,
        })
        .map_err(|e| e.to_string())?,
    )
    .map_err(|e| e.to_string())
}

#[tauri::command(async)]
pub fn apply_software_update(
    app: tauri::AppHandle,
    state: State<'_, SoftwareUpdates>,
    candidate_id: String,
) -> Result<(), String> {
    let _task = state.start()?;
    let _writes = super::begin_operation()?;
    let candidate = state.selected(&candidate_id, true)?;
    if !installed() {
        return Err("便携运行不支持原位置自动安装".into());
    }
    let prepared = candidate.prepared.as_ref().ok_or("安装包尚未准备完成")?;
    let mut file = protected_file(&prepared.path)?;
    let mut bytes = Vec::new();
    file.read_to_end(&mut bytes).map_err(|e| e.to_string())?;
    if format!("{:x}", Sha256::digest(&bytes)) != prepared.hash.to_ascii_lowercase() {
        return Err("已下载的安装包校验失败，请重新下载".into());
    }
    verify_product(&prepared.path, &candidate.info.version)?;
    record_pending(&candidate.info.version)?;
    match &candidate.payload {
        Payload::Online(update) => {
            let exe = std::env::current_exe().map_err(|e| e.to_string())?;
            let parent = exe.parent().ok_or("无法确认安装位置")?;
            // NSIS /D must be the final argument; it preserves a custom installation location.
            update
                .clone()
                .restart_after_install(true)
                .install(&bytes)
                .map_err(|e| format!("安装未启动（安装目录{}）：{e}", parent.display()))?;
        }
        Payload::Local { .. } => {
            let exe = std::env::current_exe().map_err(|e| e.to_string())?;
            super::launch_local_update(&prepared.path, &exe, &exe, &prepared.hash)?;
            app.exit(0);
        }
    }
    Ok(())
}

#[tauri::command]
pub fn acknowledge_software_update() -> Result<Option<String>, String> {
    let path = pending_path();
    if !path.exists() {
        return Ok(None);
    }
    let mut pending: PendingUpdate =
        serde_json::from_slice(&std::fs::read(&path).map_err(|e| e.to_string())?)
            .map_err(|_| "上次更新结果记录无法读取")?;
    if pending.acknowledged {
        return Ok(None);
    }
    let message = outcome_message(&pending.target, super::APP_VERSION);
    pending.acknowledged = true;
    std::fs::write(
        path,
        serde_json::to_vec(&pending).map_err(|e| e.to_string())?,
    )
    .map_err(|e| e.to_string())?;
    Ok(Some(message))
}

#[cfg(windows)]
fn download_channel_command(url: &str) -> std::process::Command {
    let mut command = super::hidden_windows_command("rundll32.exe");
    command.arg("url.dll,FileProtocolHandler").arg(url);
    command
}

#[tauri::command]
pub fn open_download_channel(channel_id: String) -> Result<(), String> {
    let config = ChannelConfig::load()?;
    let url = config
        .channels()
        .into_iter()
        .find(|item| item.id == channel_id)
        .and_then(|item| item.url)
        .ok_or("该下载方式尚未配置")?;
    validate_https(&url)?;
    #[cfg(windows)]
    {
        download_channel_command(&url)
            .spawn()
            .map_err(|e| format!("无法打开下载页面：{e}"))?;
        Ok(())
    }
    #[cfg(not(windows))]
    {
        Err("仅支持 Windows".into())
    }
}

#[cfg(test)]
mod tests {
    use serde_json::json;

    #[test]
    fn links_require_https_and_no_credentials_or_local_paths() {
        for value in [
            "http://example.test/app.exe",
            "file:///C:/test.exe",
            "https://user:pass@example.test/a",
            "https://localhost/a",
            "https://127.0.0.1/a",
            "https://example.test/a\n",
        ] {
            assert!(super::validate_https(value).is_err(), "{value}");
        }
        assert!(super::validate_https("https://downloads.example.test/app.exe").is_ok());
    }

    #[cfg(windows)]
    #[test]
    fn download_channels_use_the_default_browser_protocol_handler() {
        use std::ffi::OsStr;

        let command = super::download_channel_command("https://pan.baidu.com/s/example");
        assert_eq!(command.get_program(), OsStr::new("rundll32.exe"));
        assert_eq!(
            command.get_args().collect::<Vec<_>>(),
            [
                OsStr::new("url.dll,FileProtocolHandler"),
                OsStr::new("https://pan.baidu.com/s/example")
            ]
        );
    }

    #[test]
    fn manifests_require_variant_identity_stable_and_newer_three_part_version() {
        let valid = json!({"productId":"com.codex.lijinbook.remediation", "channel":"stable"});
        assert!(super::validate_manifest(&valid, "0.4.34").is_ok());
        for version in [
            "0.4.27",
            "0.4.28",
            "0.4.29",
            "0.4.30",
            "0.4.31",
            "0.4.32",
            "0.4",
            "0.4.32-beta.1",
        ] {
            assert!(
                super::validate_manifest(&valid, version).is_err(),
                "{version}"
            );
        }
        assert!(super::validate_manifest(
            &json!({"productId":"original", "channel":"stable"}),
            "0.4.30"
        )
        .is_err());
        assert!(super::validate_manifest(
            &json!({"productId":"com.codex.lijinbook.remediation", "channel":"beta"}),
            "0.4.30"
        )
        .is_err());
    }

    #[test]
    fn unconfigured_channels_do_not_advertise_online_installation() {
        let config = super::ChannelConfig::empty();
        assert!(config.endpoints().unwrap().is_empty());
        assert_eq!(config.channels().len(), 3);
        assert!(config
            .channels()
            .iter()
            .all(|channel| channel.url.is_none()));
    }

    #[test]
    fn configured_downloads_expose_only_approved_channels_and_public_codes() {
        let config = super::ChannelConfig::load().unwrap();
        let endpoints = config.endpoints().unwrap();
        assert_eq!(endpoints.len(), 1);
        assert_eq!(endpoints[0].0, "github");
        assert_eq!(endpoints[0].1.as_str(), "https://github.com/Bboy-Lan/Gift-Money-Management-System/releases/latest/download/latest.json");
        let channels = serde_json::to_value(config.channels()).unwrap();
        assert_eq!(channels.as_array().unwrap().len(), 3);
        assert_eq!(channels[0]["id"], "github");
        assert_eq!(
            channels[0]["url"],
            "https://github.com/Bboy-Lan/Gift-Money-Management-System/releases"
        );
        assert_eq!(channels[1]["id"], "lanzou");
        assert_eq!(channels[1]["url"], "https://wwaxt.lanzouu.com/ifcV14c5cnre");
        assert_eq!(channels[1]["extractionCode"], "Niko");
        assert_eq!(channels[2]["id"], "baidu");
        assert_eq!(
            channels[2]["url"],
            "https://pan.baidu.com/s/1aTT_M2aBvope8K-fhYB0Tg?pwd=Niko"
        );
        assert_eq!(channels[2]["extractionCode"], "Niko");
        for id in ["cloud", "unknown", "https://evil.test"] {
            assert!(!config.channels().iter().any(|channel| channel.id == id));
        }
    }

    #[test]
    fn candidate_mismatch_or_unprepared_install_is_rejected() {
        assert!(super::require_candidate("known", "other", true).is_err());
        assert!(super::require_candidate("known", "known", false).is_err());
        assert!(super::require_candidate("known", "known", true).is_ok());
    }

    #[test]
    fn only_the_actual_running_target_version_acknowledges_success() {
        assert!(super::outcome_message("0.4.29", "0.4.28").contains("未完成"));
        assert!(super::outcome_message("0.4.29", "0.4.29").contains("已更新"));
    }

    #[test]
    fn cleanup_only_removes_owned_packages_and_preserves_unknown_files() {
        let root = std::path::PathBuf::from(env!("CARGO_MANIFEST_DIR"))
            .join("target")
            .join(format!("update-cache-test-{}", uuid::Uuid::new_v4()));
        let owned = root.join(format!("download-{}", uuid::Uuid::new_v4()));
        let unknown = root.join(format!("prepared-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&owned).unwrap();
        std::fs::create_dir_all(&unknown).unwrap();
        std::fs::write(owned.join("礼金簿_0.4.29_x64-setup.exe"), b"package").unwrap();
        std::fs::write(unknown.join("important.txt"), b"keep").unwrap();
        std::fs::write(root.join("pending-update.json"), b"keep").unwrap();
        super::cleanup_packages(&root).unwrap();
        assert!(!owned.exists());
        assert!(unknown.join("important.txt").exists());
        assert!(root.join("pending-update.json").exists());
        std::fs::remove_dir_all(root).unwrap();
    }

    #[cfg(windows)]
    #[test]
    fn cleanup_never_follows_windows_junctions() {
        let root = std::path::PathBuf::from(env!("CARGO_MANIFEST_DIR"))
            .join("target")
            .join(format!("update-junction-test-{}", uuid::Uuid::new_v4()));
        let outside = root.join("preserved");
        let runtime = root.join("runtime");
        std::fs::create_dir_all(&outside).unwrap();
        std::fs::create_dir_all(&runtime).unwrap();
        let package = outside.join("礼金簿_0.4.29_x64-setup.exe");
        std::fs::write(&package, b"keep").unwrap();
        let junction = runtime.join(format!("download-{}", uuid::Uuid::new_v4()));
        let output = crate::hidden_windows_command("cmd.exe")
            .args(["/d", "/c", "mklink", "/J"])
            .arg(&junction)
            .arg(&outside)
            .output()
            .unwrap();
        assert!(output.status.success(), "create fixture junction");
        let result = super::cleanup_packages(&runtime);
        let kept = package.exists();
        std::fs::remove_dir(&junction).unwrap();
        std::fs::remove_dir_all(&root).unwrap();
        result.unwrap();
        assert!(kept, "cache cleanup must not traverse a junction");
    }
}
