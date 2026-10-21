use calamine::{open_workbook_auto, Data, Reader};
use chrono::{DateTime, Local, NaiveDate, NaiveDateTime, Utc};
use reqwest::StatusCode;
use rfd::FileDialog;
use rusqlite::backup::Backup;
use rusqlite::{params, params_from_iter, Connection, OpenFlags, OptionalExtension, Transaction};
use rust_xlsxwriter::{ExcelDateTime, Format, Workbook};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::collections::{HashMap, HashSet};
use std::fs::OpenOptions;
use std::path::{Path, PathBuf};
use std::process::Command;
use std::sync::Mutex;
use std::time::{Duration, Instant};
use tauri::{Manager, State};
use uuid::Uuid;

mod app_security;
mod models;
mod single_instance;
mod software_updates;
mod update_security;

use app_security::{validate_pin, AppSecurityStore};
use models::*;

const CURRENT_SCHEMA: i32 = 9;

static WRITE_OPERATION: Mutex<()> = Mutex::new(());

fn begin_operation() -> Result<std::sync::MutexGuard<'static, ()>, String> {
    WRITE_OPERATION
        .lock()
        .map_err(|_| "写入调度不可用，请重新启动".to_string())
}

fn with_operation<T>(operation: impl FnOnce() -> Result<T, String>) -> Result<T, String> {
    // Includes permission, target capture, migration/snapshot, before-values and commit.
    let _operation = begin_operation()?;
    operation()
}
const LOGIN_COOLDOWN: Duration = Duration::from_secs(30);
const MAX_LOGIN_ATTEMPTS: u8 = 5;
const APP_VERSION: &str = env!("CARGO_PKG_VERSION");
const UPDATE_INSTALLER_PREFIX: &str = "礼金簿_";
const GITHUB_UPDATE_INSTALLER_PREFIX: &str = "Gift-Money-Management-System_";
const UPDATE_INSTALLER_SUFFIX: &str = "_x64-setup.exe";
const GITHUB_RELEASE_API: &str =
    "https://api.github.com/repos/Bboy-Lan/Gift-Money-Management-System/releases/latest";
const WINDOWS_THIS_PC_NAMESPACE: &str = "::{20D04FE0-3AEA-1069-A2D8-08002B30309D}";

fn default_file_dialog() -> FileDialog {
    #[cfg(windows)]
    {
        FileDialog::new().set_directory(WINDOWS_THIS_PC_NAMESPACE)
    }
    #[cfg(not(windows))]
    {
        FileDialog::new()
    }
}

const AUTO_TAG_COLORS: &[&str] = &[
    "#0f766e", "#2563eb", "#b45309", "#9f1239", "#7c3aed", "#047857", "#be123c", "#0369a1",
    "#c2410c", "#4d7c0f", "#a21caf", "#0e7490",
];

#[derive(Clone, Copy, Default, PartialEq, Eq)]
enum SessionRole {
    #[default]
    Viewer,
    Admin,
}

struct SessionState {
    role: SessionRole,
    failed_attempts: u8,
    locked_until: Option<Instant>,
    edit_locked: bool,
}

impl Default for SessionState {
    fn default() -> Self {
        Self {
            role: SessionRole::Viewer,
            failed_attempts: 0,
            locked_until: None,
            edit_locked: true,
        }
    }
}

pub struct AppState {
    vault_path: Mutex<Option<PathBuf>>,
    opened_vault_paths: Mutex<Vec<PathBuf>>,
    security: AppSecurityStore,
    session: Mutex<SessionState>,
}

#[derive(Debug, Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
struct AppSettings {
    data_directory: Option<String>,
}

#[derive(Debug, Deserialize)]
struct GithubRelease {
    tag_name: String,
    body: Option<String>,
    published_at: Option<String>,
    html_url: Option<String>,
}

fn now() -> String {
    Utc::now().to_rfc3339()
}

/// Windows may return an extended-length path from `canonicalize()`. It is
/// useful for filesystem APIs, but the `\\?\` marker is noise in user-facing
/// source metadata, so normalize it before storing or displaying the path.
fn displayable_path(path: &Path) -> String {
    let value = path.to_string_lossy();
    if let Some(rest) = value.strip_prefix("\\\\?\\UNC\\") {
        return format!("\\\\{rest}");
    }
    value
        .strip_prefix("\\\\?\\")
        .unwrap_or(value.as_ref())
        .to_string()
}

fn embedded_webview_runtime_directory(executable: &Path) -> Option<PathBuf> {
    let parent = executable.parent()?;
    [
        parent.join("webview2-fixed"),
        parent.join("resources").join("webview2-fixed"),
    ]
    .into_iter()
    .find(|directory| directory.join("msedgewebview2.exe").is_file())
}

fn selected_webview_runtime(executable: &Path, system_available: bool) -> Option<PathBuf> {
    if system_available {
        None
    } else {
        embedded_webview_runtime_directory(executable)
    }
}

#[cfg(windows)]
fn configure_embedded_webview_runtime() {
    std::env::remove_var("WEBVIEW2_BROWSER_EXECUTABLE_FOLDER");
    let system_available = tauri::webview_version().is_ok();
    let Ok(executable) = std::env::current_exe() else {
        return;
    };
    let Some(runtime) = selected_webview_runtime(&executable, system_available) else {
        return;
    };
    std::env::set_var("WEBVIEW2_BROWSER_EXECUTABLE_FOLDER", runtime);
}

#[cfg(not(windows))]
fn configure_embedded_webview_runtime() {}

fn update_runtime_directory() -> PathBuf {
    std::env::var_os("LOCALAPPDATA")
        .map(PathBuf::from)
        .unwrap_or_else(std::env::temp_dir)
        .join("礼金簿—改动")
        .join("update-runtime")
}

fn app_security_path() -> PathBuf {
    std::env::var_os("LOCALAPPDATA")
        .map(PathBuf::from)
        .unwrap_or_else(std::env::temp_dir)
        // The isolated variant must never reuse the original credential store.
        .join("礼金簿—改动")
        .join("admin-security.sqlite")
}

fn app_profile_directory() -> PathBuf {
    std::env::var_os("LOCALAPPDATA")
        .map(PathBuf::from)
        .unwrap_or_else(std::env::temp_dir)
        .join("礼金簿—改动")
}

fn app_settings_path(_app: &tauri::AppHandle) -> PathBuf {
    app_profile_directory().join("settings.json")
}

fn read_app_settings(app: &tauri::AppHandle) -> AppSettings {
    let path = app_settings_path(app);
    std::fs::read_to_string(path)
        .ok()
        .and_then(|value| serde_json::from_str(&value).ok())
        .unwrap_or_default()
}

fn write_app_settings(app: &tauri::AppHandle, settings: &AppSettings) -> Result<(), String> {
    let path = app_settings_path(app);
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent).map_err(|e| e.to_string())?;
    }
    let value = serde_json::to_string_pretty(settings).map_err(|e| e.to_string())?;
    std::fs::write(path, value).map_err(|e| e.to_string())
}

fn configured_data_directory(app: &tauri::AppHandle) -> Option<PathBuf> {
    let value = read_app_settings(app).data_directory?;
    let path = PathBuf::from(value);
    path.is_dir().then_some(path)
}

fn file_dialog_for_app(app: &tauri::AppHandle) -> FileDialog {
    configured_data_directory(app)
        .map(|directory| FileDialog::new().set_directory(directory))
        .unwrap_or_else(default_file_dialog)
}

fn spreadsheet_file_dialog(app: &tauri::AppHandle) -> FileDialog {
    desktop_directory(app)
        .map(|directory| FileDialog::new().set_directory(directory))
        .unwrap_or_else(|| file_dialog_for_app(app))
}

#[tauri::command]
fn license_text() -> String {
    include_str!("../../LICENSE").to_string()
}

fn published_update_directory(app: &tauri::AppHandle) -> PathBuf {
    desktop_directory(app)
        .unwrap_or_else(|| PathBuf::from(r"D:\Desktop"))
        .join("礼金簿—改动")
        .join("release")
}

fn ensure_published_update_directory(app: &tauri::AppHandle) -> Result<PathBuf, String> {
    let directory = published_update_directory(app);
    std::fs::create_dir_all(&directory).map_err(|e| e.to_string())?;
    Ok(directory)
}

fn comparison_cache_directory() -> PathBuf {
    std::env::var_os("LOCALAPPDATA")
        .map(PathBuf::from)
        .unwrap_or_else(std::env::temp_dir)
        .join("礼金簿—改动")
        .join("comparison-vaults")
}

fn hidden_windows_command(program: &str) -> Command {
    let mut command = Command::new(program);
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;

        command.creation_flags(0x0800_0000); // CREATE_NO_WINDOW
    }
    command
}

fn parse_release_version(value: &str) -> Option<[u32; 3]> {
    let parts = value.split('.').collect::<Vec<_>>();
    if parts.len() != 3
        || parts.iter().any(|part| {
            part.is_empty()
                || !part.bytes().all(|c| c.is_ascii_digit())
                || (part.len() > 1 && part.starts_with('0'))
        })
    {
        return None;
    }
    Some([
        parts[0].parse().ok()?,
        parts[1].parse().ok()?,
        parts[2].parse().ok()?,
    ])
}

fn candidate_from_path(path: &Path) -> Option<LocalUpdateCandidate> {
    let file_name = path.file_name()?.to_string_lossy();
    let version = file_name
        .strip_prefix(UPDATE_INSTALLER_PREFIX)?
        .strip_suffix(UPDATE_INSTALLER_SUFFIX)?;
    parse_release_version(version)?;
    Some(LocalUpdateCandidate {
        version: version.to_string(),
        file_name: file_name.to_string(),
        release_notes: None,
        published_at: None,
        release_url: None,
        download_url: None,
        checksum_url: None,
    })
}

#[cfg(test)]
fn latest_local_update(
    candidates: &[PathBuf],
    current_version: &str,
) -> Option<LocalUpdateCandidate> {
    let current = parse_release_version(current_version)?;
    candidates
        .iter()
        .filter_map(|path| candidate_from_path(path))
        .filter(|candidate| {
            parse_release_version(&candidate.version).is_some_and(|version| version > current)
        })
        .max_by_key(|candidate| parse_release_version(&candidate.version))
}

fn candidate_from_github_release(
    release: &GithubRelease,
) -> Result<Option<LocalUpdateCandidate>, String> {
    let version = release
        .tag_name
        .strip_prefix('v')
        .unwrap_or(&release.tag_name);
    if parse_release_version(version).is_none() {
        return Err(format!(
            "GitHub 最新发布版本号格式无效：{}",
            release.tag_name
        ));
    }
    let file_name = format!("{GITHUB_UPDATE_INSTALLER_PREFIX}{version}{UPDATE_INSTALLER_SUFFIX}");
    Ok(Some(LocalUpdateCandidate {
        version: version.to_string(),
        file_name,
        release_notes: release.body.clone(),
        published_at: release.published_at.clone(),
        release_url: release.html_url.clone(),
        download_url: None,
        checksum_url: None,
    }))
}

fn local_update_candidate(
    app: &tauri::AppHandle,
) -> Result<Option<(LocalUpdateCandidate, PathBuf)>, String> {
    let directory = ensure_published_update_directory(app)?;
    let paths = std::fs::read_dir(&directory)
        .map_err(|e| e.to_string())?
        .filter_map(Result::ok)
        .flat_map(|entry| match entry.file_type() {
            Ok(kind) if kind.is_file() => vec![entry.path()],
            Ok(kind) if kind.is_dir() => std::fs::read_dir(entry.path())
                .ok()
                .into_iter()
                .flatten()
                .filter_map(Result::ok)
                .filter_map(|child| {
                    child
                        .file_type()
                        .ok()
                        .filter(|kind| kind.is_file())
                        .map(|_| child.path())
                })
                .collect(),
            _ => Vec::new(),
        })
        .collect::<Vec<_>>();
    let mut selected = paths
        .into_iter()
        .filter_map(|path| candidate_from_path(&path).map(|candidate| (candidate, path)))
        .filter(|(candidate, _)| {
            parse_release_version(&candidate.version)
                .zip(parse_release_version(APP_VERSION))
                .is_some_and(|(version, current)| version > current)
        })
        .max_by_key(|(candidate, _)| parse_release_version(&candidate.version));
    if let Some((candidate, path)) = selected.as_mut() {
        let parent = path.parent().unwrap_or(&directory);
        candidate.release_notes = std::fs::read_to_string(parent.join("RELEASE_NOTES.md"))
            .or_else(|_| std::fs::read_to_string(parent.join("CHANGELOG.md")))
            .ok();
    }
    Ok(selected)
}

fn update_http_client(total: Duration) -> Result<reqwest::Client, String> {
    reqwest::Client::builder()
        .connect_timeout(Duration::from_secs(5))
        .read_timeout(Duration::from_secs(10))
        .timeout(total)
        .build()
        .map_err(|e| e.to_string())
}

async fn github_update_candidate() -> Result<Option<LocalUpdateCandidate>, String> {
    let response = update_http_client(Duration::from_secs(20))?
        .get(GITHUB_RELEASE_API)
        .header("User-Agent", "lijin-book-update-check")
        .send()
        .await
        .map_err(|e| format!("无法连接 GitHub 更新服务：{e}"))?;
    if response.status() == StatusCode::NOT_FOUND {
        return Ok(None);
    }
    if !response.status().is_success() {
        return Err(format!("GitHub 更新服务返回 HTTP {}", response.status()));
    }
    let release = response
        .json::<GithubRelease>()
        .await
        .map_err(|e| format!("无法读取 GitHub 发布信息：{e}"))?;
    let candidate = candidate_from_github_release(&release)?;
    Ok(candidate.filter(|candidate| {
        parse_release_version(&candidate.version)
            .zip(parse_release_version(APP_VERSION))
            .is_some_and(|(candidate, current)| candidate > current)
    }))
}

fn desktop_directory(app: &tauri::AppHandle) -> Option<PathBuf> {
    app.path().desktop_dir().ok().filter(|path| path.is_dir())
}

fn powershell_path_literal(path: &Path) -> String {
    format!("'{}'", path.to_string_lossy().replace('\'', "''"))
}

// Installer owns the variant shortcut. Debug and portable launches never mutate Desktop.

fn normalize_vault_path(path: &str) -> PathBuf {
    let mut result = PathBuf::from(path);
    if result.extension().and_then(|ext| ext.to_str()) != Some("giftvault") {
        result.set_extension("giftvault");
    }
    result
}

fn cleanup_sqlite_sidecars(path: &Path) {
    let base = path.to_string_lossy();
    let wal = PathBuf::from(format!("{base}-wal"));
    let shm = PathBuf::from(format!("{base}-shm"));
    let wal_is_empty = std::fs::metadata(&wal)
        .map(|metadata| metadata.len() == 0)
        .unwrap_or(false);
    if wal_is_empty {
        let _ = std::fs::remove_file(&wal);
        let _ = std::fs::remove_file(&shm);
    }
}

fn configure_connection(connection: &Connection) -> Result<(), String> {
    connection
        .execute_batch(
            // 礼金库是单文件格式。DELETE 日志会在事务结束后清理 SQLite
            // 的旁车文件，避免用户目录出现 .giftvault-wal/.giftvault-shm。
            "PRAGMA foreign_keys = ON; PRAGMA journal_mode = DELETE; PRAGMA busy_timeout = 5000;",
        )
        .map_err(|e| e.to_string())
}

fn migrate(connection: &Connection) -> Result<(), String> {
    configure_connection(connection)?;
    let version: i32 = connection
        .pragma_query_value(None, "user_version", |row| row.get(0))
        .map_err(|e| e.to_string())?;
    if version < 1 {
        connection.execute_batch(
            "CREATE TABLE IF NOT EXISTS vault_meta (key TEXT PRIMARY KEY NOT NULL, value TEXT NOT NULL);
             CREATE TABLE IF NOT EXISTS gift_books (
               id TEXT PRIMARY KEY NOT NULL, title TEXT NOT NULL, occasion TEXT NOT NULL DEFAULT '',
               event_date TEXT, location TEXT, notes TEXT, created_at TEXT NOT NULL, updated_at TEXT NOT NULL, deleted_at TEXT,
               source_file_name TEXT, source_file_path TEXT, source_imported_at TEXT
             );
             CREATE TABLE IF NOT EXISTS people (
               id TEXT PRIMARY KEY NOT NULL, display_name TEXT NOT NULL, address TEXT, notes TEXT,
               created_at TEXT NOT NULL, updated_at TEXT NOT NULL, deleted_at TEXT
             );
             CREATE TABLE IF NOT EXISTS tags (
               id TEXT PRIMARY KEY NOT NULL, name TEXT NOT NULL UNIQUE, color TEXT NOT NULL DEFAULT '#3b82f6',
               created_at TEXT NOT NULL, deleted_at TEXT
             );
             CREATE TABLE IF NOT EXISTS person_tags (
               person_id TEXT NOT NULL REFERENCES people(id) ON DELETE CASCADE,
               tag_id TEXT NOT NULL REFERENCES tags(id) ON DELETE CASCADE,
               PRIMARY KEY (person_id, tag_id)
             );
             CREATE TABLE IF NOT EXISTS gift_entries (
               id TEXT PRIMARY KEY NOT NULL, book_id TEXT NOT NULL REFERENCES gift_books(id),
               person_id TEXT NOT NULL REFERENCES people(id), amount_fen INTEGER NOT NULL CHECK (amount_fen > 0),
               payment_method TEXT NOT NULL DEFAULT '其他', received_at TEXT NOT NULL, note TEXT, return_gift TEXT,
               return_gift_amount_fen INTEGER CHECK (return_gift_amount_fen IS NULL OR return_gift_amount_fen > 0), return_gifted_at TEXT,
               tag_snapshot TEXT NOT NULL DEFAULT '[]', created_at TEXT NOT NULL, updated_at TEXT NOT NULL, deleted_at TEXT
             );
             CREATE TABLE IF NOT EXISTS audit_logs (
               id TEXT PRIMARY KEY NOT NULL, action TEXT NOT NULL, entity_type TEXT NOT NULL, entity_id TEXT NOT NULL,
               payload TEXT, created_at TEXT NOT NULL
             );
             CREATE INDEX IF NOT EXISTS idx_entries_book ON gift_entries(book_id, deleted_at, received_at);
             CREATE INDEX IF NOT EXISTS idx_entries_person ON gift_entries(person_id, deleted_at);
             INSERT OR IGNORE INTO vault_meta(key, value) VALUES ('format', 'giftvault');
             INSERT OR IGNORE INTO vault_meta(key, value) VALUES ('created_at', datetime('now'));
             PRAGMA user_version = 1;")
            .map_err(|e| e.to_string())?;
    }
    if version < 2 {
        connection
            .execute_batch(
                "INSERT OR IGNORE INTO vault_meta(key, value) VALUES ('vault_id', lower(hex(randomblob(16))));
                 PRAGMA user_version = 2;",
            )
            .map_err(|e| e.to_string())?;
    }
    if version < 3
        || !table_has_column(connection, "tags", "deleted_at")?
        || !table_has_column(connection, "gift_books", "source_file_name")?
        || !table_has_column(connection, "gift_books", "source_imported_at")?
    {
        if !table_has_column(connection, "tags", "deleted_at")? {
            connection
                .execute("ALTER TABLE tags ADD COLUMN deleted_at TEXT", [])
                .map_err(|e| e.to_string())?;
        }
        if !table_has_column(connection, "gift_books", "source_file_name")? {
            connection
                .execute(
                    "ALTER TABLE gift_books ADD COLUMN source_file_name TEXT",
                    [],
                )
                .map_err(|e| e.to_string())?;
        }
        if !table_has_column(connection, "gift_books", "source_imported_at")? {
            connection
                .execute(
                    "ALTER TABLE gift_books ADD COLUMN source_imported_at TEXT",
                    [],
                )
                .map_err(|e| e.to_string())?;
        }
        if version < 3 {
            connection
                .execute_batch("PRAGMA user_version = 3;")
                .map_err(|e| e.to_string())?;
        }
    }
    if version < 4 || table_exists(connection, "vault_security")? {
        let transaction = connection
            .unchecked_transaction()
            .map_err(|e| e.to_string())?;
        transaction
            .execute_batch("DROP TABLE IF EXISTS vault_security; PRAGMA user_version = 4;")
            .map_err(|e| e.to_string())?;
        transaction.commit().map_err(|e| e.to_string())?;
    }
    if version < 5 || !table_has_column(connection, "gift_books", "source_file_path")? {
        let transaction = connection
            .unchecked_transaction()
            .map_err(|e| e.to_string())?;
        if !table_has_column(&transaction, "gift_books", "source_file_path")? {
            transaction
                .execute(
                    "ALTER TABLE gift_books ADD COLUMN source_file_path TEXT",
                    [],
                )
                .map_err(|e| e.to_string())?;
        }
        transaction
            .execute_batch("PRAGMA user_version = 5;")
            .map_err(|e| e.to_string())?;
        transaction.commit().map_err(|e| e.to_string())?;
    }
    if version < 6 || !table_has_column(connection, "gift_entries", "return_gift")? {
        if !table_has_column(connection, "gift_entries", "return_gift")? {
            connection
                .execute("ALTER TABLE gift_entries ADD COLUMN return_gift TEXT", [])
                .map_err(|e| e.to_string())?;
        }
        connection
            .execute_batch("PRAGMA user_version = 6;")
            .map_err(|e| e.to_string())?;
    }
    if version < 7
        || !table_has_column(connection, "gift_entries", "return_gift_amount_fen")?
        || !table_has_column(connection, "gift_entries", "return_gifted_at")?
    {
        if !table_has_column(connection, "gift_entries", "return_gift_amount_fen")? {
            connection
                .execute(
                    "ALTER TABLE gift_entries ADD COLUMN return_gift_amount_fen INTEGER CHECK (return_gift_amount_fen IS NULL OR return_gift_amount_fen > 0)",
                    [],
                )
                .map_err(|e| e.to_string())?;
        }
        if !table_has_column(connection, "gift_entries", "return_gifted_at")? {
            connection
                .execute(
                    "ALTER TABLE gift_entries ADD COLUMN return_gifted_at TEXT",
                    [],
                )
                .map_err(|e| e.to_string())?;
        }
        connection
            .execute_batch("PRAGMA user_version = 7;")
            .map_err(|e| e.to_string())?;
    }
    if version < 8 {
        if table_exists(connection, "vault_meta")? {
            connection
                .execute(
                    "INSERT OR IGNORE INTO vault_meta(key, value) VALUES ('notes', '')",
                    [],
                )
                .map_err(|e| e.to_string())?;
        }
        connection
            .execute_batch("PRAGMA user_version = 8;")
            .map_err(|e| e.to_string())?;
    }
    if version < 9 || !table_exists(connection, "outbound_gifts")? {
        connection.execute_batch(
            "CREATE TABLE IF NOT EXISTS outbound_gifts (
               id TEXT PRIMARY KEY NOT NULL,
               person_name TEXT NOT NULL,
               amount_fen INTEGER NOT NULL CHECK (amount_fen > 0),
               given_at TEXT NOT NULL,
               note TEXT,
               tag_snapshot TEXT NOT NULL DEFAULT '[]',
               created_at TEXT NOT NULL,
               updated_at TEXT NOT NULL,
               deleted_at TEXT
             );
             CREATE INDEX IF NOT EXISTS idx_outbound_gifts_active ON outbound_gifts(deleted_at, given_at);
             PRAGMA user_version = 9;",
        ).map_err(|e| e.to_string())?;
    }
    Ok(())
}

fn table_exists(connection: &Connection, table: &str) -> Result<bool, String> {
    connection
        .query_row(
            "SELECT EXISTS(SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?)",
            params![table],
            |row| row.get(0),
        )
        .map_err(|e| e.to_string())
}

fn table_has_column(connection: &Connection, table: &str, column: &str) -> Result<bool, String> {
    let mut statement = connection
        .prepare(&format!("PRAGMA table_info({table})"))
        .map_err(|e| e.to_string())?;
    let rows = statement
        .query_map([], |row| row.get::<_, String>(1))
        .map_err(|e| e.to_string())?;
    for row in rows {
        if row.map_err(|e| e.to_string())? == column {
            return Ok(true);
        }
    }
    Ok(false)
}

fn active_vault_path(state: &State<'_, AppState>) -> Result<PathBuf, String> {
    state
        .vault_path
        .lock()
        .map_err(|_| "礼金库状态不可用".to_string())?
        .clone()
        .ok_or_else(|| "请先打开礼金库".to_string())
}

fn remember_opened_vault_path(state: &State<'_, AppState>, path: &Path) -> Result<(), String> {
    let canonical = path.canonicalize().unwrap_or_else(|_| path.to_path_buf());
    let mut paths = state
        .opened_vault_paths
        .lock()
        .map_err(|_| "礼金库打开状态不可用".to_string())?;
    if !paths.iter().any(|item| item == &canonical) {
        paths.push(canonical);
    }
    Ok(())
}

fn forget_opened_vault_path(state: &State<'_, AppState>, path: &Path) -> Result<(), String> {
    let key = comparable_path(path);
    let mut paths = state
        .opened_vault_paths
        .lock()
        .map_err(|_| "礼金库打开状态不可用".to_string())?;
    paths.retain(|item| comparable_path(item) != key);
    Ok(())
}

fn opened_vault_paths(state: &State<'_, AppState>) -> Result<Vec<PathBuf>, String> {
    state
        .opened_vault_paths
        .lock()
        .map_err(|_| "礼金库打开状态不可用".to_string())
        .map(|paths| paths.clone())
}

fn clear_opened_vault_paths(state: &State<'_, AppState>) -> Result<(), String> {
    state
        .opened_vault_paths
        .lock()
        .map_err(|_| "礼金库打开状态不可用".to_string())?
        .clear();
    Ok(())
}

fn is_admin_session(state: &AppState) -> Result<bool, String> {
    Ok(state
        .session
        .lock()
        .map_err(|_| "管理员会话不可用".to_string())?
        .role
        == SessionRole::Admin)
}

fn is_edit_locked(state: &AppState) -> Result<bool, String> {
    Ok(state
        .session
        .lock()
        .map_err(|_| "管理员会话不可用".to_string())?
        .edit_locked)
}

fn set_edit_locked(state: &AppState, locked: bool) -> Result<(), String> {
    state
        .session
        .lock()
        .map_err(|_| "管理员会话不可用".to_string())?
        .edit_locked = locked;
    Ok(())
}

fn configure_read_connection(connection: &Connection) -> Result<(), String> {
    connection
        .execute_batch(
            "PRAGMA foreign_keys = ON; PRAGMA query_only = ON; PRAGMA busy_timeout = 5000;",
        )
        .map_err(|e| e.to_string())
}

fn migrate_vault_if_needed(path: &Path) -> Result<(), String> {
    let connection = Connection::open(path).map_err(|e| e.to_string())?;
    let version: i32 = connection
        .pragma_query_value(None, "user_version", |row| row.get(0))
        .map_err(|e| e.to_string())?;
    if version < CURRENT_SCHEMA || table_exists(&connection, "vault_security")? {
        auto_backup_for_path(path, &format!("migration-before-v{CURRENT_SCHEMA}"), true)?;
        migrate(&connection)?;
    }
    Ok(())
}

fn set_admin_session(state: &AppState) -> Result<(), String> {
    let mut session = state
        .session
        .lock()
        .map_err(|_| "管理员会话不可用".to_string())?;
    session.role = SessionRole::Admin;
    session.failed_attempts = 0;
    session.locked_until = None;
    session.edit_locked = false;
    Ok(())
}

fn reset_session(state: &AppState) -> Result<(), String> {
    let mut session = state
        .session
        .lock()
        .map_err(|_| "管理员会话不可用".to_string())?;
    session.role = SessionRole::Viewer;
    session.edit_locked = true;
    Ok(())
}

fn require_admin(state: &AppState) -> Result<(), String> {
    let mut session = state
        .session
        .lock()
        .map_err(|_| "管理员会话不可用".to_string())?;
    if session.role != SessionRole::Admin {
        session.role = SessionRole::Viewer;
        return Err("当前为只读模式，请先解锁管理员权限".to_string());
    }
    Ok(())
}

fn admin_connection(
    state: &AppState,
    vault_path: &str,
    reason: &str,
    high_risk: bool,
) -> Result<Connection, String> {
    require_admin(state)?;
    if !matches!(
        reason,
        "set-person-tags" | "create-tag" | "update-tag-color"
    ) && is_edit_locked(state)?
    {
        return Err("编辑已锁定，请先解锁编辑".to_string());
    }
    let path = canonical_opened_vault_path(state, Some(vault_path))?;
    migrate_vault_if_needed(&path)?;
    auto_backup_for_path(&path, reason, high_risk)?;
    let connection = Connection::open(&path).map_err(|e| e.to_string())?;
    configure_connection(&connection)?;
    Ok(connection)
}

fn canonical_opened_vault_path(
    state: &AppState,
    requested_path: Option<&str>,
) -> Result<PathBuf, String> {
    let requested = match requested_path {
        Some(path) => PathBuf::from(path),
        None => state
            .vault_path
            .lock()
            .map_err(|_| "礼金库状态不可用".to_string())?
            .clone()
            .ok_or("请先打开礼金库")?,
    };
    let requested = requested
        .canonicalize()
        .map_err(|_| "找不到回收站项目所属的礼金库".to_string())?;
    let opened = state
        .opened_vault_paths
        .lock()
        .map_err(|_| "礼金库打开状态不可用".to_string())?
        .clone();
    if opened
        .iter()
        .map(|path| path.canonicalize().unwrap_or_else(|_| path.clone()))
        .any(|path| comparable_path(&path) == comparable_path(&requested))
    {
        return Ok(requested);
    }
    Err("该礼金库未在当前会话中打开".to_string())
}

fn admin_connection_for_path(
    state: &AppState,
    requested_path: Option<&str>,
    reason: &str,
    high_risk: bool,
) -> Result<Connection, String> {
    require_admin(state)?;
    if is_edit_locked(state)? {
        return Err("编辑已锁定，请先解锁编辑".to_string());
    }
    let path = canonical_opened_vault_path(state, requested_path)?;
    migrate_vault_if_needed(&path)?;
    auto_backup_for_path(&path, reason, high_risk)?;
    let connection = Connection::open(path).map_err(|e| e.to_string())?;
    configure_connection(&connection)?;
    Ok(connection)
}

fn scoped_read_connection(
    state: &State<'_, AppState>,
    vault_path: &str,
) -> Result<Connection, String> {
    let path = canonical_opened_vault_path(state, Some(vault_path))?;
    let connection = Connection::open_with_flags(path, OpenFlags::SQLITE_OPEN_READ_ONLY)
        .map_err(|e| e.to_string())?;
    configure_read_connection(&connection)?;
    Ok(connection)
}

fn write_audit(
    transaction: &Transaction<'_>,
    action: &str,
    entity_type: &str,
    entity_id: &str,
    payload: &str,
) -> Result<(), rusqlite::Error> {
    transaction.execute("INSERT INTO audit_logs(id, action, entity_type, entity_id, payload, created_at) VALUES (?, ?, ?, ?, ?, ?)", params![Uuid::new_v4().to_string(), action, entity_type, entity_id, payload, now()])?;
    Ok(())
}

#[derive(Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct AuditPayload {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    person_id: Option<String>,
    target: String,
    book_title: Option<String>,
    description: String,
    #[serde(default)]
    changes: Vec<AuditChange>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct AuditContext {
    person_id: String,
    vault_id: Option<String>,
    vault_path: String,
    book_id: Option<String>,
    book_ids: Vec<String>,
    book_titles: Vec<String>,
}

fn write_audit_detail(
    transaction: &Transaction<'_>,
    action: &str,
    entity_type: &str,
    entity_id: &str,
    payload: AuditPayload,
) -> Result<(), String> {
    write_audit_detail_with_context(transaction, action, entity_type, entity_id, payload, None)
}

fn write_audit_detail_with_context(
    transaction: &Transaction<'_>,
    action: &str,
    entity_type: &str,
    entity_id: &str,
    payload: AuditPayload,
    context: Option<AuditContext>,
) -> Result<(), String> {
    let should_record = matches!(
        (entity_type, action),
        ("gift_entry", "update" | "delete" | "restore")
            | ("person", "update" | "delete" | "restore")
            | ("gift_book", "update" | "delete" | "restore")
            | ("vault", "update")
    );
    if !should_record {
        return Ok(());
    }
    let mut payload = serde_json::to_value(payload).map_err(|error| error.to_string())?;
    if let (Some(context), Some(object)) = (context, payload.as_object_mut()) {
        let context = serde_json::to_value(context).map_err(|error| error.to_string())?;
        if let Some(context_object) = context.as_object() {
            for (key, value) in context_object {
                object.insert(key.clone(), value.clone());
            }
        }
    }
    let payload = serde_json::to_string(&payload).map_err(|error| error.to_string())?;
    write_audit(transaction, action, entity_type, entity_id, &payload)
        .map_err(|error| error.to_string())
}

fn audit_change(field: &str, before: impl ToString, after: impl ToString) -> AuditChange {
    AuditChange {
        field: field.to_string(),
        before: before.to_string(),
        after: after.to_string(),
        machine: None,
    }
}

fn machine_change(
    field: &str,
    field_id: &str,
    before: impl Serialize,
    after: impl Serialize,
) -> AuditChange {
    let before = serde_json::to_value(before).expect("audit scalar serializes");
    let after = serde_json::to_value(after).expect("audit scalar serializes");
    let display = |value: &serde_json::Value| match value {
        serde_json::Value::Null => "未填写".to_string(),
        serde_json::Value::String(value) => value.clone(),
        serde_json::Value::Number(value) if field_id.ends_with("_fen") => value
            .as_i64()
            .map(format_money_fen)
            .unwrap_or_else(|| value.to_string()),
        _ => value.to_string(),
    };
    AuditChange {
        field: field.to_string(),
        before: display(&before),
        after: display(&after),
        machine: Some(AuditMachineChange {
            version: 1,
            field_id: field_id.to_string(),
            before,
            after,
        }),
    }
}

fn format_money_fen(amount_fen: i64) -> String {
    format!("¥{}.{:02}", amount_fen / 100, amount_fen % 100)
}

fn audit_book_title(connection: &Connection, book_id: &str) -> Result<String, String> {
    connection
        .query_row(
            "SELECT title FROM gift_books WHERE id = ?",
            params![book_id],
            |row| row.get(0),
        )
        .map_err(|error| error.to_string())
}

fn audit_person_book_titles(connection: &Connection, person_id: &str) -> Result<String, String> {
    let mut statement = connection
        .prepare(
            "SELECT DISTINCT b.title
             FROM gift_entries e
             JOIN gift_books b ON b.id = e.book_id
             WHERE e.person_id = ? AND e.deleted_at IS NULL AND b.deleted_at IS NULL
             ORDER BY b.title",
        )
        .map_err(|error| error.to_string())?;
    let titles = statement
        .query_map(params![person_id], |row| row.get::<_, String>(0))
        .map_err(|error| error.to_string())?
        .collect::<Result<Vec<_>, _>>()
        .map_err(|error| error.to_string())?;
    Ok(if titles.is_empty() {
        "未关联礼金簿".to_string()
    } else {
        titles.join("、")
    })
}

fn audit_person_book_sources(
    connection: &Connection,
    person_id: &str,
) -> Result<Vec<(String, String)>, String> {
    let mut statement = connection
        .prepare(
            "SELECT DISTINCT b.id, b.title
             FROM gift_entries e
             JOIN gift_books b ON b.id = e.book_id
             WHERE e.person_id = ? AND e.deleted_at IS NULL AND b.deleted_at IS NULL
             ORDER BY b.title, b.id",
        )
        .map_err(|error| error.to_string())?;
    let sources = statement
        .query_map(params![person_id], |row| Ok((row.get(0)?, row.get(1)?)))
        .map_err(|error| error.to_string())?
        .collect::<Result<Vec<_>, _>>()
        .map_err(|error| error.to_string())?;
    Ok(sources)
}

fn audit_vault_id(connection: &Connection) -> Result<Option<String>, String> {
    connection
        .query_row(
            "SELECT value FROM vault_meta WHERE key = 'vault_id'",
            [],
            |row| row.get(0),
        )
        .optional()
        .map_err(|error| error.to_string())
}

fn merge_contiguous_person_tag_audit(
    transaction: &Transaction<'_>,
    person_id: &str,
) -> Result<(), String> {
    let mut statement = transaction
        .prepare(
            "SELECT id, entity_type, entity_id, payload, created_at
             FROM audit_logs ORDER BY rowid DESC LIMIT 2",
        )
        .map_err(|error| error.to_string())?;
    let rows = statement
        .query_map([], |row| {
            Ok((
                row.get::<_, String>(0)?,
                row.get::<_, String>(1)?,
                row.get::<_, String>(2)?,
                row.get::<_, String>(3)?,
                row.get::<_, String>(4)?,
            ))
        })
        .map_err(|error| error.to_string())?
        .collect::<Result<Vec<_>, _>>()
        .map_err(|error| error.to_string())?;
    drop(statement);
    if rows.len() != 2 {
        return Ok(());
    }
    let current = &rows[0];
    let previous = &rows[1];
    if current.1 != "person"
        || current.2 != person_id
        || previous.1 != "person"
        || previous.2 != person_id
    {
        return Ok(());
    }
    let Ok(current_time) = DateTime::parse_from_rfc3339(&current.4) else {
        return Ok(());
    };
    let Ok(previous_time) = DateTime::parse_from_rfc3339(&previous.4) else {
        return Ok(());
    };
    if (current_time - previous_time).num_seconds() > 8 {
        return Ok(());
    }
    let Ok(current_payload) = serde_json::from_str::<AuditPayload>(&current.3) else {
        return Ok(());
    };
    let Ok(previous_payload) = serde_json::from_str::<AuditPayload>(&previous.3) else {
        return Ok(());
    };
    let Some(current_change) = current_payload.changes.first() else {
        return Ok(());
    };
    let Some(previous_change) = previous_payload.changes.first() else {
        return Ok(());
    };
    if current_payload.changes.len() != 1
        || previous_payload.changes.len() != 1
        || current_change.field != "人物标签"
        || previous_change.field != "人物标签"
        || previous_change.after != current_change.before
    {
        return Ok(());
    }
    if current_change.machine.is_none() || previous_change.machine.is_none() {
        return Ok(());
    }
    let mut merged = serde_json::from_str::<serde_json::Value>(&previous.3)
        .map_err(|error| error.to_string())?;
    if let Some(object) = merged.as_object_mut() {
        object.insert(
            "description".to_string(),
            serde_json::Value::String("修改人物标签".to_string()),
        );
        object.insert(
            "bookTitle".to_string(),
            current_payload
                .book_title
                .clone()
                .or(previous_payload.book_title.clone())
                .map_or(serde_json::Value::Null, serde_json::Value::String),
        );
        object.insert(
            "changes".to_string(),
            serde_json::to_value(vec![{
                let mut change =
                    audit_change("人物标签", &previous_change.before, &current_change.after);
                let mut machine = previous_change.machine.clone().ok_or("标签机器快照缺失")?;
                machine.after = current_change
                    .machine
                    .as_ref()
                    .ok_or("标签机器快照缺失")?
                    .after
                    .clone();
                change.machine = Some(machine);
                change
            }])
            .map_err(|error| error.to_string())?,
        );
        if let Ok(current_object) = serde_json::from_str::<serde_json::Value>(&current.3) {
            if let Some(current_object) = current_object.as_object() {
                for key in [
                    "personId",
                    "vaultId",
                    "vaultPath",
                    "bookId",
                    "bookIds",
                    "bookTitles",
                ] {
                    if let Some(value) = current_object.get(key) {
                        object.insert(key.to_string(), value.clone());
                    }
                }
            }
        }
    }
    transaction
        .execute(
            "UPDATE audit_logs SET payload = ?, created_at = ? WHERE id = ?",
            params![merged.to_string(), current.4, previous.0],
        )
        .map_err(|error| error.to_string())?;
    transaction
        .execute("DELETE FROM audit_logs WHERE id = ?", params![current.0])
        .map_err(|error| error.to_string())?;
    Ok(())
}

#[derive(Clone)]
struct EntryAuditSnapshot {
    person_id: String,
    book_title: String,
    person_name: String,
    address: Option<String>,
    amount_fen: i64,
    payment_method: String,
    note: Option<String>,
    return_gift: Option<String>,
    return_gift_amount_fen: Option<i64>,
    tags: String,
    tag_ids: Vec<String>,
    received_at: String,
    return_gifted_at: Option<String>,
}

struct ReturnGiftUpdateSnapshot {
    book_id: String,
    book_title: String,
    person_id: String,
    person_name: String,
    address: Option<String>,
    previous_amount: i64,
    return_gifted_at: Option<String>,
    return_gift: Option<String>,
}

fn entry_audit_snapshot(
    connection: &Connection,
    entry_id: &str,
) -> Result<EntryAuditSnapshot, String> {
    let mut snapshot = connection
        .query_row(
            "SELECT b.title, p.display_name, p.address, e.amount_fen, e.payment_method, e.note, e.return_gift, e.return_gift_amount_fen,
                    COALESCE((SELECT GROUP_CONCAT(t.name, '、') FROM person_tags pt JOIN tags t ON t.id = pt.tag_id WHERE pt.person_id = p.id AND t.deleted_at IS NULL), ''), p.id, e.received_at, e.return_gifted_at
             FROM gift_entries e
             JOIN gift_books b ON b.id = e.book_id
             JOIN people p ON p.id = e.person_id
             WHERE e.id = ?",
            params![entry_id],
            |row| {
                Ok(EntryAuditSnapshot {
                    book_title: row.get(0)?,
                    person_name: row.get(1)?,
                    address: row.get(2)?,
                    amount_fen: read_money_fen(row, 3)?,
                    payment_method: row.get(4)?,
                    note: row.get(5)?,
                    return_gift: row.get(6)?,
                    return_gift_amount_fen: read_optional_money_fen(row, 7)?,
                    tags: row.get(8)?,
                    person_id: row.get(9)?,
                    received_at: row.get(10)?,
                    return_gifted_at: row.get(11)?,
                    tag_ids: Vec::new(),
                })
            },
        )
        .map_err(|error| error.to_string())?;
    snapshot.tag_ids = active_person_tag_ids(connection, &snapshot.person_id)?;
    Ok(snapshot)
}

fn active_person_tag_ids(connection: &Connection, person_id: &str) -> Result<Vec<String>, String> {
    let mut statement = connection.prepare("SELECT t.id FROM person_tags pt JOIN tags t ON t.id=pt.tag_id WHERE pt.person_id=? AND t.deleted_at IS NULL ORDER BY t.id").map_err(|e| e.to_string())?;
    let rows = statement
        .query_map(params![person_id], |row| row.get(0))
        .map_err(|e| e.to_string())?;
    rows.collect::<Result<Vec<_>, _>>()
        .map_err(|e| e.to_string())
}

fn entry_audit_changes(
    before: &EntryAuditSnapshot,
    after: &EntryAuditSnapshot,
) -> Vec<AuditChange> {
    let mut changes = Vec::new();
    if before.person_id != after.person_id {
        let mut change =
            machine_change("人物关联", "person_id", &before.person_id, &after.person_id);
        change.before = format!(
            "{}（{}）",
            before.person_name,
            before.address.as_deref().unwrap_or("未填写地址")
        );
        change.after = format!(
            "{}（{}）",
            after.person_name,
            after.address.as_deref().unwrap_or("未填写地址")
        );
        changes.push(change);
    }
    if before.person_name != after.person_name {
        changes.push(machine_change(
            "姓名",
            "person_name",
            &before.person_name,
            &after.person_name,
        ));
    }
    if before.address != after.address {
        changes.push(machine_change(
            "地址",
            "address",
            &before.address,
            &after.address,
        ));
    }
    if before.amount_fen != after.amount_fen {
        let mut change = machine_change("金额", "amount_fen", before.amount_fen, after.amount_fen);
        change.before = format_money_fen(before.amount_fen);
        change.after = format_money_fen(after.amount_fen);
        changes.push(change);
    }
    if before.payment_method != after.payment_method {
        changes.push(machine_change(
            "支付方式",
            "payment_method",
            &before.payment_method,
            &after.payment_method,
        ));
    }
    if before.received_at != after.received_at {
        changes.push(machine_change(
            "登记日期",
            "received_at",
            &before.received_at,
            &after.received_at,
        ));
    }
    if before.note != after.note {
        changes.push(machine_change("备注", "note", &before.note, &after.note));
    }
    if before.return_gift != after.return_gift {
        changes.push(machine_change(
            "回礼备注",
            "return_gift",
            &before.return_gift,
            &after.return_gift,
        ));
    }
    if before.return_gift_amount_fen != after.return_gift_amount_fen {
        let mut change = machine_change(
            "回礼金额",
            "return_gift_amount_fen",
            before.return_gift_amount_fen,
            after.return_gift_amount_fen,
        );
        change.before = before
            .return_gift_amount_fen
            .map(format_money_fen)
            .unwrap_or_else(|| "未填写".to_string());
        change.after = after
            .return_gift_amount_fen
            .map(format_money_fen)
            .unwrap_or_else(|| "未填写".to_string());
        changes.push(change);
    }
    if before.return_gifted_at != after.return_gifted_at {
        changes.push(machine_change(
            "回礼时间",
            "return_gifted_at",
            &before.return_gifted_at,
            &after.return_gifted_at,
        ));
    }
    if before.tag_ids != after.tag_ids {
        let mut change = machine_change("人物标签", "tag_ids", &before.tag_ids, &after.tag_ids);
        change.before = if before.tags.is_empty() {
            "未设置".to_string()
        } else {
            before.tags.clone()
        };
        change.after = if after.tags.is_empty() {
            "未设置".to_string()
        } else {
            after.tags.clone()
        };
        changes.push(change);
    }
    changes
}

fn vault_info(path: &Path, connection: &Connection) -> Result<VaultInfo, String> {
    let name: String = connection
        .query_row(
            "SELECT value FROM vault_meta WHERE key = 'name'",
            [],
            |row| row.get(0),
        )
        .optional()
        .map_err(|e| e.to_string())?
        .unwrap_or_else(|| {
            path.file_stem()
                .and_then(|v| v.to_str())
                .unwrap_or("家庭礼金库")
                .to_string()
        });
    let notes = connection
        .query_row(
            "SELECT value FROM vault_meta WHERE key = 'notes'",
            [],
            |row| row.get::<_, String>(0),
        )
        .optional()
        .map_err(|e| e.to_string())?
        .and_then(|value| null_if_empty(&value));
    let book_count: i64 = connection
        .query_row(
            "SELECT COUNT(*) FROM gift_books WHERE deleted_at IS NULL",
            [],
            |row| row.get(0),
        )
        .map_err(|e| e.to_string())?;
    Ok(VaultInfo {
        path: displayable_path(path),
        name,
        notes,
        book_count,
    })
}

fn validate_vault_connection(connection: &Connection) -> Result<(), String> {
    let format = connection
        .query_row(
            "SELECT value FROM vault_meta WHERE key = 'format'",
            [],
            |row| row.get::<_, String>(0),
        )
        .optional()
        .map_err(|error| error.to_string())?;
    if format.as_deref() != Some("giftvault") {
        return Err("这不是礼金簿创建的礼金库文件".to_string());
    }
    let version: i32 = connection
        .pragma_query_value(None, "user_version", |row| row.get(0))
        .map_err(|error| error.to_string())?;
    if version > CURRENT_SCHEMA {
        return Err(format!(
            "礼金库格式版本 v{version} 高于当前软件支持的 v{CURRENT_SCHEMA}，请先更新软件"
        ));
    }
    for table in [
        "vault_meta",
        "gift_books",
        "people",
        "tags",
        "person_tags",
        "gift_entries",
        "audit_logs",
    ] {
        if !table_exists(connection, table)? {
            return Err(format!("礼金库文件缺少必要数据表：{table}"));
        }
    }
    let integrity: String = connection
        .query_row("PRAGMA integrity_check", [], |row| row.get(0))
        .map_err(|error| error.to_string())?;
    if integrity != "ok" {
        return Err(format!("礼金库完整性校验失败：{integrity}"));
    }
    let foreign_key_errors: i64 = connection
        .query_row("SELECT COUNT(*) FROM pragma_foreign_key_check", [], |row| {
            row.get(0)
        })
        .map_err(|e| e.to_string())?;
    if foreign_key_errors != 0 {
        return Err("礼金库包含缺失关联，完整性校验失败".to_string());
    }
    Ok(())
}

fn validate_vault_file(path: &Path) -> Result<(), String> {
    let path = path.canonicalize().map_err(|error| error.to_string())?;
    let connection = Connection::open_with_flags(path, OpenFlags::SQLITE_OPEN_READ_ONLY)
        .map_err(|error| error.to_string())?;
    validate_vault_connection(&connection)
}

fn vault_open_result(
    path: &Path,
    connection: &Connection,
    role: SessionRole,
) -> Result<VaultOpenResult, String> {
    Ok(VaultOpenResult {
        vault: vault_info(path, connection)?,
        role: if role == SessionRole::Admin {
            "admin".to_string()
        } else {
            "viewer".to_string()
        },
    })
}

fn app_backup_root() -> PathBuf {
    std::env::var_os("LOCALAPPDATA")
        .map(PathBuf::from)
        .unwrap_or_else(std::env::temp_dir)
        .join("礼金簿—改动")
        .join("backups")
}

fn vault_trash_root() -> PathBuf {
    app_backup_root().join("vault-trash")
}

#[derive(Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct VaultTrashManifest {
    id: String,
    original_path: String,
    trash_path: String,
    name: String,
    deleted_at: String,
}

fn read_vault_trash_manifests() -> Result<Vec<VaultTrashManifest>, String> {
    read_vault_trash_directory(&vault_trash_root())
}

fn read_vault_trash_directory(directory: &Path) -> Result<Vec<VaultTrashManifest>, String> {
    if !directory.is_dir() {
        return Ok(Vec::new());
    }
    if metadata_is_reparse(&std::fs::symlink_metadata(directory).map_err(|e| e.to_string())?) {
        return Err("回收站目录是链接或重解析点，未读取外部文件".to_string());
    }
    let mut manifests = Vec::new();
    for entry in std::fs::read_dir(directory).map_err(|e| e.to_string())? {
        let entry = entry.map_err(|e| e.to_string())?;
        if entry.path().extension().and_then(|value| value.to_str()) != Some("json") {
            continue;
        }
        let Ok(raw) = std::fs::read_to_string(entry.path()) else {
            continue;
        };
        if let Ok(manifest) = serde_json::from_str::<VaultTrashManifest>(&raw) {
            if Uuid::parse_str(&manifest.id).is_err() {
                continue;
            }
            let expected = directory.join(format!("{}.giftvault", manifest.id));
            if std::fs::symlink_metadata(&expected)
                .is_ok_and(|metadata| metadata_is_reparse(&metadata))
            {
                continue;
            }
            if expected.is_file()
                && comparable_path(Path::new(&manifest.trash_path)) == comparable_path(&expected)
            {
                manifests.push(manifest);
            }
        }
    }
    // A crash or an invalid manifest must never hide the sole surviving snapshot.
    for entry in std::fs::read_dir(directory).map_err(|e| e.to_string())? {
        let entry = entry.map_err(|e| e.to_string())?;
        let path = entry.path();
        if std::fs::symlink_metadata(&path).is_ok_and(|metadata| metadata_is_reparse(&metadata)) {
            continue;
        }
        if path.extension().and_then(|value| value.to_str()) != Some("giftvault") {
            continue;
        }
        let Some(id) = path.file_stem().and_then(|value| value.to_str()) else {
            continue;
        };
        if manifests.iter().any(|manifest| manifest.id == id) {
            continue;
        }
        manifests.push(VaultTrashManifest {
            id: id.to_string(),
            original_path: String::new(),
            trash_path: displayable_path(&path),
            name: "待核对原路径的礼金库快照（保留中）".to_string(),
            deleted_at: String::new(),
        });
    }
    manifests.sort_by(|left, right| right.deleted_at.cmp(&left.deleted_at));
    Ok(manifests)
}

fn trash_vault_file(path: &Path, state: &State<'_, AppState>) -> Result<(), String> {
    require_admin(state)?;
    if is_edit_locked(state)? {
        return Err("编辑已锁定，请先解锁编辑".to_string());
    }
    let source = canonical_opened_vault_path(state, Some(&displayable_path(path)))?;
    if source.extension().and_then(|value| value.to_str()) != Some("giftvault") {
        return Err("只能删除礼金库文件".to_string());
    }
    let active = active_vault_path(state)
        .ok()
        .and_then(|value| value.canonicalize().ok());
    if active.as_ref() == Some(&source) {
        return Err("当前正在操作的礼金库不能从比较区删除，请先切换到其他礼金库".to_string());
    }
    validate_vault_file(&source)?;
    trash_vault_into_directory(&source, &vault_trash_root(), &Uuid::new_v4().to_string())?;
    forget_opened_vault_path(state, &source)?;
    Ok(())
}

fn trash_vault_into_directory(source: &Path, directory: &Path, id: &str) -> Result<(), String> {
    Uuid::parse_str(id).map_err(|_| "回收记录标识无效".to_string())?;
    let read_connection = Connection::open_with_flags(source, OpenFlags::SQLITE_OPEN_READ_ONLY)
        .map_err(|e| e.to_string())?;
    let name = comparison_vault_name(&read_connection, source)?;
    drop(read_connection);
    std::fs::create_dir_all(directory).map_err(|e| e.to_string())?;
    let trash_path = directory.join(format!("{id}.giftvault"));
    let deleted_at = now();
    let manifest = VaultTrashManifest {
        id: id.to_string(),
        original_path: displayable_path(source),
        trash_path: displayable_path(&trash_path),
        name,
        deleted_at,
    };
    snapshot_vault(source, &trash_path)?;
    let manifest_path = directory.join(format!("{id}.json"));
    let bytes = serde_json::to_vec_pretty(&manifest).map_err(|e| e.to_string())?;
    let mut file = std::fs::OpenOptions::new()
        .write(true)
        .create_new(true)
        .open(&manifest_path)
        .map_err(|e| format!("回收记录写入失败，原库及快照已保留：{e}"))?;
    use std::io::Write;
    file.write_all(&bytes)
        .and_then(|_| file.sync_all())
        .map_err(|e| format!("回收记录保存失败，原库及快照已保留：{e}"))?;
    drop(file);
    std::fs::remove_file(source)
        .map_err(|e| format!("原库删除失败，原库和可恢复快照已保留：{e}"))?;
    Ok(())
}

fn restore_vault_file(id: &str, state: &State<'_, AppState>) -> Result<(), String> {
    require_admin(state)?;
    if is_edit_locked(state)? {
        return Err("编辑已锁定，请先解锁编辑".to_string());
    }
    let manifest = read_vault_trash_manifests()?
        .into_iter()
        .find(|item| item.id == id)
        .ok_or_else(|| "找不到礼金库回收记录".to_string())?;
    let original = match vault_restore_original_destination(&manifest)? {
        Some(path) => path,
        None => normalize_vault_path(
            &choose_file_path(
                "save",
                "恢复礼金库另存为",
                &["giftvault"],
                "恢复的礼金库.giftvault",
            )
            .ok_or_else(|| format!("已取消另存恢复；快照保留于 {}", manifest.trash_path))?,
        ),
    };
    restore_vault_snapshot_to(Path::new(&manifest.trash_path), &original)?;
    let _ = std::fs::remove_file(vault_trash_root().join(format!("{id}.json")));
    Ok(())
}

fn vault_restore_original_destination(
    manifest: &VaultTrashManifest,
) -> Result<Option<PathBuf>, String> {
    let original = PathBuf::from(&manifest.original_path);
    if manifest.original_path.is_empty() {
        return Ok(None);
    }
    if original.exists() {
        return Err(format!(
            "原礼金库路径已有文件，可能是删除未完成；恢复不会覆盖文件。快照保留于 {}",
            manifest.trash_path
        ));
    }
    Ok(Some(original))
}

fn restore_vault_snapshot_to(snapshot: &Path, destination: &Path) -> Result<(), String> {
    snapshot_vault(snapshot, destination)?;
    std::fs::remove_file(snapshot).map_err(|e| {
        format!(
            "礼金库已另存于 {}，回收副本保留但清理失败：{e}",
            displayable_path(destination)
        )
    })?;
    Ok(())
}

fn empty_vault_trash() -> Result<(), String> {
    for manifest in read_vault_trash_manifests()? {
        if manifest.original_path.is_empty() {
            continue;
        }
        let _ = std::fs::remove_file(&manifest.trash_path);
        let _ = std::fs::remove_file(vault_trash_root().join(format!("{}.json", manifest.id)));
    }
    Ok(())
}

#[tauri::command(async)]
fn trash_vault(path: String, state: State<'_, AppState>) -> Result<(), String> {
    with_operation(|| trash_vault_file(Path::new(&path), &state))
}

fn snapshot_vault(source: &Path, destination: &Path) -> Result<(), String> {
    validate_vault_file(source)?;
    publish_vault_file(destination, |temporary| {
        copy_vault_read_only(source, temporary)
    })
    .map_err(|error| format!("礼金库快照失败，已阻止写入：{error}"))
}

fn publish_vault_file(
    destination: &Path,
    write: impl FnOnce(&Path) -> Result<(), String>,
) -> Result<(), String> {
    let parent = destination.parent().ok_or("目标文件没有父目录")?;
    std::fs::create_dir_all(parent).map_err(|e| e.to_string())?;
    let temporary = parent.join(format!(".giftvault-{}.tmp", Uuid::new_v4()));
    let owned = std::fs::OpenOptions::new()
        .read(true)
        .write(true)
        .create_new(true)
        .open(&temporary)
        .map_err(|e| e.to_string())?;
    drop(owned);
    let result = (|| {
        write(&temporary)?;
        validate_vault_file(&temporary)?;
        std::fs::OpenOptions::new()
            .write(true)
            .open(&temporary)
            .and_then(|file| file.sync_all())
            .map_err(|e| e.to_string())?;
        publish_no_replace(&temporary, destination)
            .map_err(|e| format!("发布礼金库失败（目标可能已存在）：{e}"))?;
        Ok(())
    })();
    let _ = std::fs::remove_file(&temporary);
    result
}

#[cfg(windows)]
fn publish_no_replace(temporary: &Path, destination: &Path) -> std::io::Result<()> {
    use std::os::windows::ffi::OsStrExt;
    #[link(name = "kernel32")]
    extern "system" {
        fn MoveFileExW(existing: *const u16, destination: *const u16, flags: u32) -> i32;
    }
    let temporary = temporary.canonicalize()?;
    let parent = destination
        .parent()
        .ok_or_else(|| std::io::Error::new(std::io::ErrorKind::InvalidInput, "目标没有父目录"))?
        .canonicalize()?;
    let destination =
        parent.join(destination.file_name().ok_or_else(|| {
            std::io::Error::new(std::io::ErrorKind::InvalidInput, "目标没有文件名")
        })?);
    let source: Vec<u16> = temporary.as_os_str().encode_wide().chain(Some(0)).collect();
    let target: Vec<u16> = destination
        .as_os_str()
        .encode_wide()
        .chain(Some(0))
        .collect();
    // Same-directory rename supports removable filesystems too. No
    // REPLACE_EXISTING or COPY_ALLOWED flag: concurrent winners are preserved.
    // SAFETY: both pointers refer to live, nul-terminated UTF-16 buffers.
    if unsafe { MoveFileExW(source.as_ptr(), target.as_ptr(), 0x8) } == 0 {
        return Err(std::io::Error::last_os_error());
    }
    Ok(())
}

#[cfg(not(windows))]
fn publish_no_replace(temporary: &Path, destination: &Path) -> std::io::Result<()> {
    std::fs::hard_link(temporary, destination)
}

fn copy_vault_read_only(source: &Path, destination: &Path) -> Result<(), String> {
    let source = source.canonicalize().map_err(|error| error.to_string())?;
    let destination = if destination.exists() {
        destination
            .canonicalize()
            .map_err(|error| error.to_string())?
    } else {
        destination
            .parent()
            .ok_or("快照目标没有父目录")?
            .canonicalize()
            .map_err(|error| error.to_string())?
            .join(destination.file_name().ok_or("快照目标没有文件名")?)
    };
    let source = Connection::open_with_flags(source, OpenFlags::SQLITE_OPEN_READ_ONLY)
        .map_err(|error| error.to_string())?;
    let mut destination = Connection::open(destination).map_err(|error| error.to_string())?;
    let backup = Backup::new(&source, &mut destination).map_err(|error| error.to_string())?;
    backup
        .run_to_completion(64, Duration::from_millis(10), None)
        .map_err(|error| error.to_string())
}

fn move_vault_file(source: &Path, destination: &Path) -> Result<(), String> {
    let parent = destination
        .parent()
        .filter(|directory| directory.is_dir())
        .ok_or_else(|| "目标文件夹不存在或不可用".to_string())?;
    let probe = parent.join(format!(".giftvault-write-check-{}", Uuid::new_v4()));
    OpenOptions::new()
        .write(true)
        .create_new(true)
        .open(&probe)
        .map_err(|error| format!("目标文件夹不可写：{error}"))?;
    std::fs::remove_file(&probe).map_err(|error| format!("无法清理目标文件夹校验文件：{error}"))?;
    if let Err(error) = copy_vault_read_only(source, destination) {
        let _ = std::fs::remove_file(destination);
        return Err(error);
    }
    if let Err(error) = validate_vault_file(destination) {
        let _ = std::fs::remove_file(destination);
        return Err(format!("复制后的礼金库校验失败，未移动原文件：{error}"));
    }
    if let Err(error) = std::fs::remove_file(source) {
        if std::fs::remove_file(destination).is_err() {
            return Err(format!(
                "无法删除原礼金库，且无法清理新副本；已保留原文件：{error}"
            ));
        }
        return Err(format!("无法删除原礼金库，已取消路径修改：{error}"));
    }
    Ok(())
}

fn automatic_backup_path(directory: &Path, prefix: &str) -> PathBuf {
    let timestamp = Local::now().format("%Y%m%d-%H%M%S-%3f");
    directory.join(format!("{prefix}-{timestamp}-{}.giftvault", Uuid::new_v4()))
}

fn prune_automatic_backups(directory: &Path, protected: Option<&Path>) -> Result<(), String> {
    if metadata_is_reparse(&std::fs::symlink_metadata(directory).map_err(|e| e.to_string())?) {
        return Err("备份目录是链接或重解析点，未执行轮换".to_string());
    }
    let root = directory.canonicalize().map_err(|e| e.to_string())?;
    let mut entries = Vec::new();
    for entry in std::fs::read_dir(&root).map_err(|e| e.to_string())? {
        let entry = entry.map_err(|e| e.to_string())?;
        let metadata = std::fs::symlink_metadata(entry.path()).map_err(|e| e.to_string())?;
        if metadata_is_reparse(&metadata) {
            continue;
        }
        let name = entry.file_name().to_string_lossy().to_string();
        if metadata.is_dir()
            && name.len() == 64
            && name.bytes().all(|byte| byte.is_ascii_hexdigit())
        {
            for child in std::fs::read_dir(entry.path()).map_err(|e| e.to_string())? {
                let child = child.map_err(|e| e.to_string())?;
                let metadata =
                    std::fs::symlink_metadata(child.path()).map_err(|e| e.to_string())?;
                if metadata.is_file() && !metadata_is_reparse(&metadata) {
                    entries.push(child);
                }
            }
        } else if metadata.is_file() {
            entries.push(entry);
        }
    }
    let mut backups = entries
        .into_iter()
        .filter(|entry| {
            let name = entry.file_name().to_string_lossy().to_string();
            entry.path().extension().and_then(|value| value.to_str()) == Some("giftvault")
                && !name.starts_with("manual-")
                && backup_timestamp(&name).is_some()
        })
        .collect::<Vec<_>>();
    // The reason prefix is not a chronological key. Legacy and current names
    // both contain YYYYMMDD-HHMMSS-mmm after their (possibly hyphenated) reason.
    backups.sort_by_key(|entry| {
        let name = entry.file_name().to_string_lossy().to_string();
        let timestamp = backup_timestamp(&name).unwrap_or_default();
        let modified = entry
            .metadata()
            .and_then(|metadata| metadata.modified())
            .unwrap_or(std::time::UNIX_EPOCH);
        std::cmp::Reverse((
            protected.is_some_and(|path| comparable_path(path) == comparable_path(&entry.path())),
            timestamp,
            modified,
            name,
        ))
    });
    for backup in backups.into_iter().skip(10) {
        let metadata = std::fs::symlink_metadata(backup.path()).map_err(|e| e.to_string())?;
        let target = backup.path().canonicalize().map_err(|e| e.to_string())?;
        if metadata_is_reparse(&metadata) || !target.starts_with(&root) {
            return Err("备份路径已改变或离开轮换目录，未删除文件".to_string());
        }
        std::fs::remove_file(target).map_err(|e| e.to_string())?;
    }
    Ok(())
}

fn metadata_is_reparse(metadata: &std::fs::Metadata) -> bool {
    #[cfg(windows)]
    {
        use std::os::windows::fs::MetadataExt;
        metadata.file_attributes() & 0x400 != 0
    }
    #[cfg(not(windows))]
    {
        metadata.file_type().is_symlink()
    }
}

fn reject_linked_backup_directory(path: &Path) -> Result<(), String> {
    match std::fs::symlink_metadata(path) {
        Ok(metadata) if metadata_is_reparse(&metadata) || !metadata.is_dir() => {
            Err("备份路径不是普通目录，已阻止写入".to_string())
        }
        Ok(_) => Ok(()),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(()),
        Err(error) => Err(error.to_string()),
    }
}

fn backup_timestamp(name: &str) -> Option<String> {
    name.as_bytes()
        .windows(15)
        .enumerate()
        .find_map(|(index, part)| {
            if part[8] != b'-'
                || !part[..8].iter().all(u8::is_ascii_digit)
                || !part[9..].iter().all(u8::is_ascii_digit)
            {
                return None;
            }
            let seconds = name.get(index..index + 15)?;
            NaiveDateTime::parse_from_str(seconds, "%Y%m%d-%H%M%S").ok()?;
            let milliseconds = name
                .get(index + 16..index + 19)
                .filter(|digits| {
                    name.get(index + 15..index + 16) == Some("-")
                        && digits.bytes().all(|byte| byte.is_ascii_digit())
                })
                .unwrap_or("000");
            Some(format!("{seconds}-{milliseconds}"))
        })
}

fn auto_backup_for_path(path: &Path, reason: &str, high_risk: bool) -> Result<(), String> {
    auto_backup_in_root(path, &app_backup_root(), reason, high_risk)
        .map_err(|error| format!("自动备份失败，已阻止写入：{error}"))
}

fn auto_backup_in_root(
    path: &Path,
    root: &Path,
    reason: &str,
    high_risk: bool,
) -> Result<(), String> {
    validate_vault_file(path)?;
    let connection = Connection::open(path).map_err(|e| e.to_string())?;
    let vault_id: Option<String> = connection
        .query_row(
            "SELECT value FROM vault_meta WHERE key = 'vault_id'",
            [],
            |row| row.get(0),
        )
        .optional()
        .map_err(|e| e.to_string())?;
    if vault_id
        .as_deref()
        .is_some_and(|value| Uuid::parse_str(value).is_err())
    {
        return Err("礼金库标识不是合法 UUID，无法安全创建自动备份，已阻止写入".to_string());
    }
    let key = vault_id.unwrap_or_else(|| {
        format!(
            "legacy-{:x}",
            Sha256::digest(comparable_path(path).as_bytes())
        )
    });
    if key.is_empty()
        || key.len() > 128
        || !key
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'-' | b'_'))
    {
        return Err("礼金库标识无效，无法安全创建自动备份，已阻止写入".to_string());
    }
    // Exported copies can intentionally retain the same vault_id. Their first
    // daily writes must have independent snapshots; never rewrite either ID.
    let canonical_source = path.canonicalize().map_err(|e| e.to_string())?;
    let source_key = format!(
        "{:x}",
        Sha256::digest(comparable_path(&canonical_source).as_bytes())
    );
    let family = root.join(key);
    let directory = family.join(source_key);
    for candidate in [root, family.as_path(), directory.as_path()] {
        reject_linked_backup_directory(candidate)?;
    }
    std::fs::create_dir_all(&directory).map_err(|e| e.to_string())?;
    let day = Local::now().format("%Y%m%d").to_string();
    let has_daily_backup = std::fs::read_dir(&directory)
        .map_err(|e| e.to_string())?
        .filter_map(Result::ok)
        .any(|entry| {
            entry
                .file_name()
                .to_string_lossy()
                .starts_with(&format!("daily-{day}"))
                && validate_vault_file(&entry.path()).is_ok()
        });
    if !high_risk && has_daily_backup {
        return Ok(());
    }
    let prefix = if high_risk { reason } else { "daily" };
    let destination = automatic_backup_path(&directory, prefix);
    snapshot_vault(path, &destination)?;
    prune_automatic_backups(&family, Some(&destination))?;
    validate_vault_file(&destination)
}

#[tauri::command]
fn choose_vault_path_named(
    mode: String,
    file_name: Option<String>,
    app: tauri::AppHandle,
) -> Option<String> {
    let mut dialog = file_dialog_for_app(&app).add_filter("礼金库", &["giftvault"]);
    if mode == "save" {
        dialog = dialog.set_file_name(
            file_name
                .as_deref()
                .filter(|name| !name.trim().is_empty())
                .unwrap_or("家庭礼金库.giftvault"),
        );
        dialog
            .save_file()
            .map(|path| path.to_string_lossy().to_string())
    } else {
        dialog
            .pick_file()
            .map(|path| path.to_string_lossy().to_string())
    }
}

#[tauri::command]
fn choose_vault_path(mode: String, app: tauri::AppHandle) -> Option<String> {
    choose_vault_path_named(mode, None, app)
}

fn is_comparison_spreadsheet(path: &Path) -> bool {
    path.extension()
        .and_then(|value| value.to_str())
        .is_some_and(|extension| {
            spreadsheet_extensions().contains(&extension.to_ascii_lowercase().as_str())
        })
}

fn is_giftvault_path(path: &Path) -> bool {
    path.extension()
        .and_then(|value| value.to_str())
        .is_some_and(|extension| extension.eq_ignore_ascii_case("giftvault"))
}

fn cached_comparison_spreadsheet(directory: &Path, source_path: &str) -> Option<PathBuf> {
    std::fs::read_dir(directory)
        .ok()?
        .filter_map(Result::ok)
        .map(|entry| entry.path())
        .filter(|path| is_giftvault_path(path))
        .find(|path| {
            let Ok(connection) =
                Connection::open_with_flags(path, OpenFlags::SQLITE_OPEN_READ_ONLY)
            else {
                return false;
            };
            connection
                .query_row(
                    "SELECT value FROM vault_meta WHERE key = 'comparison_source_path'",
                    [],
                    |row| row.get::<_, String>(0),
                )
                .ok()
                .is_some_and(|value| value == source_path)
        })
}

fn materialize_comparison_spreadsheet(path: &Path) -> Result<String, String> {
    let source_path = path.canonicalize().unwrap_or_else(|_| path.to_path_buf());
    let source_path_text = source_path.to_string_lossy().to_string();
    let directory = comparison_cache_directory();
    std::fs::create_dir_all(&directory).map_err(|error| error.to_string())?;
    if let Some(cached) = cached_comparison_spreadsheet(&directory, &source_path_text) {
        return Ok(cached.to_string_lossy().to_string());
    }

    let sheet = parse_sheet(path.to_str().unwrap_or_default())?;
    let analysis = analyze_sheet(&sheet);
    validate_spreadsheet_import(&analysis)?;
    let title = safe_excel_file_stem(&sheet.file_name);
    let destination = directory.join(format!("{}-{}.giftvault", title, Uuid::new_v4()));
    let result = (|| {
        let mut connection = Connection::open(&destination).map_err(|error| error.to_string())?;
        migrate(&connection)?;
        let timestamp = now();
        connection
            .execute(
                "INSERT OR REPLACE INTO vault_meta(key, value) VALUES ('name', ?), ('comparison_source_path', ?)",
                params![title, source_path_text],
            )
            .map_err(|error| error.to_string())?;
        let book_id = Uuid::new_v4().to_string();
        let mut catalog = load_tag_catalog(&connection)?;
        let transaction = connection
            .transaction()
            .map_err(|error| error.to_string())?;
        transaction
            .execute(
                "INSERT INTO gift_books(id, title, occasion, created_at, updated_at, source_file_name, source_file_path, source_imported_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
                params![book_id, title, "导入表格", timestamp, timestamp, sheet.file_name, source_path_text, timestamp],
            )
            .map_err(|error| error.to_string())?;
        import_sheet_into_transaction(&transaction, &sheet, &analysis, &book_id, &mut catalog)?;
        transaction.commit().map_err(|error| error.to_string())?;
        Ok(destination.to_string_lossy().to_string())
    })();
    if result.is_err() {
        let _ = std::fs::remove_file(&destination);
    }
    result
}

#[tauri::command(async)]
fn choose_comparison_vault_paths(app: tauri::AppHandle) -> Result<Vec<String>, String> {
    let _operation = begin_operation()?;
    let dialog = desktop_directory(&app)
        .map(|directory| FileDialog::new().set_directory(directory))
        .unwrap_or_else(default_file_dialog);
    let selected = dialog
        .add_filter(
            "礼金库或表格",
            &[
                "giftvault",
                "xlsx",
                "xls",
                "xlsm",
                "xlsb",
                "ods",
                "csv",
                "tsv",
            ],
        )
        .pick_files()
        .unwrap_or_default();
    let mut paths = Vec::with_capacity(selected.len());
    for path in selected {
        if is_giftvault_path(&path) {
            paths.push(path.to_string_lossy().to_string());
        } else if is_comparison_spreadsheet(&path) {
            paths.push(materialize_comparison_spreadsheet(&path)?);
        } else {
            return Err(format!("不支持的比较文件类型：{}", path.display()));
        }
    }
    Ok(paths)
}

#[tauri::command]
async fn local_update_status(app: tauri::AppHandle) -> Result<LocalUpdateStatus, String> {
    let directory = ensure_published_update_directory(&app)?;
    if let Some(candidate) = local_update_candidate(&app)?.map(|(candidate, _)| candidate) {
        return Ok(LocalUpdateStatus {
            current_version: APP_VERSION.to_string(),
            update_directory: directory.to_string_lossy().to_string(),
            candidate: Some(candidate),
            source: "local".to_string(),
            error: None,
        });
    }
    Ok(LocalUpdateStatus {
        current_version: APP_VERSION.to_string(),
        update_directory: directory.to_string_lossy().to_string(),
        candidate: None,
        source: "local".to_string(),
        error: None,
    })
}

#[tauri::command]
async fn official_release_status(app: tauri::AppHandle) -> Result<LocalUpdateStatus, String> {
    let local = local_update_status(app).await?;
    if local.candidate.is_some() {
        return Ok(local);
    }
    let (candidate, error) = match github_update_candidate().await {
        Ok(candidate) => (candidate, None),
        Err(error) => (None, Some(error)),
    };
    Ok(LocalUpdateStatus {
        candidate,
        error,
        source: "github".into(),
        ..local
    })
}

#[tauri::command]
fn open_local_update_directory(app: tauri::AppHandle) -> Result<(), String> {
    let directory = ensure_published_update_directory(&app)?;
    Command::new("explorer.exe")
        .arg(directory)
        .spawn()
        .map_err(|e| format!("无法打开更新目录: {e}"))?;
    Ok(())
}

fn local_update_launcher_script(
    installer: &Path,
    installed_application: &Path,
    fallback_application: &Path,
    old_process_id: u32,
    log_path: &Path,
    expected_hash: &str,
) -> String {
    let installer = powershell_path_literal(installer);
    let installed_application = powershell_path_literal(installed_application);
    let fallback_application = powershell_path_literal(fallback_application);
    let log_path = powershell_path_literal(log_path);
    format!(
        r#"$ErrorActionPreference = 'Stop'
$installer = {installer}
$installedApplication = {installed_application}
$fallbackApplication = {fallback_application}
$oldProcessId = {old_process_id}
$log = {log_path}
$exitCode = 1
$installerGuard = $null
try {{
  $deadline = [DateTime]::UtcNow.AddSeconds(15)
  while ((Get-Process -Id $oldProcessId -ErrorAction SilentlyContinue) -and ([DateTime]::UtcNow -lt $deadline)) {{
    Start-Sleep -Milliseconds 100
  }}
  if (Get-Process -Id $oldProcessId -ErrorAction SilentlyContinue) {{
    throw 'The previous application process did not exit in time.'
  }}
  $installerGuard = [System.IO.File]::Open($installer, [System.IO.FileMode]::Open, [System.IO.FileAccess]::Read, [System.IO.FileShare]::Read)
  if ((Get-FileHash -LiteralPath $installer -Algorithm SHA256).Hash -ne '{expected_hash}') {{
    throw 'Prepared installer integrity check failed.'
  }}
  $installDirectory = Split-Path -Parent $installedApplication
  $process = Start-Process -FilePath $installer -ArgumentList @('/S', "/D=$installDirectory") -Wait -PassThru -WindowStyle Hidden
  $exitCode = $process.ExitCode
  Add-Content -LiteralPath $log -Value "$(Get-Date -Format o) installer exit code: $exitCode"
  if ($exitCode -ne 0) {{
    throw "The installer exited with code $exitCode."
  }}
}} catch {{
  $exitCode = 1
  Add-Content -LiteralPath $log -Value "$(Get-Date -Format o) updater error: $($_.Exception.Message)"
}} finally {{
  if ($installerGuard) {{ $installerGuard.Dispose() }}
  $launchTarget = if ($exitCode -eq 0) {{ $installedApplication }} else {{ $fallbackApplication }}
  if (!(Test-Path -LiteralPath $launchTarget)) {{
    $launchTarget = if ($exitCode -eq 0) {{ $fallbackApplication }} else {{ $installedApplication }}
  }}
  if (Test-Path -LiteralPath $launchTarget) {{
    try {{
      Start-Process -FilePath $launchTarget
      Add-Content -LiteralPath $log -Value "$(Get-Date -Format o) started application: $launchTarget"
    }} catch {{
      Add-Content -LiteralPath $log -Value "$(Get-Date -Format o) application start error: $($_.Exception.Message)"
    }}
  }} else {{
    Add-Content -LiteralPath $log -Value "$(Get-Date -Format o) application not found: $installedApplication; fallback: $fallbackApplication"
  }}
}}
exit $exitCode
"#
    )
}

fn windows_powershell_script_bytes(script: &str) -> Vec<u8> {
    // Windows PowerShell 5.1 treats UTF-8 without a BOM as the local ANSI code page.
    // The updater paths contain Chinese characters, so use its unambiguous UTF-16LE format.
    let mut bytes = vec![0xff, 0xfe];
    for code_unit in script.encode_utf16() {
        bytes.extend_from_slice(&code_unit.to_le_bytes());
    }
    bytes
}

fn launch_local_update(
    installer: &Path,
    installed_application: &Path,
    fallback_application: &Path,
    expected_hash: &str,
) -> Result<(), String> {
    // A separate script waits for the app to exit before NSIS replaces its executable.
    let directory = update_runtime_directory();
    std::fs::create_dir_all(&directory).map_err(|e| e.to_string())?;
    let script_path = directory.join("apply-update.ps1");
    let log_path = directory.join("last-update.log");
    std::fs::write(
        &script_path,
        windows_powershell_script_bytes(&local_update_launcher_script(
            installer,
            installed_application,
            fallback_application,
            std::process::id(),
            &log_path,
            expected_hash,
        )),
    )
    .map_err(|e| format!("无法写入本地更新脚本: {e}"))?;
    hidden_windows_command("powershell.exe")
        .args([
            "-NoProfile",
            "-NonInteractive",
            "-ExecutionPolicy",
            "Bypass",
            "-File",
        ])
        .arg(script_path)
        .spawn()
        .map_err(|e| format!("无法启动本地更新进程: {e}"))?;
    Ok(())
}

#[tauri::command(async)]
fn start_local_update(app: tauri::AppHandle) -> Result<(), String> {
    let _operation = begin_operation()?;
    let (candidate, _) = local_update_candidate(&app)?
        .ok_or("未检测到更高版本的礼金簿—改动本地安装包；原版官方信息不提供改动版安装")?;
    let directory = published_update_directory(&app);
    let (installer, expected_hash) = update_security::prepare_installer(
        &directory,
        &candidate.file_name,
        APP_VERSION,
        &update_runtime_directory(),
    )?;
    let application = std::env::current_exe().map_err(|e| format!("无法确定当前程序位置: {e}"))?;
    if !application
        .parent()
        .is_some_and(|directory| directory.join("uninstall.exe").is_file())
    {
        return Err("便携运行请手动下载安装包".into());
    }
    let installed_application = application.clone();
    launch_local_update(
        &installer,
        &installed_application,
        &application,
        &expected_hash,
    )
    .map_err(|e| format!("无法启动 v{} 更新安装包: {e}", candidate.version))?;
    app.exit(0);
    Ok(())
}

#[tauri::command]
fn settings_storage_info(app: tauri::AppHandle) -> SettingsStorageInfo {
    let settings = read_app_settings(&app);
    let configured = settings.data_directory.is_some();
    let directory = settings.data_directory.unwrap_or_else(|| {
        desktop_directory(&app)
            .or_else(|| app.path().document_dir().ok())
            .unwrap_or_else(|| std::env::current_dir().unwrap_or_else(|_| PathBuf::from(".")))
            .to_string_lossy()
            .to_string()
    });
    SettingsStorageInfo {
        directory,
        configured,
    }
}

#[tauri::command(async)]
fn choose_settings_directory(app: tauri::AppHandle) -> Result<Option<SettingsStorageInfo>, String> {
    let _operation = begin_operation()?;
    let dialog = desktop_directory(&app)
        .map(|directory| FileDialog::new().set_directory(directory))
        .unwrap_or_else(default_file_dialog);
    let Some(directory) = dialog.pick_folder() else {
        return Ok(None);
    };
    let directory = displayable_path(&directory);
    write_app_settings(
        &app,
        &AppSettings {
            data_directory: Some(directory.clone()),
        },
    )?;
    Ok(Some(SettingsStorageInfo {
        directory,
        configured: true,
    }))
}

#[tauri::command(async)]
fn create_vault(
    path: String,
    name: String,
    notes: String,
    state: State<'_, AppState>,
) -> Result<VaultOpenResult, String> {
    let _operation = begin_operation()?;
    require_admin(&state)?;
    if name.trim().is_empty() {
        return Err("礼金库名称不能为空".to_string());
    }
    let path = normalize_vault_path(&path);
    if path.exists() {
        return Err("目标礼金库已存在，请选择其他文件名".to_string());
    }
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent).map_err(|e| e.to_string())?;
    }
    create_vault_file(&path, &name, &notes)?;
    let path = path.canonicalize().map_err(|e| e.to_string())?;
    let connection = Connection::open_with_flags(&path, OpenFlags::SQLITE_OPEN_READ_ONLY)
        .map_err(|e| e.to_string())?;
    *state
        .vault_path
        .lock()
        .map_err(|_| "礼金库状态不可用".to_string())? = Some(path.clone());
    remember_opened_vault_path(&state, &path)?;
    vault_open_result(&path, &connection, SessionRole::Admin)
}

fn create_vault_file(path: &Path, name: &str, notes: &str) -> Result<(), String> {
    validate_text("礼金库名称", name, 256)?;
    validate_text("礼金库备注", notes, 65536)?;
    if name.trim().is_empty() {
        return Err("礼金库名称不能为空".to_string());
    }
    publish_vault_file(path, |temporary| {
        let temporary = temporary
            .canonicalize()
            .map_err(|error| error.to_string())?;
        let mut connection = Connection::open(temporary).map_err(|e| e.to_string())?;
        migrate(&connection)?;
        let transaction = connection.transaction().map_err(|e| e.to_string())?;
        transaction
            .execute(
                "INSERT OR REPLACE INTO vault_meta(key,value) VALUES ('name',?), ('notes',?)",
                params![name.trim(), notes.trim()],
            )
            .map_err(|e| e.to_string())?;
        transaction.commit().map_err(|e| e.to_string())
    })
}

#[tauri::command(async)]
fn edit_vault(
    name: String,
    notes: String,
    path: String,
    vault_path: String,
    state: State<'_, AppState>,
) -> Result<VaultInfo, String> {
    let _operation = begin_operation()?;
    if name.trim().is_empty() {
        return Err("礼金库名称不能为空".to_string());
    }
    let source = canonical_opened_vault_path(&state, Some(&vault_path))?;
    let destination = normalize_vault_path(&path);
    let path_changed = comparable_path(&source) != comparable_path(&destination);
    if path_changed && destination.exists() {
        return Err("目标礼金库已存在，请选择其他位置或文件名".to_string());
    }
    if path_changed {
        let destination_key = comparable_path(&destination);
        if opened_vault_paths(&state)?
            .iter()
            .any(|opened| comparable_path(opened) == destination_key)
        {
            return Err("目标路径已在当前工作区打开，请先关闭该礼金库".to_string());
        }
        auto_backup_for_path(&source, "move", true)?;
    }
    let mut connection = admin_connection(&state, &vault_path, "edit-vault", false)?;
    let transaction = connection
        .transaction()
        .map_err(|error| error.to_string())?;
    let old_name: String = transaction
        .query_row(
            "SELECT value FROM vault_meta WHERE key = 'name'",
            [],
            |row| row.get(0),
        )
        .map_err(|error| error.to_string())?;
    let old_notes: String = transaction
        .query_row(
            "SELECT value FROM vault_meta WHERE key = 'notes'",
            [],
            |row| row.get(0),
        )
        .optional()
        .map_err(|error| error.to_string())?
        .unwrap_or_default();
    if name != old_name {
        validate_text("礼金库名称", &name, 256)?;
    }
    if notes != old_notes {
        validate_text("礼金库备注", &notes, 65536)?;
    }
    let next_name = name.trim().to_string();
    let next_notes = notes.trim().to_string();
    let mut changes = Vec::new();
    if old_name != next_name {
        changes.push(machine_change("礼金库名称", "name", &old_name, &next_name));
    }
    if old_notes != next_notes {
        changes.push(machine_change(
            "礼金库备注",
            "notes",
            &old_notes,
            &next_notes,
        ));
    }
    if path_changed {
        changes.push(machine_change(
            "礼金库路径",
            "path",
            displayable_path(&source),
            displayable_path(&destination),
        ));
    }
    transaction
        .execute(
            "INSERT OR REPLACE INTO vault_meta(key, value) VALUES ('name', ?), ('notes', ?)",
            params![next_name, next_notes],
        )
        .map_err(|error| error.to_string())?;
    if !changes.is_empty() {
        let vault_id = transaction
            .query_row(
                "SELECT value FROM vault_meta WHERE key = 'vault_id'",
                [],
                |row| row.get::<_, String>(0),
            )
            .map_err(|error| error.to_string())?;
        write_audit_detail(
            &transaction,
            "update",
            "vault",
            &vault_id,
            AuditPayload {
                person_id: None,
                target: next_name,
                book_title: None,
                description: "编辑礼金库信息".to_string(),
                changes,
            },
        )?;
    }
    transaction.commit().map_err(|error| error.to_string())?;
    drop(connection);
    if path_changed {
        move_vault_file(&source, &destination)?;
        {
            let mut opened = state
                .opened_vault_paths
                .lock()
                .map_err(|_| "礼金库打开状态不可用".to_string())?;
            for opened_path in opened.iter_mut() {
                if comparable_path(opened_path) == comparable_path(&source) {
                    *opened_path = destination.clone();
                }
            }
        }
        *state
            .vault_path
            .lock()
            .map_err(|_| "礼金库状态不可用".to_string())? = Some(destination.clone());
    }
    let result_path = if path_changed { &destination } else { &source };
    let connection = Connection::open_with_flags(result_path, OpenFlags::SQLITE_OPEN_READ_ONLY)
        .map_err(|error| error.to_string())?;
    vault_info(result_path, &connection)
}

#[tauri::command]
fn current_vault_info(vault_path: String, state: State<'_, AppState>) -> Result<VaultInfo, String> {
    let path = canonical_opened_vault_path(&state, Some(&vault_path))?;
    let connection = scoped_read_connection(&state, &vault_path)?;
    vault_info(&path, &connection)
}

#[tauri::command(async)]
fn open_vault(path: String, state: State<'_, AppState>) -> Result<VaultOpenResult, String> {
    let _operation = begin_operation()?;
    let path = PathBuf::from(path);
    if !path.is_file() {
        return Err("找不到礼金库文件".to_string());
    }
    let path = path.canonicalize().map_err(|error| error.to_string())?;
    let role = if is_admin_session(&state)? {
        SessionRole::Admin
    } else {
        SessionRole::Viewer
    };
    let mut connection = if role == SessionRole::Admin {
        Connection::open(&path).map_err(|e| e.to_string())?
    } else {
        Connection::open_with_flags(&path, OpenFlags::SQLITE_OPEN_READ_ONLY)
            .map_err(|e| e.to_string())?
    };
    let has_meta: bool = connection.query_row("SELECT EXISTS(SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'vault_meta')", [], |row| row.get(0)).map_err(|e| e.to_string())?;
    if !has_meta {
        return Err("这不是礼金簿创建的礼金库文件".to_string());
    }
    validate_vault_connection(&connection)?;
    let version: i32 = connection
        .pragma_query_value(None, "user_version", |row| row.get(0))
        .map_err(|e| e.to_string())?;
    let needs_migration = version < CURRENT_SCHEMA || table_exists(&connection, "vault_security")?;
    if role == SessionRole::Admin && needs_migration {
        drop(connection);
        migrate_vault_if_needed(&path)?;
        connection = Connection::open(&path).map_err(|e| e.to_string())?;
        configure_connection(&connection)?;
    } else if role == SessionRole::Admin {
        // Existing databases may have been created with WAL by older versions.
        // Normalize the mode on every admin open so stale sidecar files are released.
        configure_connection(&connection)?;
    } else if role == SessionRole::Viewer && version < 3 {
        return Err("该礼金库需要由管理员模式打开一次完成升级后才能只读查看".to_string());
    }
    *state
        .vault_path
        .lock()
        .map_err(|_| "礼金库状态不可用".to_string())? = Some(path.clone());
    remember_opened_vault_path(&state, &path)?;
    let result = vault_open_result(&path, &connection, role);
    drop(connection);
    cleanup_sqlite_sidecars(&path);
    result
}

#[tauri::command(async)]
fn close_vault(state: State<'_, AppState>) -> Result<(), String> {
    let _operation = begin_operation()?;
    *state
        .vault_path
        .lock()
        .map_err(|_| "礼金库状态不可用".to_string())? = None;
    clear_opened_vault_paths(&state)?;
    Ok(())
}

#[tauri::command(async)]
fn close_opened_vault(vault_path: String, state: State<'_, AppState>) -> Result<(), String> {
    with_operation(|| close_opened_vault_path(&state, Path::new(&vault_path)))
}

fn close_opened_vault_path(state: &AppState, path: &Path) -> Result<(), String> {
    let path = path.canonicalize().unwrap_or_else(|_| path.to_path_buf());
    let key = comparable_path(&path);
    let mut active = state
        .vault_path
        .lock()
        .map_err(|_| "礼金库状态不可用".to_string())?;
    let mut opened = state
        .opened_vault_paths
        .lock()
        .map_err(|_| "礼金库打开状态不可用".to_string())?;
    // A workspace session is a whole vault, never an individual gift book.
    // Removing it therefore closes every book that belongs to this vault.
    opened.retain(|item| comparable_path(item) != key);
    if active.as_ref().is_some_and(|item| {
        comparable_path(&item.canonicalize().unwrap_or_else(|_| item.clone())) == key
    }) {
        *active = opened.last().cloned();
    }
    if opened.is_empty() {
        *active = None;
    }
    Ok(())
}

#[tauri::command(async)]
fn return_to_start_page(state: State<'_, AppState>) -> Result<(), String> {
    let _operation = begin_operation()?;
    *state
        .vault_path
        .lock()
        .map_err(|_| "礼金库状态不可用".to_string())? = None;
    clear_opened_vault_paths(&state)?;
    Ok(())
}

#[tauri::command(async)]
fn session_status(state: State<'_, AppState>) -> Result<SessionStatus, String> {
    let session = state
        .session
        .lock()
        .map_err(|_| "管理员会话不可用".to_string())?;
    let role = if session.role == SessionRole::Admin {
        "admin"
    } else {
        "viewer"
    };
    Ok(SessionStatus {
        role: role.to_string(),
        security_configured: state.security.configured()?,
        edit_locked: session.edit_locked,
    })
}

#[tauri::command(async)]
fn get_app_security_status(state: State<'_, AppState>) -> Result<SessionStatus, String> {
    session_status(state)
}

#[tauri::command(async)]
fn setup_app_admin_pin(pin: String, state: State<'_, AppState>) -> Result<String, String> {
    let _operation = begin_operation()?;
    let recovery_code = state.security.setup_pin(&pin)?;
    set_admin_session(&state)?;
    Ok(recovery_code)
}

fn authentication_attempt<T>(
    state: &AppState,
    verify: impl FnOnce() -> Result<T, String>,
) -> Result<T, String> {
    let mut session = state
        .session
        .lock()
        .map_err(|_| "管理员会话不可用".to_string())?;
    if session
        .locked_until
        .is_some_and(|until| until > Instant::now())
    {
        return Err("凭据尝试次数过多，请稍后再试".to_string());
    }
    match verify() {
        Ok(value) => {
            session.failed_attempts = 0;
            session.locked_until = None;
            Ok(value)
        }
        Err(error) => {
            session.failed_attempts = session.failed_attempts.saturating_add(1);
            if session.failed_attempts >= MAX_LOGIN_ATTEMPTS {
                session.failed_attempts = 0;
                session.locked_until = Some(Instant::now() + LOGIN_COOLDOWN);
            }
            Err(error)
        }
    }
}

fn verify_pin_for_operation(state: &AppState, pin: &str) -> Result<(), String> {
    authentication_attempt(state, || {
        validate_pin(pin)?;
        if state.security.verify_pin(pin)? {
            Ok(())
        } else {
            Err("管理员 PIN 不正确".to_string())
        }
    })
}

fn authorize_empty_trash(state: &AppState, pin: &str) -> Result<(), String> {
    require_admin(state)?;
    if is_edit_locked(state)? {
        return Err("编辑已锁定，请先解锁编辑".to_string());
    }
    verify_pin_for_operation(state, pin)
}

#[tauri::command(async)]
fn unlock_admin(pin: String, state: State<'_, AppState>) -> Result<(), String> {
    let _operation = begin_operation()?;
    verify_pin_for_operation(&state, &pin)?;
    set_admin_session(&state)
}

#[tauri::command(async)]
fn lock_admin(state: State<'_, AppState>) -> Result<(), String> {
    with_operation(|| reset_session(&state))
}

#[tauri::command(async)]
fn unlock_editing(state: State<'_, AppState>) -> Result<(), String> {
    let _operation = begin_operation()?;
    require_admin(&state)?;
    set_edit_locked(&state, false)
}

#[tauri::command(async)]
fn lock_editing(state: State<'_, AppState>) -> Result<(), String> {
    let _operation = begin_operation()?;
    require_admin(&state)?;
    set_edit_locked(&state, true)
}

#[tauri::command]
fn exit_app(app: tauri::AppHandle) {
    app.exit(0);
}

#[tauri::command(async)]
fn reset_app_pin_with_recovery(
    recovery: String,
    new_pin: String,
    state: State<'_, AppState>,
) -> Result<String, String> {
    let _operation = begin_operation()?;
    let replacement_recovery = authentication_attempt(&state, || {
        state.security.reset_with_recovery(&recovery, &new_pin)
    })?;
    set_admin_session(&state)?;
    Ok(replacement_recovery)
}

#[tauri::command(async)]
fn change_app_admin_pin(
    old_pin: String,
    new_pin: String,
    state: State<'_, AppState>,
) -> Result<String, String> {
    let _operation = begin_operation()?;
    require_admin(&state)?;
    let replacement_recovery =
        authentication_attempt(&state, || state.security.change_pin(&old_pin, &new_pin))?;
    set_admin_session(&state)?;
    Ok(replacement_recovery)
}

#[tauri::command]
fn list_books(vault_path: String, state: State<'_, AppState>) -> Result<Vec<GiftBook>, String> {
    let connection = scoped_read_connection(&state, &vault_path)?;
    let mut statement = connection.prepare("SELECT id, title, occasion, event_date, location, notes, created_at, source_file_name, source_file_path, source_imported_at FROM gift_books WHERE deleted_at IS NULL ORDER BY COALESCE(event_date, created_at) DESC").map_err(|e| e.to_string())?;
    let rows = statement
        .query_map([], |row| {
            Ok(GiftBook {
                id: row.get(0)?,
                title: row.get(1)?,
                occasion: row.get(2)?,
                event_date: row.get(3)?,
                location: row.get(4)?,
                notes: row.get(5)?,
                created_at: row.get(6)?,
                source_file_name: row.get(7)?,
                source_file_path: row
                    .get::<_, Option<String>>(8)?
                    .map(|path| displayable_path(Path::new(&path))),
                source_imported_at: row.get(9)?,
            })
        })
        .map_err(|e| e.to_string())?;
    rows.collect::<Result<Vec<_>, _>>()
        .map_err(|e| e.to_string())
}

#[tauri::command]
fn list_books_for_vault(
    vault_path: String,
    state: State<'_, AppState>,
) -> Result<Vec<GiftBook>, String> {
    let path = canonical_opened_vault_path(&state, Some(&vault_path))?;
    let connection = Connection::open_with_flags(&path, OpenFlags::SQLITE_OPEN_READ_ONLY)
        .map_err(|e| e.to_string())?;
    configure_read_connection(&connection)?;
    let mut statement = connection
        .prepare("SELECT id, title, occasion, event_date, location, notes, created_at, source_file_name, source_file_path, source_imported_at FROM gift_books WHERE deleted_at IS NULL ORDER BY COALESCE(event_date, created_at) DESC")
        .map_err(|e| e.to_string())?;
    let rows = statement
        .query_map([], |row| {
            Ok(GiftBook {
                id: row.get(0)?,
                title: row.get(1)?,
                occasion: row.get(2)?,
                event_date: row.get(3)?,
                location: row.get(4)?,
                notes: row.get(5)?,
                created_at: row.get(6)?,
                source_file_name: row.get(7)?,
                source_file_path: row
                    .get::<_, Option<String>>(8)?
                    .map(|path| displayable_path(Path::new(&path))),
                source_imported_at: row.get(9)?,
            })
        })
        .map_err(|e| e.to_string())?;
    rows.collect::<Result<Vec<_>, _>>()
        .map_err(|e| e.to_string())
}

#[tauri::command(async)]
fn create_book(
    title: String,
    occasion: String,
    event_date: String,
    location: String,
    notes: String,
    vault_path: String,
    state: State<'_, AppState>,
) -> Result<GiftBook, String> {
    let _operation = begin_operation()?;
    for (label, value, max) in [
        ("礼金簿名称", &title, 256),
        ("活动类型", &occasion, 256),
        ("地点", &location, 4096),
        ("备注", &notes, 65536),
    ] {
        validate_text(label, value, max)?;
    }
    validate_date(&event_date, true)?;
    if title.trim().is_empty() {
        return Err("礼金簿名称不能为空".to_string());
    }
    let mut connection = admin_connection(&state, &vault_path, "create-book", false)?;
    let transaction = connection.transaction().map_err(|e| e.to_string())?;
    let id = Uuid::new_v4().to_string();
    let timestamp = now();
    transaction.execute("INSERT INTO gift_books(id, title, occasion, event_date, location, notes, created_at, updated_at, source_file_name, source_file_path, source_imported_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, NULL, NULL, NULL)", params![id, title.trim(), occasion.trim(), null_if_empty(&event_date), null_if_empty(&location), null_if_empty(&notes), timestamp, timestamp]).map_err(|e| e.to_string())?;
    write_audit_detail(
        &transaction,
        "create",
        "gift_book",
        &id,
        AuditPayload {
            person_id: None,
            target: title.trim().to_string(),
            book_title: Some(title.trim().to_string()),
            description: "新建礼金簿".to_string(),
            changes: Vec::new(),
        },
    )?;
    transaction.commit().map_err(|e| e.to_string())?;
    Ok(GiftBook {
        id,
        title: title.trim().to_string(),
        occasion: occasion.trim().to_string(),
        event_date: null_if_empty(&event_date),
        location: null_if_empty(&location),
        notes: null_if_empty(&notes),
        created_at: timestamp,
        source_file_name: None,
        source_file_path: None,
        source_imported_at: None,
    })
}

#[tauri::command(async)]
fn edit_book(
    book_id: String,
    input: EditBookInput,
    vault_path: String,
    state: State<'_, AppState>,
) -> Result<GiftBook, String> {
    let _operation = begin_operation()?;
    if input.title.trim().is_empty() {
        return Err("礼金簿名称不能为空".to_string());
    }

    let mut connection = admin_connection(&state, &vault_path, "edit-book", false)?;
    let transaction = connection
        .transaction()
        .map_err(|error| error.to_string())?;
    let existing = transaction
    .query_row(
        "SELECT title, occasion, event_date, location, notes, created_at, source_file_name, source_file_path, source_imported_at
         FROM gift_books WHERE id = ? AND deleted_at IS NULL",
        params![book_id],
        |row| {
            Ok(GiftBook {
                id: book_id.clone(),
                title: row.get(0)?,
                occasion: row.get(1)?,
                event_date: row.get(2)?,
                location: row.get(3)?,
                notes: row.get(4)?,
                created_at: row.get(5)?,
                source_file_name: row.get(6)?,
                source_file_path: row.get(7)?,
                source_imported_at: row.get(8)?,
            })
        },
    )
    .optional()
    .map_err(|error| error.to_string())?
    .ok_or_else(|| "礼金簿不存在或已移入回收站".to_string())?;

    for (label, value, previous, max) in [
        (
            "礼金簿名称",
            input.title.as_str(),
            existing.title.as_str(),
            256,
        ),
        (
            "活动类型",
            input.occasion.as_str(),
            existing.occasion.as_str(),
            256,
        ),
        (
            "地点",
            input.location.as_str(),
            existing.location.as_deref().unwrap_or_default(),
            4096,
        ),
        (
            "备注",
            input.notes.as_str(),
            existing.notes.as_deref().unwrap_or_default(),
            65536,
        ),
    ] {
        if value != previous {
            validate_text(label, value, max)?;
        }
    }
    if input.event_date != existing.event_date.as_deref().unwrap_or_default() {
        validate_date(&input.event_date, true)?;
    }
    let title = input.title.trim().to_string();
    let occasion = input.occasion.trim().to_string();
    let event_date = null_if_empty(&input.event_date);
    let location = null_if_empty(&input.location);
    let notes = null_if_empty(&input.notes);
    let mut changes = Vec::new();
    if existing.title != title {
        changes.push(machine_change(
            "礼金簿名称",
            "title",
            &existing.title,
            &title,
        ));
    }
    if existing.occasion != occasion {
        changes.push(machine_change(
            "活动类型",
            "occasion",
            &existing.occasion,
            &occasion,
        ));
    }
    if existing.event_date != event_date {
        changes.push(machine_change(
            "活动日期",
            "event_date",
            &existing.event_date,
            &event_date,
        ));
    }
    if existing.location != location {
        changes.push(machine_change(
            "地点",
            "location",
            &existing.location,
            &location,
        ));
    }
    if existing.notes != notes {
        changes.push(machine_change("备注", "notes", &existing.notes, &notes));
    }

    transaction
    .execute(
        "UPDATE gift_books SET title = ?, occasion = ?, event_date = ?, location = ?, notes = ?, updated_at = ? WHERE id = ? AND deleted_at IS NULL",
        params![title, occasion, event_date, location, notes, now(), book_id],
    )
    .map_err(|error| error.to_string())?;

    if !changes.is_empty() {
        write_audit_detail(
            &transaction,
            "update",
            "gift_book",
            &book_id,
            AuditPayload {
                person_id: None,
                target: title.clone(),
                book_title: Some(title.clone()),
                description: "编辑礼金簿信息".to_string(),
                changes,
            },
        )?;
    }
    transaction.commit().map_err(|error| error.to_string())?;

    Ok(GiftBook {
        id: book_id,
        title,
        occasion,
        event_date,
        location,
        notes,
        created_at: existing.created_at,
        source_file_name: existing.source_file_name,
        source_file_path: existing.source_file_path,
        source_imported_at: existing.source_imported_at,
    })
}

#[tauri::command(async)]
fn restore_book(
    book_id: String,
    vault_path: String,
    state: State<'_, AppState>,
) -> Result<(), String> {
    let _operation = begin_operation()?;
    let mut connection = admin_connection(&state, &vault_path, "restore-book", false)?;
    restore_book_record(&mut connection, &book_id)
}

fn restore_book_record(connection: &mut Connection, book_id: &str) -> Result<(), String> {
    let transaction = connection.transaction().map_err(|e| e.to_string())?;
    let title = audit_book_title(&transaction, book_id)?;
    let timestamp = now();
    let changed = transaction
        .execute(
            "UPDATE gift_books SET deleted_at = NULL, updated_at = ? WHERE id = ? AND deleted_at IS NOT NULL",
            params![timestamp, book_id],
        )
        .map_err(|e| e.to_string())?;
    if changed == 0 {
        return Err("礼金簿不存在或未在回收站中".to_string());
    }
    write_audit_detail(
        &transaction,
        "restore",
        "gift_book",
        book_id,
        AuditPayload {
            person_id: None,
            target: title.clone(),
            book_title: Some(title),
            description: "从回收站恢复".to_string(),
            changes: Vec::new(),
        },
    )?;
    transaction.commit().map_err(|e| e.to_string())
}

fn null_if_empty(value: &str) -> Option<String> {
    let value = value.trim();
    (!value.is_empty()).then(|| value.to_string())
}

// Twelve decimal digits in fen keep both JS integers and Excel's 15-digit
// numeric cells accurate. New inputs and totals reject larger values explicitly.
const MAX_SAFE_FEN: i64 = 999_999_999_999;

fn checked_money_total(amounts: impl IntoIterator<Item = i64>) -> Result<i64, String> {
    amounts.into_iter().try_fold(0_i64, |total, amount| {
        total
            .checked_add(amount)
            .filter(|sum| (-MAX_SAFE_FEN..=MAX_SAFE_FEN).contains(sum))
            .ok_or_else(|| format!("金额合计超过安全范围 {MAX_SAFE_FEN} 分，无法准确显示或导出"))
    })
}

fn validate_amount(amount: i64) -> Result<(), String> {
    if !(1..=MAX_SAFE_FEN).contains(&amount) {
        return Err(format!("金额必须在 1 到 {MAX_SAFE_FEN} 分之间"));
    }
    Ok(())
}

fn read_money_fen(row: &rusqlite::Row<'_>, index: usize) -> rusqlite::Result<i64> {
    let amount: i64 = row.get(index)?;
    if !(-MAX_SAFE_FEN..=MAX_SAFE_FEN).contains(&amount) {
        return Err(rusqlite::Error::InvalidParameterName(format!(
            "金额或合计超过安全范围 {MAX_SAFE_FEN} 分，无法准确显示或导出"
        )));
    }
    Ok(amount)
}

fn read_optional_money_fen(row: &rusqlite::Row<'_>, index: usize) -> rusqlite::Result<Option<i64>> {
    let amount: Option<i64> = row.get(index)?;
    if amount.is_some_and(|amount| !(-MAX_SAFE_FEN..=MAX_SAFE_FEN).contains(&amount)) {
        return Err(rusqlite::Error::InvalidParameterName(
            "回礼金额超过安全范围，无法准确显示或导出".to_string(),
        ));
    }
    Ok(amount)
}

fn ensure_money_totals_safe(connection: &Connection) -> Result<(), String> {
    connection.query_row(
        "SELECT COALESCE(SUM(e.amount_fen),0), COALESCE(SUM(e.return_gift_amount_fen),0) FROM gift_entries e JOIN gift_books b ON b.id=e.book_id JOIN people p ON p.id=e.person_id WHERE e.deleted_at IS NULL AND b.deleted_at IS NULL AND p.deleted_at IS NULL",
        [], |row| { read_money_fen(row,0)?; read_money_fen(row,1)?; Ok(()) },
    ).map_err(|e| format!("金额合计无法准确显示或导出：{e}"))
}

fn validate_text(label: &str, value: &str, maximum: usize) -> Result<(), String> {
    if value.chars().count() > maximum || value.contains('\0') {
        return Err(format!("{label}最多 {maximum} 个字符且不能包含空字符"));
    }
    Ok(())
}

fn validate_date(value: &str, allow_empty: bool) -> Result<(), String> {
    if value.trim().is_empty() && allow_empty {
        return Ok(());
    }
    let normalized = normalize_imported_received_at(value);
    if NaiveDateTime::parse_from_str(&normalized, "%Y-%m-%d %H:%M:%S").is_err() {
        return Err(format!("日期无法识别：{value}"));
    }
    Ok(())
}

fn validate_import_row(row: &[String], analysis: &SheetAnalysis) -> Result<(), String> {
    for (label, index, max) in [
        ("姓名", analysis.name_index, 256),
        ("地址", analysis.address_index, 4096),
        ("支付方式", analysis.payment_index, 256),
        ("备注", analysis.note_index, 65536),
        ("回礼备注", analysis.return_gift_index, 65536),
        ("标签", analysis.tag_index, 16384),
    ] {
        if let Some(value) = index.and_then(|i| row.get(i)) {
            validate_text(label, value, max)?;
        }
    }
    for index in [analysis.date_index, analysis.return_gifted_at_index]
        .into_iter()
        .flatten()
    {
        if let Some(value) = row.get(index) {
            validate_date(value, true)?;
        }
    }
    optional_imported_amount(row, analysis.return_gift_amount_index)?;
    Ok(())
}

fn received_at_or_now(value: &str) -> String {
    let value = value.trim();
    if value.is_empty() {
        Local::now().format("%Y-%m-%d %H:%M:%S").to_string()
    } else {
        value.to_string()
    }
}

fn format_imported_datetime(value: NaiveDateTime) -> String {
    value.format("%Y-%m-%d %H:%M:%S").to_string()
}

fn excel_serial_datetime(value: f64) -> Option<NaiveDateTime> {
    if !value.is_finite() || !(20_000.0..=100_000.0).contains(&value) {
        return None;
    }
    let epoch = NaiveDate::from_ymd_opt(1899, 12, 30)?.and_hms_opt(0, 0, 0)?;
    let milliseconds = (value * 86_400_000.0).round() as i64;
    epoch.checked_add_signed(chrono::Duration::milliseconds(milliseconds))
}

fn normalize_imported_received_at(value: &str) -> String {
    let value = value.trim();
    if value.is_empty() {
        return received_at_or_now("");
    }
    if let Ok(serial) = value.parse::<f64>() {
        if let Some(datetime) = excel_serial_datetime(serial) {
            return format_imported_datetime(datetime);
        }
    }
    for format in [
        "%Y-%m-%d %H:%M:%S",
        "%Y-%m-%d %H:%M",
        "%Y/%m/%d %H:%M:%S",
        "%Y/%m/%d %H:%M",
        "%Y-%m-%dT%H:%M:%S",
        "%Y-%-m-%-d %H:%M:%S",
        "%Y/%-m/%-d %H:%M:%S",
    ] {
        if let Ok(datetime) = NaiveDateTime::parse_from_str(value, format) {
            return format_imported_datetime(datetime);
        }
    }
    for format in ["%Y-%m-%d", "%Y/%m/%d", "%Y-%-m-%-d", "%Y/%-m/%-d"] {
        if let Ok(date) = NaiveDate::parse_from_str(value, format) {
            if let Some(datetime) = date.and_hms_opt(0, 0, 0) {
                return format_imported_datetime(datetime);
            }
        }
    }
    value.to_string()
}

fn optional_imported_amount(row: &[String], index: Option<usize>) -> Result<Option<i64>, String> {
    let value = index
        .and_then(|column| row.get(column))
        .map(String::as_str)
        .unwrap_or_default()
        .trim();
    if value.is_empty() {
        return Ok(None);
    }
    parse_amount_fen(value)
        .filter(|amount| *amount > 0)
        .map(Some)
        .ok_or_else(|| format!("回礼金额无效: {value}"))
}

fn imported_return_time(
    row: &[String],
    index: Option<usize>,
    amount_fen: Option<i64>,
    timestamp: &str,
) -> Option<String> {
    amount_fen.map(|_| {
        let value = index
            .and_then(|column| row.get(column))
            .map(String::as_str)
            .unwrap_or_default()
            .trim();
        if value.is_empty() {
            timestamp.to_string()
        } else {
            normalize_imported_received_at(value)
        }
    })
}

fn spreadsheet_cell_text(cell: &Data) -> String {
    match cell {
        Data::DateTime(value) => {
            let (year, month, day, hour, minute, second, millisecond) = value.to_ymd_hms_milli();
            let datetime =
                NaiveDate::from_ymd_opt(year.into(), month.into(), day.into()).and_then(|date| {
                    date.and_hms_milli_opt(
                        hour.into(),
                        minute.into(),
                        second.into(),
                        millisecond.into(),
                    )
                });
            datetime
                .map(format_imported_datetime)
                .unwrap_or_else(|| cell.to_string())
        }
        Data::DateTimeIso(value) => normalize_imported_received_at(value),
        _ => cell.to_string(),
    }
}

fn apply_entry_tags(
    transaction: &Transaction<'_>,
    person_id: &str,
    tag_ids: &[String],
) -> Result<(), String> {
    for tag_id in tag_ids {
        let active: bool = transaction
            .query_row(
                "SELECT EXISTS(SELECT 1 FROM tags WHERE id = ? AND deleted_at IS NULL)",
                params![tag_id],
                |row| row.get(0),
            )
            .map_err(|e| e.to_string())?;
        if !active {
            return Err("标签不存在或已在回收站中".to_string());
        }
        transaction
            .execute(
                "INSERT OR IGNORE INTO person_tags(person_id, tag_id) VALUES (?, ?)",
                params![person_id, tag_id],
            )
            .map_err(|e| e.to_string())?;
    }
    Ok(())
}

fn choose_file_path(
    mode: &str,
    filter_name: &str,
    extensions: &[&str],
    default_name: &str,
) -> Option<String> {
    let mut dialog = default_file_dialog().add_filter(filter_name, extensions);
    if mode == "save" {
        dialog = dialog.set_file_name(default_name);
        dialog
            .save_file()
            .map(|path| path.to_string_lossy().to_string())
    } else {
        dialog
            .pick_file()
            .map(|path| path.to_string_lossy().to_string())
    }
}

#[tauri::command]
fn choose_spreadsheet_path(mode: String, app: tauri::AppHandle) -> Option<String> {
    let mut dialog = spreadsheet_file_dialog(&app)
        .add_filter("Excel、CSV 或其他表格", &spreadsheet_extensions())
        .add_filter("所有文件", &["*"]);
    if mode == "save" {
        dialog = dialog.set_file_name("礼金数据.xlsx");
        dialog
            .save_file()
            .map(|path| path.to_string_lossy().to_string())
    } else {
        dialog
            .pick_file()
            .map(|path| path.to_string_lossy().to_string())
    }
}

#[tauri::command]
fn choose_spreadsheet_paths(app: tauri::AppHandle) -> Vec<String> {
    spreadsheet_file_dialog(&app)
        .add_filter("Excel、CSV 或其他表格", &spreadsheet_extensions())
        .add_filter("所有文件", &["*"])
        .pick_files()
        .unwrap_or_default()
        .into_iter()
        .map(|path| path.to_string_lossy().to_string())
        .collect()
}

fn spreadsheet_extensions() -> Vec<&'static str> {
    vec!["xlsx", "xls", "xlsm", "xlsb", "ods", "csv", "tsv"]
}

#[derive(Debug, Clone)]
struct ParsedSheet {
    file_name: String,
    sheet_name: String,
    header_row: usize,
    headers: Vec<String>,
    rows: Vec<Vec<String>>,
}

fn trim_sheet_row(row: Vec<String>) -> Vec<String> {
    row.into_iter()
        .map(|value| value.trim_matches('\u{feff}').trim().to_string())
        .collect()
}

fn row_has_content(row: &[String]) -> bool {
    row.iter().any(|value| !value.trim().is_empty())
}

fn parsed_sheet_from_rows(
    file_name: &str,
    sheet_name: &str,
    rows: Vec<Vec<String>>,
) -> Result<ParsedSheet, String> {
    parsed_sheet_from_rows_at(file_name, sheet_name, rows, None)
}

fn parsed_sheet_from_rows_at(
    file_name: &str,
    sheet_name: &str,
    rows: Vec<Vec<String>>,
    requested_header_row: Option<usize>,
) -> Result<ParsedSheet, String> {
    let rows = rows.into_iter().map(trim_sheet_row).collect::<Vec<_>>();
    let header_row = requested_header_row
        .map(|value| value.saturating_sub(1))
        .or_else(|| {
            rows.iter().take(20).position(|row| {
                row_has_content(row)
                    && column_index(
                        row,
                        &[
                            "姓名",
                            "名字",
                            "收礼人",
                            "来宾",
                            "人名",
                            "name",
                            "guest",
                            "person",
                        ],
                    )
                    .is_some()
                    && column_index(row, &["金额", "礼金", "数额", "amount", "money", "gift"])
                        .is_some()
            })
        })
        .or_else(|| rows.iter().position(|row| row_has_content(row)))
        .ok_or_else(|| "工作表没有数据".to_string())?;
    if header_row >= rows.len() || !row_has_content(&rows[header_row]) {
        return Err("指定的标题行没有内容".to_string());
    }
    let headers = rows[header_row].clone();
    let data_rows = rows
        .into_iter()
        .skip(header_row + 1)
        .filter(|row| row_has_content(row))
        .collect::<Vec<_>>();
    Ok(ParsedSheet {
        file_name: file_name.to_string(),
        sheet_name: sheet_name.to_string(),
        header_row: header_row + 1,
        headers,
        rows: data_rows,
    })
}

fn spreadsheet_delimiter(path: &Path) -> u8 {
    let bytes = std::fs::read(path).unwrap_or_default();
    let lines = bytes
        .split(|byte| *byte == b'\n' || *byte == b'\r')
        .take(20)
        .collect::<Vec<_>>();
    let mut best = (b',', 0usize);
    for delimiter in *b",;\t" {
        let matches = lines
            .iter()
            .map(|line| line.iter().filter(|byte| **byte == delimiter).count())
            .sum();
        if matches > best.1 {
            best = (delimiter, matches);
        }
    }
    best.0
}

fn parse_sheet(path: &str) -> Result<ParsedSheet, String> {
    let file_path = Path::new(path);
    if !file_path.is_file() {
        return Err("找不到表格文件".to_string());
    }
    let extension = file_path
        .extension()
        .and_then(|value| value.to_str())
        .unwrap_or_default()
        .to_ascii_lowercase();
    let file_name = file_path
        .file_name()
        .and_then(|value| value.to_str())
        .unwrap_or("表格")
        .to_string();
    if matches!(extension.as_str(), "csv" | "tsv") {
        let delimiter = if extension == "tsv" {
            b'\t'
        } else {
            spreadsheet_delimiter(file_path)
        };
        let mut reader = csv::ReaderBuilder::new()
            .has_headers(false)
            .flexible(true)
            .delimiter(delimiter)
            .from_path(file_path)
            .map_err(|e| e.to_string())?;
        let rows = reader
            .records()
            .map(|record| {
                record
                    .map(|row| row.iter().map(str::to_string).collect::<Vec<_>>())
                    .map_err(|e| e.to_string())
            })
            .collect::<Result<Vec<_>, _>>()?;
        return parsed_sheet_from_rows(&file_name, "CSV", rows);
    }
    let mut workbook = open_workbook_auto(file_path).map_err(|e| format!("无法读取 Excel: {e}"))?;
    let mut fallback = None;
    for sheet_name in workbook.sheet_names().to_vec() {
        let range = workbook
            .worksheet_range(&sheet_name)
            .map_err(|e| format!("无法读取工作表「{sheet_name}」: {e}"))?;
        let rows = range
            .rows()
            .map(|row| row.iter().map(spreadsheet_cell_text).collect::<Vec<_>>())
            .collect::<Vec<_>>();
        let parsed = match parsed_sheet_from_rows(&file_name, &sheet_name, rows) {
            Ok(parsed) => parsed,
            Err(_) => continue,
        };
        let has_required_columns = column_index(
            &parsed.headers,
            &[
                "姓名",
                "名字",
                "收礼人",
                "来宾",
                "人名",
                "name",
                "guest",
                "person",
            ],
        )
        .is_some()
            && column_index(
                &parsed.headers,
                &["金额", "礼金", "数额", "amount", "money", "gift"],
            )
            .is_some();
        if has_required_columns {
            return Ok(parsed);
        }
        if fallback.is_none() {
            fallback = Some(parsed);
        }
    }
    fallback.ok_or_else(|| "Excel 中没有可读取的工作表".to_string())
}

fn spreadsheet_sheet_names(path: &str) -> Result<Vec<String>, String> {
    let file_path = Path::new(path);
    let extension = file_path
        .extension()
        .and_then(|value| value.to_str())
        .unwrap_or_default()
        .to_ascii_lowercase();
    if matches!(extension.as_str(), "csv" | "tsv") {
        return Ok(vec!["CSV".to_string()]);
    }
    let workbook = open_workbook_auto(file_path).map_err(|e| format!("无法读取 Excel: {e}"))?;
    Ok(workbook.sheet_names().to_vec())
}

fn parse_sheet_selection(
    path: &str,
    requested_sheet: Option<&str>,
    requested_header_row: Option<usize>,
) -> Result<ParsedSheet, String> {
    if requested_sheet.is_none() && requested_header_row.is_none() {
        return parse_sheet(path);
    }
    let file_path = Path::new(path);
    if !file_path.is_file() {
        return Err("找不到表格文件".to_string());
    }
    let extension = file_path
        .extension()
        .and_then(|value| value.to_str())
        .unwrap_or_default()
        .to_ascii_lowercase();
    let file_name = file_path
        .file_name()
        .and_then(|value| value.to_str())
        .unwrap_or("表格")
        .to_string();
    if matches!(extension.as_str(), "csv" | "tsv") {
        if let Some(sheet) = requested_sheet {
            if sheet != "CSV" {
                return Err("CSV 文件只有一个名为 CSV 的工作表".to_string());
            }
        }
        let delimiter = if extension == "tsv" {
            b'\t'
        } else {
            spreadsheet_delimiter(file_path)
        };
        let mut reader = csv::ReaderBuilder::new()
            .has_headers(false)
            .flexible(true)
            .delimiter(delimiter)
            .from_path(file_path)
            .map_err(|e| e.to_string())?;
        let rows = reader
            .records()
            .map(|record| {
                record
                    .map(|row| row.iter().map(str::to_string).collect::<Vec<_>>())
                    .map_err(|e| e.to_string())
            })
            .collect::<Result<Vec<_>, _>>()?;
        return parsed_sheet_from_rows_at(&file_name, "CSV", rows, requested_header_row);
    }
    let mut workbook = open_workbook_auto(file_path).map_err(|e| format!("无法读取 Excel: {e}"))?;
    let sheet_name = requested_sheet
        .map(str::to_string)
        .or_else(|| workbook.sheet_names().first().cloned())
        .ok_or_else(|| "Excel 中没有工作表".to_string())?;
    let range = workbook
        .worksheet_range(&sheet_name)
        .map_err(|e| format!("无法读取工作表「{sheet_name}」: {e}"))?;
    let rows = range
        .rows()
        .map(|row| row.iter().map(spreadsheet_cell_text).collect::<Vec<_>>())
        .collect::<Vec<_>>();
    parsed_sheet_from_rows_at(&file_name, &sheet_name, rows, requested_header_row)
}

fn normalized_header(value: &str) -> String {
    value
        .chars()
        .filter(|character| {
            *character != '\u{feff}'
                && !character.is_whitespace()
                && !matches!(
                    character,
                    ':' | '：'
                        | '('
                        | ')'
                        | '（'
                        | '）'
                        | '['
                        | ']'
                        | '【'
                        | '】'
                        | '-'
                        | '_'
                        | '/'
                )
        })
        .collect::<String>()
        .to_ascii_lowercase()
}

fn column_index(headers: &[String], names: &[&str]) -> Option<usize> {
    column_index_excluding(headers, names, None)
}

fn column_index_excluding(
    headers: &[String],
    names: &[&str],
    excluded: Option<usize>,
) -> Option<usize> {
    headers.iter().enumerate().find_map(|(index, header)| {
        if Some(index) == excluded {
            return None;
        }
        let normalized = normalized_header(header);
        names
            .iter()
            .map(|name| normalized_header(name))
            .any(|name| !name.is_empty() && (normalized == name || normalized.contains(&name)))
            .then_some(index)
    })
}

fn parse_amount_fen(value: &str) -> Option<i64> {
    let mut normalized = value
        .trim()
        .replace([',', '¥', '￥'], "")
        .replace("元", "")
        .chars()
        .filter(|character| !character.is_whitespace())
        .collect::<String>();
    if normalized.is_empty() {
        return None;
    }
    if normalized.starts_with('-') || normalized.starts_with('+') {
        return None;
    }
    if let Some(dot) = normalized.find('.') {
        let decimals = normalized.split_off(dot + 1);
        normalized.truncate(dot);
        if decimals.len() > 2 || !decimals.chars().all(|character| character.is_ascii_digit()) {
            return None;
        }
        let whole = normalized.parse::<i64>().ok()?;
        let decimal = if decimals.is_empty() {
            0
        } else if decimals.len() == 1 {
            decimals.parse::<i64>().ok()? * 10
        } else {
            decimals.parse::<i64>().ok()?
        };
        return whole
            .checked_mul(100)?
            .checked_add(decimal)
            .filter(|amount| *amount <= MAX_SAFE_FEN);
    }
    normalized
        .parse::<i64>()
        .ok()?
        .checked_mul(100)
        .filter(|amount| *amount <= MAX_SAFE_FEN)
}

#[derive(Debug, Clone)]
struct SheetAnalysis {
    name_index: Option<usize>,
    amount_index: Option<usize>,
    address_index: Option<usize>,
    payment_index: Option<usize>,
    date_index: Option<usize>,
    note_index: Option<usize>,
    return_gift_index: Option<usize>,
    return_gift_amount_index: Option<usize>,
    return_gifted_at_index: Option<usize>,
    tag_index: Option<usize>,
    errors: Vec<String>,
    invalid_rows: Vec<usize>,
    valid_rows: usize,
}

fn analyze_sheet(sheet: &ParsedSheet) -> SheetAnalysis {
    let name_index = column_index(
        &sheet.headers,
        &[
            "姓名",
            "名字",
            "收礼人",
            "来宾",
            "人名",
            "name",
            "guest",
            "person",
        ],
    );
    let amount_index = column_index(
        &sheet.headers,
        &[
            "金额",
            "礼金",
            "随礼",
            "礼金金额",
            "数额",
            "amount",
            "money",
            "gift",
            "gift amount",
            "cash gift",
        ],
    );
    let address_index = column_index(&sheet.headers, &["地址", "住址", "联系地址", "address"]);
    let payment_index = column_index(
        &sheet.headers,
        &["支付方式", "付款方式", "支付", "方式", "payment", "method"],
    );
    let return_gift_amount_index = column_index(
        &sheet.headers,
        &[
            "回礼金额",
            "回赠金额",
            "还礼金额",
            "return gift amount",
            "return_gift_amount",
            "return amount",
        ],
    );
    let return_gifted_at_index = column_index(
        &sheet.headers,
        &[
            "回礼时间",
            "回礼日期",
            "回赠时间",
            "还礼时间",
            "return gift time",
            "return_gifted_at",
        ],
    );
    let date_index = column_index_excluding(
        &sheet.headers,
        &[
            "日期",
            "登记日期",
            "收礼日期",
            "登记时间",
            "时间",
            "date",
            "time",
        ],
        return_gifted_at_index,
    );
    let note_index = column_index(
        &sheet.headers,
        &[
            "备注",
            "备注信息",
            "说明",
            "附言",
            "其他",
            "礼品",
            "note",
            "remark",
            "memo",
            "comment",
        ],
    );
    let return_gift_index = column_index_excluding(
        &sheet.headers,
        &["回礼", "回赠", "回敬", "还礼", "return gift", "return_gift"],
        return_gift_amount_index,
    );
    let tag_index = column_index(
        &sheet.headers,
        &[
            "人物标签",
            "标签",
            "人物分类",
            "分类",
            "关系",
            "tag",
            "tags",
            "label",
            "labels",
        ],
    );
    let mut errors = Vec::new();
    let mut invalid_rows = Vec::new();
    let mut valid_rows = 0;
    if name_index.is_none() {
        errors.push("缺少姓名列".to_string());
    }
    if amount_index.is_none() {
        errors.push("缺少金额列".to_string());
    }
    if let (Some(name_index), Some(amount_index)) = (name_index, amount_index) {
        for (index, row) in sheet.rows.iter().enumerate() {
            let name = row
                .get(name_index)
                .map(String::as_str)
                .unwrap_or_default()
                .trim();
            let amount = row
                .get(amount_index)
                .map(String::as_str)
                .unwrap_or_default();
            if !row_has_content(row) {
                continue;
            }
            if name.is_empty() {
                invalid_rows.push(index);
                errors.push(format!("第 {} 行缺少姓名", index + sheet.header_row + 1));
                continue;
            }
            if parse_amount_fen(amount).unwrap_or(0) <= 0 {
                invalid_rows.push(index);
                errors.push(format!(
                    "第 {} 行金额无效: {}",
                    index + sheet.header_row + 1,
                    amount
                ));
                continue;
            }
            let validation = SheetAnalysis {
                name_index: Some(name_index),
                amount_index: Some(amount_index),
                address_index,
                payment_index,
                date_index,
                note_index,
                return_gift_index,
                return_gift_amount_index,
                return_gifted_at_index,
                tag_index,
                errors: Vec::new(),
                invalid_rows: Vec::new(),
                valid_rows: 0,
            };
            if let Err(error) = validate_import_row(row, &validation) {
                invalid_rows.push(index);
                errors.push(format!("第 {} 行{error}", index + sheet.header_row + 1));
                continue;
            }
            valid_rows += 1;
        }
    }
    SheetAnalysis {
        name_index,
        amount_index,
        address_index,
        payment_index,
        date_index,
        note_index,
        return_gift_index,
        return_gift_amount_index,
        return_gifted_at_index,
        tag_index,
        errors,
        invalid_rows,
        valid_rows,
    }
}

fn mapping_from_analysis(analysis: &SheetAnalysis) -> SpreadsheetColumnMapping {
    SpreadsheetColumnMapping {
        name: analysis.name_index,
        amount: analysis.amount_index,
        address: analysis.address_index,
        payment_method: analysis.payment_index,
        date: analysis.date_index,
        note: analysis.note_index,
        return_gift: analysis.return_gift_index,
        return_gift_amount: analysis.return_gift_amount_index,
        return_gifted_at: analysis.return_gifted_at_index,
        tags: analysis.tag_index,
    }
}

fn analyze_sheet_with_mapping(
    sheet: &ParsedSheet,
    mapping: &SpreadsheetColumnMapping,
) -> SheetAnalysis {
    let mut analysis = SheetAnalysis {
        name_index: mapping.name,
        amount_index: mapping.amount,
        address_index: mapping.address,
        payment_index: mapping.payment_method,
        date_index: mapping.date,
        note_index: mapping.note,
        return_gift_index: mapping.return_gift,
        return_gift_amount_index: mapping.return_gift_amount,
        return_gifted_at_index: mapping.return_gifted_at,
        tag_index: mapping.tags,
        errors: Vec::new(),
        invalid_rows: Vec::new(),
        valid_rows: 0,
    };
    if analysis.name_index.is_none() {
        analysis.errors.push("缺少姓名列".to_string());
    }
    if analysis.amount_index.is_none() {
        analysis.errors.push("缺少金额列".to_string());
    }
    for (label, index) in [
        ("姓名", analysis.name_index),
        ("金额", analysis.amount_index),
        ("地址", analysis.address_index),
        ("支付方式", analysis.payment_index),
        ("日期", analysis.date_index),
        ("备注", analysis.note_index),
        ("回礼", analysis.return_gift_index),
        ("回礼金额", analysis.return_gift_amount_index),
        ("回礼时间", analysis.return_gifted_at_index),
        ("人物标签", analysis.tag_index),
    ] {
        if let Some(index) = index {
            if index >= sheet.headers.len() {
                analysis.errors.push(format!("{label}列超出表头范围"));
            }
        }
    }
    if let (Some(name_index), Some(amount_index)) = (analysis.name_index, analysis.amount_index) {
        for (index, row) in sheet.rows.iter().enumerate() {
            let name = row
                .get(name_index)
                .map(String::as_str)
                .unwrap_or_default()
                .trim();
            let amount = row
                .get(amount_index)
                .map(String::as_str)
                .unwrap_or_default();
            if !row_has_content(row) {
                continue;
            }
            if name.is_empty() {
                analysis.invalid_rows.push(index);
                analysis
                    .errors
                    .push(format!("第 {} 行缺少姓名", index + sheet.header_row + 1));
                continue;
            }
            if parse_amount_fen(amount).unwrap_or(0) <= 0 {
                analysis.invalid_rows.push(index);
                analysis.errors.push(format!(
                    "第 {} 行金额无效: {}",
                    index + sheet.header_row + 1,
                    amount
                ));
                continue;
            }
            if let Err(error) = validate_import_row(row, &analysis) {
                analysis.invalid_rows.push(index);
                analysis
                    .errors
                    .push(format!("第 {} 行{error}", index + sheet.header_row + 1));
                continue;
            }
            analysis.valid_rows += 1;
        }
    }
    analysis
}

#[derive(Debug, Clone)]
struct TagCatalogEntry {
    id: String,
    name: String,
    color: String,
}

fn normalize_tag_name(value: &str) -> String {
    value
        .split_whitespace()
        .collect::<Vec<_>>()
        .join(" ")
        .to_ascii_lowercase()
}

fn split_tag_names(value: &str) -> Vec<String> {
    let mut names = Vec::new();
    let mut seen = HashSet::new();
    for name in value.split(['、', '，', ',', '；', ';', '|', '/', '\\', '\n', '\r', '\t']) {
        let display = name.split_whitespace().collect::<Vec<_>>().join(" ");
        let normalized = normalize_tag_name(&display);
        if !display.is_empty() && !normalized.is_empty() && seen.insert(normalized) {
            names.push(display);
        }
    }
    names
}

fn next_auto_tag_color(used: &HashSet<String>) -> String {
    let used = used
        .iter()
        .map(|color| color.to_ascii_lowercase())
        .collect::<HashSet<_>>();
    if let Some(color) = AUTO_TAG_COLORS.iter().find(|color| !used.contains(**color)) {
        return (*color).to_string();
    }
    let mut seed = used.len() as u32 + 1;
    loop {
        seed = seed.wrapping_mul(1_664_525).wrapping_add(1_013_904_223);
        let candidate = format!("#{:06x}", seed & 0x00ff_ffff);
        if !used.contains(&candidate) {
            return candidate;
        }
    }
}

fn tag_previews(
    sheet: &ParsedSheet,
    tag_index: Option<usize>,
    existing: &HashMap<String, TagCatalogEntry>,
) -> SpreadsheetTagPreview {
    let Some(tag_index) = tag_index else {
        return SpreadsheetTagPreview {
            column_name: None,
            values: Vec::new(),
        };
    };
    let mut names = Vec::new();
    let mut counts = HashMap::<String, usize>::new();
    for row in &sheet.rows {
        let value = row.get(tag_index).map(String::as_str).unwrap_or_default();
        for name in split_tag_names(value) {
            let normalized = normalize_tag_name(&name);
            *counts.entry(normalized.clone()).or_default() += 1;
            if !names
                .iter()
                .any(|item: &String| normalize_tag_name(item) == normalized)
            {
                names.push(name);
            }
        }
    }
    let mut used_colors = existing
        .values()
        .map(|tag| tag.color.to_ascii_lowercase())
        .collect::<HashSet<_>>();
    let values = names
        .into_iter()
        .map(|name| {
            let normalized = normalize_tag_name(&name);
            if let Some(tag) = existing.get(&normalized) {
                SpreadsheetTagValuePreview {
                    name: tag.name.clone(),
                    color: tag.color.clone(),
                    existing: true,
                    count: counts.get(&normalized).copied().unwrap_or(0),
                }
            } else {
                let color = next_auto_tag_color(&used_colors);
                used_colors.insert(color.clone());
                SpreadsheetTagValuePreview {
                    name,
                    color,
                    existing: false,
                    count: counts.get(&normalized).copied().unwrap_or(0),
                }
            }
        })
        .collect();
    SpreadsheetTagPreview {
        column_name: sheet.headers.get(tag_index).cloned(),
        values,
    }
}

fn load_tag_catalog(connection: &Connection) -> Result<HashMap<String, TagCatalogEntry>, String> {
    let mut statement = connection
        .prepare("SELECT id, name, color FROM tags WHERE deleted_at IS NULL")
        .map_err(|e| e.to_string())?;
    let rows = statement
        .query_map([], |row| {
            Ok(TagCatalogEntry {
                id: row.get(0)?,
                name: row.get(1)?,
                color: row.get(2)?,
            })
        })
        .map_err(|e| e.to_string())?;
    let mut catalog = HashMap::new();
    for row in rows {
        let tag = row.map_err(|e| e.to_string())?;
        catalog.insert(normalize_tag_name(&tag.name), tag);
    }
    Ok(catalog)
}

fn ensure_import_tags_are_available(
    connection: &Connection,
    sheet: &ParsedSheet,
    analysis: &SheetAnalysis,
) -> Result<(), String> {
    let Some(tag_index) = analysis.tag_index else {
        return Ok(());
    };
    let mut statement = connection
        .prepare("SELECT name FROM tags WHERE deleted_at IS NOT NULL")
        .map_err(|e| e.to_string())?;
    let deleted = statement
        .query_map([], |row| row.get::<_, String>(0))
        .map_err(|e| e.to_string())?
        .collect::<Result<HashSet<_>, _>>()
        .map_err(|e| e.to_string())?
        .into_iter()
        .map(|name| (normalize_tag_name(&name), name))
        .collect::<HashMap<_, _>>();
    for row in &sheet.rows {
        for name in split_tag_names(row.get(tag_index).map(String::as_str).unwrap_or_default()) {
            if let Some(deleted_name) = deleted.get(&normalize_tag_name(&name)) {
                return Err(format!(
                    "导入标签「{deleted_name}」在回收站中，请先恢复或清空回收站"
                ));
            }
        }
    }
    Ok(())
}

fn spreadsheet_preview_result(
    path: &str,
    vault_path: &str,
    state: &State<'_, AppState>,
    sheet: ParsedSheet,
    analysis: SheetAnalysis,
    suggested_mapping: SpreadsheetColumnMapping,
) -> Result<SpreadsheetPreview, String> {
    let connection = scoped_read_connection(state, vault_path)?;
    let existing = load_tag_catalog(&connection)?;
    let tag_preview = analysis
        .tag_index
        .map(|index| tag_previews(&sheet, Some(index), &existing));
    Ok(SpreadsheetPreview {
        file_name: sheet.file_name,
        sheet_name: sheet.sheet_name,
        sheet_names: spreadsheet_sheet_names(path)?,
        header_row: sheet.header_row,
        suggested_mapping: suggested_mapping.clone(),
        current_mapping: mapping_from_analysis(&analysis),
        headers: sheet.headers,
        rows: sheet.rows.into_iter().take(50).collect(),
        valid_rows: analysis.valid_rows,
        row_errors: analysis
            .errors
            .iter()
            .filter(|error| error.starts_with("第 "))
            .cloned()
            .collect(),
        errors: analysis.errors,
        tag_preview,
    })
}

#[tauri::command(async)]
fn preview_spreadsheet(
    path: String,
    vault_path: String,
    state: State<'_, AppState>,
) -> Result<SpreadsheetPreview, String> {
    let sheet = parse_sheet(&path)?;
    let analysis = analyze_sheet(&sheet);
    let suggested_mapping = mapping_from_analysis(&analysis);
    spreadsheet_preview_result(
        &path,
        &vault_path,
        &state,
        sheet,
        analysis,
        suggested_mapping,
    )
}

#[tauri::command(async)]
fn preview_spreadsheet_mapping(
    path: String,
    sheet_name: Option<String>,
    header_row: Option<usize>,
    mapping: SpreadsheetColumnMapping,
    vault_path: String,
    state: State<'_, AppState>,
) -> Result<SpreadsheetPreview, String> {
    let sheet = parse_sheet_selection(&path, sheet_name.as_deref(), header_row)?;
    let suggested_mapping = mapping_from_analysis(&analyze_sheet(&sheet));
    let analysis = analyze_sheet_with_mapping(&sheet, &mapping);
    spreadsheet_preview_result(
        &path,
        &vault_path,
        &state,
        sheet,
        analysis,
        suggested_mapping,
    )
}

#[tauri::command(async)]
fn import_spreadsheet(
    path: String,
    book_id: String,
    vault_path: String,
    state: State<'_, AppState>,
) -> Result<SpreadsheetImportResult, String> {
    let _operation = begin_operation()?;
    require_admin(&state)?;
    if is_edit_locked(&state)? {
        return Err("编辑已锁定，请先解锁编辑".into());
    }
    let vault_path = displayable_path(&canonical_opened_vault_path(&state, Some(&vault_path))?);
    let sheet = parse_sheet(&path)?;
    let analysis = analyze_sheet(&sheet);
    validate_spreadsheet_import(&analysis)?;
    let mut connection = admin_connection(&state, &vault_path, "import", true)?;
    ensure_import_tags_are_available(&connection, &sheet, &analysis)?;
    import_sheet_into_book(&mut connection, &sheet, &analysis, &book_id)
}

struct PreparedSpreadsheetImport {
    item: SpreadsheetImportItem,
    sheet: ParsedSheet,
    analysis: SheetAnalysis,
}

fn validate_spreadsheet_target(
    target_book_id: Option<&str>,
    create_new_book: bool,
) -> Result<(), String> {
    if create_new_book == target_book_id.is_some() {
        return Err("请为每次导入明确选择已有礼金簿或新建礼金簿".to_string());
    }
    Ok(())
}

fn import_sheet_into_transaction(
    transaction: &Transaction<'_>,
    sheet: &ParsedSheet,
    analysis: &SheetAnalysis,
    book_id: &str,
    catalog: &mut HashMap<String, TagCatalogEntry>,
) -> Result<SpreadsheetImportResult, String> {
    let active: bool = transaction
        .query_row(
            "SELECT EXISTS(SELECT 1 FROM gift_books WHERE id=? AND deleted_at IS NULL)",
            params![book_id],
            |row| row.get(0),
        )
        .map_err(|e| e.to_string())?;
    if !active {
        return Err("导入目标礼金簿不存在或已在回收站中".to_string());
    }
    let (name_index, amount_index) = (
        analysis.name_index.ok_or("缺少姓名列")?,
        analysis.amount_index.ok_or("缺少金额列")?,
    );
    let tag_preview = tag_previews(sheet, analysis.tag_index, catalog);
    let created_tags = tag_preview
        .values
        .iter()
        .filter(|tag| !tag.existing)
        .cloned()
        .collect::<Vec<_>>();
    let existing_tags = tag_preview
        .values
        .iter()
        .filter(|tag| tag.existing)
        .map(|tag| tag.name.clone())
        .collect::<Vec<_>>();
    let timestamp = now();
    let mut imported = 0;
    for (row_index, row) in sheet.rows.iter().enumerate() {
        if analysis.invalid_rows.contains(&row_index) {
            continue;
        }
        let person_name = row
            .get(name_index)
            .map(String::as_str)
            .unwrap_or_default()
            .trim();
        let amount_fen = parse_amount_fen(
            row.get(amount_index)
                .map(String::as_str)
                .unwrap_or_default(),
        )
        .ok_or_else(|| "导入金额解析失败".to_string())?;
        let address = analysis
            .address_index
            .and_then(|index| row.get(index))
            .map(String::as_str)
            .unwrap_or_default()
            .trim()
            .to_string();
        let received_at = normalize_imported_received_at(
            analysis
                .date_index
                .and_then(|index| row.get(index))
                .map(String::as_str)
                .unwrap_or_default(),
        );
        let note = analysis
            .note_index
            .and_then(|index| row.get(index))
            .map(String::as_str)
            .unwrap_or_default()
            .trim()
            .to_string();
        let return_gift = analysis
            .return_gift_index
            .and_then(|index| row.get(index))
            .map(String::as_str)
            .unwrap_or_default()
            .trim()
            .to_string();
        let return_gift_amount_fen =
            optional_imported_amount(row, analysis.return_gift_amount_index)?;
        let return_gifted_at = imported_return_time(
            row,
            analysis.return_gifted_at_index,
            return_gift_amount_fen,
            &timestamp,
        );
        let payment_method = analysis
            .payment_index
            .and_then(|index| row.get(index))
            .map(String::as_str)
            .filter(|value| !value.trim().is_empty())
            .unwrap_or("其他")
            .trim()
            .to_string();
        let tag_names = analysis
            .tag_index
            .and_then(|index| row.get(index))
            .map(String::as_str)
            .unwrap_or_default();
        let tag_names = split_tag_names(tag_names)
            .into_iter()
            .map(|name| (normalize_tag_name(&name), name))
            .collect::<Vec<_>>();
        let person_id = Uuid::new_v4().to_string();
        transaction.execute(
            "INSERT INTO people(id, display_name, address, created_at, updated_at) VALUES (?, ?, ?, ?, ?)",
            params![person_id, person_name, null_if_empty(&address), timestamp, timestamp],
        ).map_err(|e| e.to_string())?;
        let mut tag_ids = Vec::new();
        for (normalized_name, display_name) in tag_names {
            let tag_id = if let Some(tag) = catalog.get(&normalized_name) {
                tag.id.clone()
            } else {
                let id = Uuid::new_v4().to_string();
                let planned = tag_preview
                    .values
                    .iter()
                    .find(|tag| normalize_tag_name(&tag.name) == normalized_name)
                    .map(|tag| tag.color.as_str())
                    .unwrap_or("#3b82f6");
                transaction
                    .execute(
                        "INSERT INTO tags(id, name, color, created_at, deleted_at) VALUES (?, ?, ?, ?, NULL)",
                        params![id, display_name, planned, timestamp],
                    )
                    .map_err(|e| e.to_string())?;
                catalog.insert(
                    normalized_name.clone(),
                    TagCatalogEntry {
                        id: id.clone(),
                        name: display_name,
                        color: planned.to_string(),
                    },
                );
                id
            };
            tag_ids.push(tag_id);
        }
        apply_entry_tags(transaction, &person_id, &tag_ids)?;
        let tag_snapshot = serde_json::to_string(&tag_ids).map_err(|e| e.to_string())?;
        transaction
            .execute(
                "INSERT INTO gift_entries(id, book_id, person_id, amount_fen, payment_method, received_at, note, return_gift, return_gift_amount_fen, return_gifted_at, tag_snapshot, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
                params![Uuid::new_v4().to_string(), book_id, person_id, amount_fen, payment_method, received_at, null_if_empty(&note), null_if_empty(&return_gift), return_gift_amount_fen, return_gifted_at, tag_snapshot, timestamp, timestamp],
            )
            .map_err(|e| e.to_string())?;
        imported += 1;
    }
    let skipped_rows = analysis
        .errors
        .iter()
        .filter(|error| error.starts_with("第 "))
        .cloned()
        .collect::<Vec<_>>();
    Ok(SpreadsheetImportResult {
        imported,
        created_tags,
        existing_tags,
        skipped_rows,
    })
}

fn unique_book_title(
    connection: &Transaction<'_>,
    requested: &str,
    reserved: &mut HashSet<String>,
) -> String {
    let base = safe_excel_file_stem(requested);
    let mut candidate = base.clone();
    let mut suffix = 2;
    loop {
        let exists = connection
            .query_row(
                "SELECT EXISTS(SELECT 1 FROM gift_books WHERE title = ? AND deleted_at IS NULL)",
                params![candidate],
                |row| row.get::<_, bool>(0),
            )
            .unwrap_or(false);
        if !exists && reserved.insert(candidate.clone()) {
            return candidate;
        }
        candidate = format!("{base} ({suffix})");
        suffix += 1;
    }
}

#[tauri::command(async)]
fn import_spreadsheets(
    items: Vec<SpreadsheetImportItem>,
    state: State<'_, AppState>,
) -> Result<SpreadsheetBatchImportResult, String> {
    let _operation = begin_operation()?;
    require_admin(&state)?;
    if is_edit_locked(&state)? {
        return Err("编辑已锁定，请先解锁编辑".into());
    }
    let requested = items
        .first()
        .and_then(|item| item.target_vault_path.as_deref())
        .ok_or("请选择导入目标礼金库")?;
    canonical_opened_vault_path(&state, Some(requested))?;
    if items.is_empty() {
        return Err("没有待导入的表格文件".to_string());
    }
    let mut seen_paths = HashSet::new();
    let mut prepared = Vec::with_capacity(items.len());
    for item in items {
        validate_spreadsheet_target(item.target_book_id.as_deref(), item.create_new_book)?;
        let path = Path::new(&item.path);
        if !path.is_file() {
            return Err(format!("文件不存在或不是普通文件：{}", item.path));
        }
        let normalized_path = path
            .canonicalize()
            .unwrap_or_else(|_| path.to_path_buf())
            .to_string_lossy()
            .to_ascii_lowercase();
        if !seen_paths.insert(normalized_path) {
            return Err(format!("重复导入同一个文件：{}", item.path));
        }
        let sheet = parse_sheet_selection(&item.path, item.sheet_name.as_deref(), item.header_row)?;
        let auto_analysis = analyze_sheet(&sheet);
        let mapping = item
            .mapping
            .clone()
            .unwrap_or_else(|| mapping_from_analysis(&auto_analysis));
        let analysis = analyze_sheet_with_mapping(&sheet, &mapping);
        validate_spreadsheet_import(&analysis)
            .map_err(|error| format!("{}：{}", item.path, error))?;
        prepared.push(PreparedSpreadsheetImport {
            item,
            sheet,
            analysis,
        });
    }

    let target_vault_path = prepared
        .first()
        .and_then(|item| item.item.target_vault_path.clone())
        .ok_or_else(|| "请选择导入目标礼金库".to_string())?;
    if prepared
        .iter()
        .any(|item| item.item.target_vault_path.as_deref() != Some(target_vault_path.as_str()))
    {
        return Err("同一批次导入必须使用同一个目标礼金库".to_string());
    }
    let mut connection = admin_connection_for_path(
        &state,
        Some(&target_vault_path),
        "import-spreadsheets",
        true,
    )?;
    for prepared_item in &prepared {
        ensure_import_tags_are_available(
            &connection,
            &prepared_item.sheet,
            &prepared_item.analysis,
        )?;
    }
    let mut catalog = load_tag_catalog(&connection)?;
    let transaction = connection.transaction().map_err(|e| e.to_string())?;
    let mut reserved_titles = HashSet::new();
    let mut books = Vec::with_capacity(prepared.len());
    let mut imported_total = 0;
    let mut skipped_rows = Vec::new();
    for prepared_item in prepared {
        let timestamp = now();
        let source_file_name = prepared_item.sheet.file_name.clone();
        let source_file_path = displayable_path(
            &Path::new(&prepared_item.item.path)
                .canonicalize()
                .unwrap_or_else(|_| PathBuf::from(&prepared_item.item.path)),
        );
        let (book_id, title, book) = if let Some(target_book_id) =
            prepared_item.item.target_book_id.as_deref()
        {
            let book = transaction
            .query_row(
                "SELECT id, title, occasion, event_date, location, notes, created_at, source_file_name, source_file_path, source_imported_at FROM gift_books WHERE id = ? AND deleted_at IS NULL",
                params![target_book_id],
                |row| {
                    Ok(GiftBook {
                        id: row.get(0)?,
                        title: row.get(1)?,
                        occasion: row.get(2)?,
                        event_date: row.get(3)?,
                        location: row.get(4)?,
                        notes: row.get(5)?,
                        created_at: row.get(6)?,
                        source_file_name: row.get(7)?,
                        source_file_path: row
                            .get::<_, Option<String>>(8)?
                            .map(|path| displayable_path(Path::new(&path))),
                        source_imported_at: row.get(9)?,
                    })
                },
            )
            .optional()
            .map_err(|e| e.to_string())?
            .ok_or_else(|| "导入目标礼金簿不存在或已被删除".to_string())?;
            (book.id.clone(), book.title.clone(), book)
        } else {
            let title_request = if prepared_item.item.book_name.trim().is_empty() {
                safe_excel_file_stem(&source_file_name)
            } else {
                prepared_item.item.book_name.trim().to_string()
            };
            let title = unique_book_title(&transaction, &title_request, &mut reserved_titles);
            let book_id = Uuid::new_v4().to_string();
            transaction
            .execute(
                "INSERT INTO gift_books(id, title, occasion, created_at, updated_at, source_file_name, source_file_path, source_imported_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
                params![book_id, title, "导入表格", timestamp, timestamp, source_file_name, source_file_path, timestamp],
            )
            .map_err(|e| e.to_string())?;
            let book = GiftBook {
                id: book_id.clone(),
                title: title.clone(),
                occasion: "导入表格".to_string(),
                event_date: None,
                location: None,
                notes: None,
                created_at: timestamp.clone(),
                source_file_name: Some(source_file_name.clone()),
                source_file_path: Some(source_file_path.clone()),
                source_imported_at: Some(timestamp.clone()),
            };
            (book_id, title, book)
        };
        let result = import_sheet_into_transaction(
            &transaction,
            &prepared_item.sheet,
            &prepared_item.analysis,
            &book_id,
            &mut catalog,
        )?;
        imported_total += result.imported;
        skipped_rows.extend(
            result
                .skipped_rows
                .iter()
                .map(|row| format!("{}：{}", source_file_name, row)),
        );
        write_audit_detail(
            &transaction,
            "import",
            "gift_book",
            &book_id,
            AuditPayload {
                person_id: None,
                target: title.clone(),
                book_title: Some(title.clone()),
                description: format!(
                    "导入文件：{}，新增 {} 条记录",
                    source_file_name, result.imported
                ),
                changes: Vec::new(),
            },
        )?;
        books.push(SpreadsheetImportBookResult {
            book,
            imported: result.imported,
            created_tags: result.created_tags,
            existing_tags: result.existing_tags,
            skipped_rows: result.skipped_rows,
        });
    }
    transaction.commit().map_err(|e| e.to_string())?;
    Ok(SpreadsheetBatchImportResult {
        books,
        imported: imported_total,
        skipped_rows,
    })
}

fn validate_spreadsheet_import(analysis: &SheetAnalysis) -> Result<(), String> {
    let structural_errors = analysis
        .errors
        .iter()
        .filter(|error| !error.starts_with("第 "))
        .cloned()
        .collect::<Vec<_>>();
    if !structural_errors.is_empty() {
        return Err(format!("导入未执行：{}", structural_errors.join("；")));
    }
    analysis.name_index.ok_or("缺少姓名列")?;
    analysis.amount_index.ok_or("缺少金额列")?;
    if analysis.valid_rows == 0 {
        return Err("没有可导入的有效记录".to_string());
    }
    Ok(())
}

fn import_sheet_into_book(
    connection: &mut Connection,
    sheet: &ParsedSheet,
    analysis: &SheetAnalysis,
    book_id: &str,
) -> Result<SpreadsheetImportResult, String> {
    let active: bool = connection
        .query_row(
            "SELECT EXISTS(SELECT 1 FROM gift_books WHERE id=? AND deleted_at IS NULL)",
            params![book_id],
            |row| row.get(0),
        )
        .map_err(|e| e.to_string())?;
    if !active {
        return Err("导入目标礼金簿不存在或已在回收站中".to_string());
    }
    let (name_index, amount_index) = (
        analysis.name_index.ok_or("缺少姓名列")?,
        analysis.amount_index.ok_or("缺少金额列")?,
    );
    let mut catalog = load_tag_catalog(connection)?;
    let tag_preview = tag_previews(sheet, analysis.tag_index, &catalog);
    let created_tags = tag_preview
        .values
        .iter()
        .filter(|tag| !tag.existing)
        .cloned()
        .collect::<Vec<_>>();
    let existing_tags = tag_preview
        .values
        .iter()
        .filter(|tag| tag.existing)
        .map(|tag| tag.name.clone())
        .collect::<Vec<_>>();
    let transaction = connection.transaction().map_err(|e| e.to_string())?;
    let timestamp = now();
    let mut imported = 0;
    for (row_index, row) in sheet.rows.iter().enumerate() {
        if analysis.invalid_rows.contains(&row_index) {
            continue;
        }
        let person_name = row
            .get(name_index)
            .map(String::as_str)
            .unwrap_or_default()
            .trim();
        let amount_fen = parse_amount_fen(
            row.get(amount_index)
                .map(String::as_str)
                .unwrap_or_default(),
        )
        .ok_or_else(|| "导入金额解析失败".to_string())?;
        let address = analysis
            .address_index
            .and_then(|index| row.get(index))
            .map(String::as_str)
            .unwrap_or_default()
            .trim()
            .to_string();
        let received_at = normalize_imported_received_at(
            analysis
                .date_index
                .and_then(|index| row.get(index))
                .map(String::as_str)
                .unwrap_or_default(),
        );
        let note = analysis
            .note_index
            .and_then(|index| row.get(index))
            .map(String::as_str)
            .unwrap_or_default()
            .trim()
            .to_string();
        let return_gift = analysis
            .return_gift_index
            .and_then(|index| row.get(index))
            .map(String::as_str)
            .unwrap_or_default()
            .trim()
            .to_string();
        let payment_method = analysis
            .payment_index
            .and_then(|index| row.get(index))
            .map(String::as_str)
            .filter(|value| !value.trim().is_empty())
            .unwrap_or("其他")
            .trim()
            .to_string();
        let tag_names = analysis
            .tag_index
            .and_then(|index| row.get(index))
            .map(String::as_str)
            .unwrap_or_default()
            .to_string();
        let tag_names = split_tag_names(&tag_names)
            .into_iter()
            .map(|name| (normalize_tag_name(&name), name))
            .collect::<Vec<_>>();
        let person_id = Uuid::new_v4().to_string();
        transaction.execute("INSERT INTO people(id, display_name, address, created_at, updated_at) VALUES (?, ?, ?, ?, ?)", params![person_id, person_name, null_if_empty(&address), timestamp, timestamp]).map_err(|e| e.to_string())?;
        let mut tag_ids = Vec::new();
        for (normalized_name, display_name) in tag_names {
            let tag_id = if let Some(tag) = catalog.get(&normalized_name) {
                tag.id.clone()
            } else {
                let id = Uuid::new_v4().to_string();
                let planned = tag_preview
                    .values
                    .iter()
                    .find(|tag| normalize_tag_name(&tag.name) == normalized_name)
                    .map(|tag| tag.color.as_str())
                    .unwrap_or("#3b82f6");
                transaction
                    .execute(
                        "INSERT INTO tags(id, name, color, created_at) VALUES (?, ?, ?, ?)",
                        params![id, display_name, planned, timestamp],
                    )
                    .map_err(|e| e.to_string())?;
                catalog.insert(
                    normalized_name.clone(),
                    TagCatalogEntry {
                        id: id.clone(),
                        name: display_name,
                        color: planned.to_string(),
                    },
                );
                id
            };
            tag_ids.push(tag_id);
        }
        apply_entry_tags(&transaction, &person_id, &tag_ids)?;
        let tag_snapshot = serde_json::to_string(&tag_ids).map_err(|e| e.to_string())?;
        let return_gift_amount_fen =
            optional_imported_amount(row, analysis.return_gift_amount_index)?;
        let return_gifted_at = imported_return_time(
            row,
            analysis.return_gifted_at_index,
            return_gift_amount_fen,
            &timestamp,
        );
        transaction.execute("INSERT INTO gift_entries(id, book_id, person_id, amount_fen, payment_method, received_at, note, return_gift, return_gift_amount_fen, return_gifted_at, tag_snapshot, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)", params![Uuid::new_v4().to_string(), book_id, person_id, amount_fen, payment_method, received_at, null_if_empty(&note), null_if_empty(&return_gift), return_gift_amount_fen, return_gifted_at, tag_snapshot, timestamp, timestamp]).map_err(|e| e.to_string())?;
        imported += 1;
    }
    let book_title = audit_book_title(&transaction, book_id)?;
    write_audit_detail(
        &transaction,
        "import",
        "gift_book",
        book_id,
        AuditPayload {
            person_id: None,
            target: book_title.clone(),
            book_title: Some(book_title),
            description: format!("导入文件：{}，新增 {} 条记录", sheet.file_name, imported),
            changes: Vec::new(),
        },
    )?;
    transaction.commit().map_err(|e| e.to_string())?;
    Ok(SpreadsheetImportResult {
        imported,
        created_tags,
        existing_tags,
        skipped_rows: analysis
            .errors
            .iter()
            .filter(|error| error.starts_with("第 "))
            .cloned()
            .collect(),
    })
}

fn safe_excel_file_stem(value: &str) -> String {
    let cleaned = value
        .chars()
        .filter(|character| {
            !matches!(
                character,
                '<' | '>' | ':' | '"' | '/' | '\\' | '|' | '?' | '*'
            )
        })
        .collect::<String>()
        .trim()
        .trim_matches('.')
        .to_string();
    if cleaned.is_empty() {
        "礼金明细".to_string()
    } else {
        cleaned.chars().take(120).collect()
    }
}

fn safe_worksheet_name(value: &str) -> String {
    let cleaned = value
        .chars()
        .filter(|character| !matches!(character, '[' | ']' | ':' | '*' | '?' | '/' | '\\'))
        .collect::<String>()
        .trim()
        .trim_matches('\'')
        .to_string();
    let value = if cleaned.is_empty() {
        "礼金明细".to_string()
    } else {
        cleaned
    };
    value.chars().take(31).collect()
}

fn write_excel_datetime_or_text(
    worksheet: &mut rust_xlsxwriter::Worksheet,
    row: u32,
    column: u16,
    value: &str,
    format: &Format,
) -> Result<(), String> {
    match ExcelDateTime::parse_from_str(value) {
        Ok(datetime) => worksheet
            .write_datetime_with_format(row, column, &datetime, format)
            .map(|_| ())
            .map_err(|e| e.to_string()),
        // Older imported files may contain a non-date marker. Preserve it as text
        // rather than silently changing the source data during an export.
        Err(_) => worksheet
            .write_string(row, column, value)
            .map(|_| ())
            .map_err(|e| e.to_string()),
    }
}

#[tauri::command(async)]
fn export_book_xlsx(
    book_id: String,
    columns: Option<Vec<String>>,
    vault_path: String,
    state: State<'_, AppState>,
) -> Result<String, String> {
    let connection = scoped_read_connection(&state, &vault_path)?;
    let book_title: String = connection
        .query_row(
            "SELECT title FROM gift_books WHERE id = ? AND deleted_at IS NULL",
            params![book_id],
            |row| row.get(0),
        )
        .optional()
        .map_err(|e| e.to_string())?
        .ok_or_else(|| "礼金簿不存在或已在回收站中".to_string())?;
    let default_name = format!("{}.xlsx", safe_excel_file_stem(&book_title));
    let destination = choose_file_path("save", "Excel", &["xlsx"], &default_name)
        .ok_or_else(|| "已取消导出".to_string())?;
    let destination = if destination.to_ascii_lowercase().ends_with(".xlsx") {
        destination
    } else {
        format!("{destination}.xlsx")
    };
    let mut entries = load_entries(&connection, Some(&book_id))?;
    entries.reverse();
    let mut workbook = Workbook::new();
    let header = Format::new().set_bold().set_background_color("#E7F1F5");
    let currency = Format::new().set_num_format("[$¥-804]#,##0.00");
    let datetime = Format::new().set_num_format("yyyy-mm-dd hh:mm:ss");
    let detail = workbook.add_worksheet();
    detail
        .set_name(safe_worksheet_name(&book_title))
        .map_err(|e| e.to_string())?;
    let default_columns = vec![
        "姓名",
        "金额",
        "支付方式",
        "地址",
        "备注",
        "标签",
        "回礼金额",
        "回礼备注",
        "回礼时间",
        "登记日期",
    ];
    let headers = columns.unwrap_or_else(|| {
        default_columns
            .iter()
            .map(|value| value.to_string())
            .collect::<Vec<_>>()
    });
    if headers.len() != default_columns.len()
        || default_columns
            .iter()
            .any(|value| !headers.iter().any(|header| header == value))
    {
        return Err("表格列顺序无效，必须包含全部标准字段且不能重复".to_string());
    }
    for (column, value) in headers.iter().enumerate() {
        detail
            .write_string_with_format(0, column as u16, value, &header)
            .map_err(|e| e.to_string())?;
    }
    let mut total_fen = 0i64;
    let mut count = 0u32;
    for (index, entry) in entries.iter().enumerate() {
        let excel_row = index as u32 + 1;
        for (column, field) in headers.iter().enumerate() {
            if field == "回礼时间" {
                write_excel_datetime_or_text(
                    detail,
                    excel_row,
                    column as u16,
                    entry.return_gifted_at.as_deref().unwrap_or_default(),
                    &datetime,
                )?;
            } else if field == "登记日期" {
                write_excel_datetime_or_text(
                    detail,
                    excel_row,
                    column as u16,
                    &entry.received_at,
                    &datetime,
                )?;
            } else {
                match field.as_str() {
                    "姓名" => detail.write_string(excel_row, column as u16, &entry.person_name),
                    "金额" => detail.write_number_with_format(
                        excel_row,
                        column as u16,
                        entry.amount_fen as f64 / 100.0,
                        &currency,
                    ),
                    "支付方式" => {
                        detail.write_string(excel_row, column as u16, &entry.payment_method)
                    }
                    "地址" => detail.write_string(
                        excel_row,
                        column as u16,
                        entry.address.as_deref().unwrap_or_default(),
                    ),
                    "备注" => detail.write_string(
                        excel_row,
                        column as u16,
                        entry.note.as_deref().unwrap_or_default(),
                    ),
                    "标签" => {
                        detail.write_string(excel_row, column as u16, entry.tag_names.join("、"))
                    }
                    "回礼金额" => {
                        if let Some(amount) = entry.return_gift_amount_fen {
                            detail.write_number_with_format(
                                excel_row,
                                column as u16,
                                amount as f64 / 100.0,
                                &currency,
                            )
                        } else {
                            detail.write_string(excel_row, column as u16, "")
                        }
                    }
                    "回礼备注" => detail.write_string(
                        excel_row,
                        column as u16,
                        entry.return_gift.as_deref().unwrap_or_default(),
                    ),
                    _ => unreachable!(),
                }
                .map_err(|e| e.to_string())?;
            }
        }
        total_fen = total_fen
            .checked_add(entry.amount_fen)
            .filter(|total| *total <= MAX_SAFE_FEN)
            .ok_or("礼金合计超过安全范围，无法准确导出")?;
        count += 1;
    }
    for column in 0..10 {
        detail
            .set_column_width(
                column,
                if column == 3 {
                    22.0
                } else if column == 4 {
                    28.0
                } else if column == 5 {
                    18.0
                } else if column == 6 {
                    20.0
                } else if column == 7 || column == 8 || column == 9 {
                    21.0
                } else {
                    14.0
                },
            )
            .map_err(|e| e.to_string())?;
    }
    detail.set_freeze_panes(1, 0).map_err(|e| e.to_string())?;
    detail
        .autofilter(0, 0, count, 9)
        .map_err(|e| e.to_string())?;
    let summary = workbook.add_worksheet();
    summary.set_name("统计汇总").map_err(|e| e.to_string())?;
    summary
        .write_string_with_format(0, 0, "指标", &header)
        .map_err(|e| e.to_string())?;
    summary
        .write_string_with_format(0, 1, "数值", &header)
        .map_err(|e| e.to_string())?;
    summary
        .write_string(1, 0, "礼金人数")
        .map_err(|e| e.to_string())?;
    summary
        .write_number(1, 1, count as f64)
        .map_err(|e| e.to_string())?;
    summary
        .write_string(2, 0, "礼金总额")
        .map_err(|e| e.to_string())?;
    summary
        .write_number_with_format(2, 1, total_fen as f64 / 100.0, &currency)
        .map_err(|e| e.to_string())?;
    summary
        .write_string(3, 0, "导出时间")
        .map_err(|e| e.to_string())?;
    write_excel_datetime_or_text(summary, 3, 1, &now(), &datetime)?;
    summary
        .set_column_width(0, 18.0)
        .map_err(|e| e.to_string())?;
    summary
        .set_column_width(1, 22.0)
        .map_err(|e| e.to_string())?;
    workbook.save(&destination).map_err(|e| e.to_string())?;
    Ok(destination)
}

#[tauri::command(async)]
fn export_vault(vault_path: String, state: State<'_, AppState>) -> Result<String, String> {
    let _operation = begin_operation()?;
    let destination =
        choose_file_path("save", "礼金库文件", &["giftvault"], "礼金库导出.giftvault")
            .ok_or_else(|| "已取消导出礼金库".to_string())?;
    let destination = normalize_vault_path(&destination);
    let source = canonical_opened_vault_path(&state, Some(&vault_path))?;
    let source_canonical = source.canonicalize().unwrap_or(source.clone());
    let destination_canonical = destination
        .canonicalize()
        .unwrap_or_else(|_| destination.clone());
    if source_canonical == destination_canonical {
        return Err("导出目标不能覆盖当前打开的礼金库".to_string());
    }
    if destination.exists() {
        return Err("导出目标已存在，请选择其他文件名".to_string());
    }
    snapshot_vault(&source, &destination)?;
    Ok(destination.to_string_lossy().to_string())
}

fn person_tag_map(connection: &Connection) -> Result<HashMap<String, Vec<Tag>>, String> {
    let active_filter = if table_has_column(connection, "tags", "deleted_at")? {
        " AND t.deleted_at IS NULL"
    } else {
        ""
    };
    let mut statement = connection
        .prepare(&format!(
            "SELECT pt.person_id, t.id, t.name, t.color
             FROM person_tags pt JOIN tags t ON t.id = pt.tag_id{active_filter}
             ORDER BY t.name"
        ))
        .map_err(|e| e.to_string())?;
    let rows = statement
        .query_map([], |row| {
            Ok((
                row.get::<_, String>(0)?,
                Tag {
                    id: row.get(1)?,
                    name: row.get(2)?,
                    color: row.get(3)?,
                },
            ))
        })
        .map_err(|e| e.to_string())?;
    let mut tags = HashMap::<String, Vec<Tag>>::new();
    for row in rows {
        let (person_id, tag) = row.map_err(|e| e.to_string())?;
        tags.entry(person_id).or_default().push(tag);
    }
    Ok(tags)
}

fn load_entries(connection: &Connection, book_id: Option<&str>) -> Result<Vec<GiftEntry>, String> {
    ensure_money_totals_safe(connection)?;
    let tag_map = person_tag_map(connection)?;
    let mut statement = connection
        .prepare(
            "SELECT e.id, e.book_id, e.person_id, p.display_name, p.address, e.amount_fen,
                    e.payment_method, e.received_at, e.note, e.return_gift, e.return_gift_amount_fen, e.return_gifted_at
             FROM gift_entries e JOIN people p ON p.id = e.person_id
             JOIN gift_books b ON b.id = e.book_id
             WHERE e.deleted_at IS NULL AND b.deleted_at IS NULL
               AND (? IS NULL OR e.book_id = ?)
             ORDER BY e.received_at DESC, e.created_at DESC",
        )
        .map_err(|e| e.to_string())?;
    let rows = statement
        .query_map(params![book_id, book_id], |row| {
            let person_id: String = row.get(2)?;
            let person_tags = tag_map.get(&person_id).cloned().unwrap_or_default();
            Ok(GiftEntry {
                id: row.get(0)?,
                book_id: row.get(1)?,
                person_id,
                person_name: row.get(3)?,
                address: row.get(4)?,
                amount_fen: read_money_fen(row, 5)?,
                payment_method: row.get(6)?,
                received_at: row.get(7)?,
                note: row.get(8)?,
                return_gift: row.get(9)?,
                return_gift_amount_fen: read_optional_money_fen(row, 10)?,
                return_gifted_at: row.get(11)?,
                tags: person_tags.iter().map(|tag| tag.id.clone()).collect(),
                tag_names: person_tags.into_iter().map(|tag| tag.name).collect(),
            })
        })
        .map_err(|e| e.to_string())?;
    let records = rows
        .collect::<Result<Vec<GiftEntry>, _>>()
        .map_err(|e| e.to_string())?;
    checked_money_total(records.iter().map(|record| record.amount_fen))?;
    checked_money_total(
        records
            .iter()
            .filter_map(|record| record.return_gift_amount_fen),
    )?;
    Ok(records)
}

fn normalized_search(value: &str) -> String {
    value
        .trim()
        .to_lowercase()
        .replace(['¥', '￥', ',', '.', ' '], "")
}

fn entry_match_fields(entry: &GiftEntry, book_title: &str, query: &str) -> Vec<String> {
    let query = normalized_search(query);
    if query.is_empty() {
        return Vec::new();
    }
    let mut fields = Vec::new();
    let text_fields = [
        ("姓名", entry.person_name.as_str()),
        ("支付方式", entry.payment_method.as_str()),
        ("地址", entry.address.as_deref().unwrap_or_default()),
        ("备注", entry.note.as_deref().unwrap_or_default()),
        ("回礼", entry.return_gift.as_deref().unwrap_or_default()),
        ("登记日期", entry.received_at.as_str()),
        ("礼金簿", book_title),
    ];
    for (label, value) in text_fields {
        if value.to_lowercase().contains(&query) {
            fields.push(label.to_string());
        }
    }
    if entry
        .tag_names
        .iter()
        .any(|tag| tag.to_lowercase().contains(&query))
    {
        fields.push("标签".to_string());
    }
    let amount = format!("{}{:02}", entry.amount_fen / 100, entry.amount_fen % 100);
    let yuan = (entry.amount_fen / 100).to_string();
    if amount.contains(&query) || yuan.contains(&query) {
        fields.push("金额".to_string());
    }
    fields
}

fn comparable_path(path: &Path) -> String {
    displayable_path(path)
        .replace('\\', "/")
        .to_ascii_lowercase()
}

fn resolve_opened_search_paths(
    requested_paths: &[String],
    opened_paths: &[PathBuf],
    active_path: &Path,
) -> Vec<PathBuf> {
    let mut opened = Vec::new();
    let mut opened_keys = HashSet::new();
    for path in opened_paths {
        let canonical = path.canonicalize().unwrap_or_else(|_| path.clone());
        if opened_keys.insert(comparable_path(&canonical)) {
            opened.push(canonical);
        }
    }
    if opened.is_empty() {
        return vec![active_path.to_path_buf()];
    }
    if requested_paths.is_empty() {
        return opened;
    }
    let requested_keys = requested_paths
        .iter()
        .filter_map(|value| Path::new(value).canonicalize().ok())
        .map(|path| comparable_path(&path))
        .collect::<HashSet<_>>();
    opened
        .into_iter()
        .filter(|path| requested_keys.contains(&comparable_path(path)))
        .collect()
}

#[tauri::command]
fn list_entries(
    book_id: String,
    search: String,
    vault_path: String,
    state: State<'_, AppState>,
) -> Result<Vec<GiftEntry>, String> {
    let connection = scoped_read_connection(&state, &vault_path)?;
    let entries = load_entries(&connection, Some(&book_id))?;
    if search.trim().is_empty() {
        return Ok(entries);
    }
    let book_title: String = connection
        .query_row(
            "SELECT title FROM gift_books WHERE id = ?",
            params![book_id],
            |row| row.get(0),
        )
        .optional()
        .map_err(|e| e.to_string())?
        .unwrap_or_default();
    Ok(entries
        .into_iter()
        .filter(|entry| !entry_match_fields(entry, &book_title, &search).is_empty())
        .collect())
}

#[tauri::command]
fn list_return_gifts(
    vault_path: String,
    state: State<'_, AppState>,
) -> Result<Vec<ReturnGiftRecord>, String> {
    let connection = scoped_read_connection(&state, &vault_path)?;
    list_return_gifts_from_connection(&connection)
}

fn list_return_gifts_from_connection(
    connection: &Connection,
) -> Result<Vec<ReturnGiftRecord>, String> {
    ensure_money_totals_safe(connection)?;
    let tags_by_person = person_tag_map(connection)?;
    let mut statement = connection
        .prepare(
            "SELECT e.id, b.id, b.title, p.id, p.display_name, p.address,
                    e.return_gift_amount_fen, e.return_gifted_at, e.return_gift
             FROM gift_entries e
             JOIN gift_books b ON b.id = e.book_id
             JOIN people p ON p.id = e.person_id
             WHERE e.deleted_at IS NULL AND b.deleted_at IS NULL AND p.deleted_at IS NULL
               AND e.return_gift_amount_fen IS NOT NULL AND e.return_gift_amount_fen > 0
             ORDER BY e.return_gifted_at DESC, e.updated_at DESC",
        )
        .map_err(|e| e.to_string())?;
    let rows = statement
        .query_map([], |row| {
            let person_id: String = row.get(3)?;
            Ok(ReturnGiftRecord {
                entry_id: row.get(0)?,
                book_id: row.get(1)?,
                book_title: row.get(2)?,
                person_id: person_id.clone(),
                person_name: row.get(4)?,
                address: row.get(5)?,
                return_gift_amount_fen: read_money_fen(row, 6)?,
                return_gifted_at: row.get::<_, Option<String>>(7)?.unwrap_or_default(),
                return_gift: row.get(8)?,
                tags: tags_by_person.get(&person_id).cloned().unwrap_or_default(),
            })
        })
        .map_err(|e| e.to_string())?;
    let records = rows
        .collect::<Result<Vec<ReturnGiftRecord>, _>>()
        .map_err(|e| e.to_string())?;
    checked_money_total(records.iter().map(|record| record.return_gift_amount_fen))?;
    Ok(records)
}

fn outbound_tag_names(connection: &Connection, raw: &str) -> (Vec<String>, Vec<String>) {
    let tags = serde_json::from_str::<Vec<String>>(raw).unwrap_or_default();
    let names = tags
        .iter()
        .filter_map(|id| {
            connection
                .query_row(
                    "SELECT name FROM tags WHERE id = ? AND deleted_at IS NULL",
                    params![id],
                    |row| row.get::<_, String>(0),
                )
                .optional()
                .ok()
                .flatten()
        })
        .collect();
    (tags, names)
}

fn list_outbound_gifts_from_connection(
    connection: &Connection,
) -> Result<Vec<OutboundGift>, String> {
    let mut statement = connection.prepare(
        "SELECT id, person_name, amount_fen, given_at, note, tag_snapshot FROM outbound_gifts WHERE deleted_at IS NULL ORDER BY given_at DESC, updated_at DESC"
    ).map_err(|e| e.to_string())?;
    let rows = statement
        .query_map([], |row| {
            Ok((
                row.get::<_, String>(0)?,
                row.get::<_, String>(1)?,
                read_money_fen(row, 2)?,
                row.get::<_, String>(3)?,
                row.get::<_, Option<String>>(4)?,
                row.get::<_, String>(5)?,
            ))
        })
        .map_err(|e| e.to_string())?;
    rows.map(|row| {
        let (id, person_name, amount_fen, given_at, note, tag_snapshot) =
            row.map_err(|e| e.to_string())?;
        let (tags, tag_names) = outbound_tag_names(connection, &tag_snapshot);
        Ok(OutboundGift {
            id,
            person_name,
            amount_fen,
            given_at,
            note,
            tags,
            tag_names,
        })
    })
    .collect()
}

#[tauri::command]
fn list_outbound_gifts(
    vault_path: String,
    state: State<'_, AppState>,
) -> Result<Vec<OutboundGift>, String> {
    let connection = scoped_read_connection(&state, &vault_path)?;
    if !table_exists(&connection, "outbound_gifts")? {
        return Ok(Vec::new());
    }
    list_outbound_gifts_from_connection(&connection)
}

#[tauri::command]
fn outbound_gift_summary(
    vault_path: String,
    state: State<'_, AppState>,
) -> Result<OutboundGiftSummary, String> {
    let connection = scoped_read_connection(&state, &vault_path)?;
    if !table_exists(&connection, "outbound_gifts")? {
        return Ok(OutboundGiftSummary {
            gift_count: 0,
            highest_amount_fen: 0,
            total_fen: 0,
        });
    }
    connection.query_row(
        "SELECT COUNT(*), COALESCE(MAX(amount_fen), 0), COALESCE(SUM(amount_fen), 0) FROM outbound_gifts WHERE deleted_at IS NULL", [],
        |row| Ok(OutboundGiftSummary { gift_count: row.get(0)?, highest_amount_fen: read_money_fen(row, 1)?, total_fen: read_money_fen(row, 2)? })
    ).map_err(|e| e.to_string())
}

fn save_outbound_gift(
    id: Option<String>,
    input: OutboundGiftInput,
    vault_path: String,
    state: &State<'_, AppState>,
) -> Result<OutboundGift, String> {
    let _operation = begin_operation()?;
    if input.person_name.trim().is_empty() {
        return Err("姓名不能为空".into());
    }
    validate_amount(input.amount_fen)?;
    validate_date(&input.given_at, false)?;
    validate_text("备注", &input.note, 65536)?;
    let mut connection = admin_connection(state, &vault_path, "save-outbound-gift", false)?;
    let transaction = connection.transaction().map_err(|e| e.to_string())?;
    let now_value = now();
    let gift_id = id.unwrap_or_else(|| Uuid::new_v4().to_string());
    let tag_snapshot = serde_json::to_string(&input.tag_ids).map_err(|e| e.to_string())?;
    if transaction
        .query_row(
            "SELECT COUNT(*) FROM outbound_gifts WHERE id = ?",
            params![gift_id],
            |row| row.get::<_, i64>(0),
        )
        .map_err(|e| e.to_string())?
        == 0
    {
        transaction.execute("INSERT INTO outbound_gifts(id, person_name, amount_fen, given_at, note, tag_snapshot, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)", params![gift_id, input.person_name.trim(), input.amount_fen, input.given_at, null_if_empty(&input.note), tag_snapshot, now_value, now_value]).map_err(|e| e.to_string())?;
        write_audit_detail(
            &transaction,
            "create",
            "outbound_gift",
            &gift_id,
            AuditPayload {
                person_id: None,
                target: input.person_name.trim().into(),
                book_title: None,
                description: "登记我的随礼".into(),
                changes: Vec::new(),
            },
        )?;
    } else {
        let changed = transaction.execute("UPDATE outbound_gifts SET person_name=?, amount_fen=?, given_at=?, note=?, tag_snapshot=?, updated_at=? WHERE id=? AND deleted_at IS NULL", params![input.person_name.trim(), input.amount_fen, input.given_at, null_if_empty(&input.note), tag_snapshot, now_value, gift_id]).map_err(|e| e.to_string())?;
        if changed == 0 {
            return Err("随礼记录不存在或已删除".into());
        }
        write_audit_detail(
            &transaction,
            "update",
            "outbound_gift",
            &gift_id,
            AuditPayload {
                person_id: None,
                target: input.person_name.trim().into(),
                book_title: None,
                description: "编辑我的随礼".into(),
                changes: Vec::new(),
            },
        )?;
    }
    transaction.commit().map_err(|e| e.to_string())?;
    let (tags, tag_names) = outbound_tag_names(
        &connection,
        &serde_json::to_string(&input.tag_ids).unwrap_or_default(),
    );
    Ok(OutboundGift {
        id: gift_id,
        person_name: input.person_name.trim().into(),
        amount_fen: input.amount_fen,
        given_at: input.given_at,
        note: null_if_empty(&input.note),
        tags,
        tag_names,
    })
}

#[tauri::command(async)]
fn create_outbound_gift(
    input: OutboundGiftInput,
    vault_path: String,
    state: State<'_, AppState>,
) -> Result<OutboundGift, String> {
    save_outbound_gift(None, input, vault_path, &state)
}

#[tauri::command(async)]
fn update_outbound_gift(
    id: String,
    input: OutboundGiftInput,
    vault_path: String,
    state: State<'_, AppState>,
) -> Result<OutboundGift, String> {
    save_outbound_gift(Some(id), input, vault_path, &state)
}

#[tauri::command(async)]
fn delete_outbound_gift(
    id: String,
    vault_path: String,
    state: State<'_, AppState>,
) -> Result<(), String> {
    let _operation = begin_operation()?;
    let mut connection = admin_connection(&state, &vault_path, "delete-outbound-gift", false)?;
    let transaction = connection.transaction().map_err(|e| e.to_string())?;
    let target: String = transaction
        .query_row(
            "SELECT person_name FROM outbound_gifts WHERE id=? AND deleted_at IS NULL",
            params![id],
            |row| row.get(0),
        )
        .optional()
        .map_err(|e| e.to_string())?
        .ok_or("随礼记录不存在或已删除")?;
    let changed = transaction.execute("UPDATE outbound_gifts SET deleted_at=?, updated_at=? WHERE id=? AND deleted_at IS NULL", params![now(), now(), id]).map_err(|e| e.to_string())?;
    if changed == 0 {
        return Err("随礼记录不存在或已删除".into());
    }
    write_audit_detail(
        &transaction,
        "delete",
        "outbound_gift",
        &id,
        AuditPayload {
            person_id: None,
            target,
            book_title: None,
            description: "将随礼记录移入回收站".into(),
            changes: Vec::new(),
        },
    )?;
    transaction.commit().map_err(|e| e.to_string())
}

#[tauri::command(async)]
fn update_return_gift_information(
    entry_id: String,
    amount_fen: i64,
    return_gift: String,
    vault_path: String,
    state: State<'_, AppState>,
) -> Result<ReturnGiftRecord, String> {
    let _operation = begin_operation()?;
    validate_amount(amount_fen)?;
    let audit_vault_path =
        displayable_path(&canonical_opened_vault_path(&state, Some(&vault_path))?);
    let mut connection =
        admin_connection(&state, &vault_path, "update-return-gift-information", false)?;
    let transaction = connection.transaction().map_err(|e| e.to_string())?;
    let snapshot = transaction
    .query_row(
        "SELECT b.id, b.title, p.id, p.display_name, p.address, e.return_gift_amount_fen, e.return_gifted_at, e.return_gift
         FROM gift_entries e
         JOIN gift_books b ON b.id = e.book_id
         JOIN people p ON p.id = e.person_id
         WHERE e.id = ? AND e.deleted_at IS NULL AND b.deleted_at IS NULL AND p.deleted_at IS NULL
           AND e.return_gift_amount_fen IS NOT NULL AND e.return_gift_amount_fen > 0",
        params![entry_id],
        |row| Ok(ReturnGiftUpdateSnapshot {
            book_id: row.get(0)?,
            book_title: row.get(1)?,
            person_id: row.get(2)?,
            person_name: row.get(3)?,
            address: row.get(4)?,
            previous_amount: row.get(5)?,
            return_gifted_at: row.get(6)?,
            return_gift: row.get(7)?,
        }),
    )
    .optional()
    .map_err(|e| e.to_string())?
    .ok_or_else(|| "回礼记录不存在或已被删除".to_string())?;
    if return_gift != snapshot.return_gift.as_deref().unwrap_or_default() {
        validate_text("回礼备注", &return_gift, 65536)?;
    }
    let saved_return_gift = if return_gift == snapshot.return_gift.as_deref().unwrap_or_default() {
        snapshot.return_gift.clone()
    } else {
        null_if_empty(&return_gift)
    };
    let stored_return_time = snapshot.return_gifted_at.unwrap_or_default();
    let timestamp = now();
    transaction
    .execute(
        "UPDATE gift_entries SET return_gift_amount_fen = ?, return_gift = ?, updated_at = ? WHERE id = ? AND deleted_at IS NULL",
        params![amount_fen, saved_return_gift, timestamp, entry_id],
    )
    .map_err(|e| e.to_string())?;
    let mut changes = Vec::new();
    if snapshot.previous_amount != amount_fen {
        changes.push(machine_change(
            "回礼金额",
            "return_gift_amount_fen",
            snapshot.previous_amount,
            amount_fen,
        ));
    }
    if snapshot.return_gift != saved_return_gift {
        changes.push(machine_change(
            "回礼备注",
            "return_gift",
            &snapshot.return_gift,
            &saved_return_gift,
        ));
    }
    if !changes.is_empty() {
        write_audit_detail_with_context(
            &transaction,
            "update",
            "gift_entry",
            &entry_id,
            AuditPayload {
                person_id: None,
                target: snapshot.person_name.clone(),
                book_title: Some(snapshot.book_title.clone()),
                description: "编辑回礼信息".to_string(),
                changes,
            },
            Some(AuditContext {
                person_id: snapshot.person_id.clone(),
                vault_id: audit_vault_id(&transaction)?,
                vault_path: audit_vault_path,
                book_id: Some(snapshot.book_id.clone()),
                book_ids: vec![snapshot.book_id.clone()],
                book_titles: vec![snapshot.book_title.clone()],
            }),
        )?;
    }
    let tags = person_tag_map(&transaction)?
        .get(&snapshot.person_id)
        .cloned()
        .unwrap_or_default();
    transaction.commit().map_err(|e| e.to_string())?;
    Ok(ReturnGiftRecord {
        entry_id,
        book_id: snapshot.book_id,
        book_title: snapshot.book_title,
        person_id: snapshot.person_id,
        person_name: snapshot.person_name,
        address: snapshot.address,
        return_gift_amount_fen: amount_fen,
        return_gifted_at: stored_return_time,
        return_gift: saved_return_gift,
        tags,
    })
}

#[tauri::command]
fn search_vault(
    query: String,
    vault_paths: Vec<String>,
    vault_path: String,
    state: State<'_, AppState>,
) -> Result<SearchResponse, String> {
    let active_path = canonical_opened_vault_path(&state, Some(&vault_path))?;
    if query.trim().is_empty() {
        return Ok(SearchResponse {
            results: Vec::new(),
            truncated: false,
            total_matches: 0,
            searched_vaults: Vec::new(),
        });
    }
    let opened_paths = opened_vault_paths(&state)?;
    let requested_paths = resolve_opened_search_paths(&vault_paths, &opened_paths, &active_path);
    let mut hits = Vec::new();
    let mut searched_vaults = Vec::new();
    for path in requested_paths {
        let connection = open_comparison_connection(&path)?;
        let vault_name = comparison_vault_name(&connection, &path)?;
        let mut titles = HashMap::new();
        let mut statement = connection
            .prepare("SELECT id, title FROM gift_books WHERE deleted_at IS NULL")
            .map_err(|e| e.to_string())?;
        let rows = statement
            .query_map([], |row| {
                Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?))
            })
            .map_err(|e| e.to_string())?;
        for row in rows {
            let (id, title) = row.map_err(|e| e.to_string())?;
            titles.insert(id, title);
        }
        let mut vault_hits = 0;
        for entry in load_entries(&connection, None)? {
            let Some(book_title) = titles.get(&entry.book_id).cloned() else {
                continue;
            };
            let matched_fields = entry_match_fields(&entry, &book_title, &query);
            if !matched_fields.is_empty() {
                vault_hits += 1;
                hits.push(SearchHit {
                    entry,
                    vault_path: displayable_path(&path),
                    vault_name: vault_name.clone(),
                    book_title,
                    matched_fields,
                });
            }
        }
        searched_vaults.push(SearchVaultSummary {
            vault_path: displayable_path(&path),
            vault_name,
            match_count: vault_hits,
        });
    }
    let total_matches = hits.len();
    let truncated = total_matches > 100;
    hits.truncate(100);
    Ok(SearchResponse {
        results: hits,
        truncated,
        total_matches,
        searched_vaults,
    })
}

#[tauri::command(async)]
fn create_entry(
    input: CreateEntryInput,
    vault_path: String,
    state: State<'_, AppState>,
) -> Result<GiftEntry, String> {
    let _operation = begin_operation()?;
    let CreateEntryInput {
        book_id,
        person_name,
        address,
        amount_fen,
        payment_method,
        received_at,
        note,
        return_gift,
        return_gift_amount_fen,
        tag_ids,
    } = input;
    if person_name.trim().is_empty() {
        return Err("姓名不能为空".to_string());
    }
    validate_amount(amount_fen)?;
    if let Some(amount) = return_gift_amount_fen {
        validate_amount(amount)?;
    }
    for (label, value, maximum) in [
        ("姓名", &person_name, 256),
        ("地址", &address, 4096),
        ("支付方式", &payment_method, 256),
        ("备注", &note, 65536),
        ("回礼备注", &return_gift, 65536),
    ] {
        validate_text(label, value, maximum)?;
    }
    validate_date(&received_at, true)?;
    let mut connection = admin_connection(&state, &vault_path, "create-entry", false)?;
    let transaction = connection.transaction().map_err(|e| e.to_string())?;
    let book_exists: Option<String> = transaction
        .query_row(
            "SELECT id FROM gift_books WHERE id = ? AND deleted_at IS NULL",
            params![book_id],
            |row| row.get(0),
        )
        .optional()
        .map_err(|e| e.to_string())?;
    if book_exists.is_none() {
        return Err("礼金簿不存在".to_string());
    }
    let person_id = Uuid::new_v4().to_string();
    let saved_address = null_if_empty(&address);
    let timestamp = now();
    transaction.execute("INSERT INTO people(id, display_name, address, created_at, updated_at) VALUES (?, ?, ?, ?, ?)", params![person_id, person_name.trim(), saved_address, timestamp, timestamp]).map_err(|e| e.to_string())?;
    let id = Uuid::new_v4().to_string();
    let received_at = received_at_or_now(&received_at);
    let return_gifted_at = return_gift_amount_fen.map(|_| timestamp.clone());
    let tag_snapshot = serde_json::to_string(&tag_ids).map_err(|e| e.to_string())?;
    apply_entry_tags(&transaction, &person_id, &tag_ids)?;
    transaction.execute("INSERT INTO gift_entries(id, book_id, person_id, amount_fen, payment_method, received_at, note, return_gift, return_gift_amount_fen, return_gifted_at, tag_snapshot, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)", params![id, book_id, person_id, amount_fen, payment_method.trim(), received_at.trim(), null_if_empty(&note), null_if_empty(&return_gift), return_gift_amount_fen, return_gifted_at, tag_snapshot, timestamp, timestamp]).map_err(|e| e.to_string())?;
    transaction.commit().map_err(|e| e.to_string())?;
    Ok(GiftEntry {
        id,
        book_id,
        person_id,
        person_name: person_name.trim().to_string(),
        address: saved_address,
        amount_fen,
        payment_method: payment_method.trim().to_string(),
        received_at,
        note: null_if_empty(&note),
        return_gift: null_if_empty(&return_gift),
        return_gift_amount_fen,
        return_gifted_at,
        tags: tag_ids,
        tag_names: Vec::new(),
    })
}

#[tauri::command(async)]
fn update_entry(
    input: UpdateEntryInput,
    vault_path: String,
    state: State<'_, AppState>,
) -> Result<GiftEntry, String> {
    let _operation = begin_operation()?;
    let path = canonical_opened_vault_path(&state, Some(&vault_path))?;
    let mut connection = admin_connection(&state, &vault_path, "update-entry", false)?;
    update_entry_record(input, &mut connection, &displayable_path(&path))
}

fn update_entry_record(
    input: UpdateEntryInput,
    connection: &mut Connection,
    vault_path: &str,
) -> Result<GiftEntry, String> {
    let UpdateEntryInput {
        entry_id,
        person_name,
        address,
        amount_fen,
        payment_method,
        received_at,
        note,
        return_gift,
        return_gift_amount_fen,
        tag_ids,
    } = input;
    if person_name.trim().is_empty() {
        return Err("姓名不能为空".to_string());
    }
    validate_amount(amount_fen)?;
    if let Some(amount) = return_gift_amount_fen {
        validate_amount(amount)?;
    }
    let transaction = connection.transaction().map_err(|e| e.to_string())?;
    let audit_before = entry_audit_snapshot(&transaction, &entry_id)?;
    for (label, value, previous, maximum) in [
        (
            "姓名",
            person_name.as_str(),
            audit_before.person_name.as_str(),
            256,
        ),
        (
            "地址",
            address.as_str(),
            audit_before.address.as_deref().unwrap_or_default(),
            4096,
        ),
        (
            "支付方式",
            payment_method.as_str(),
            audit_before.payment_method.as_str(),
            256,
        ),
        (
            "备注",
            note.as_str(),
            audit_before.note.as_deref().unwrap_or_default(),
            65536,
        ),
        (
            "回礼备注",
            return_gift.as_str(),
            audit_before.return_gift.as_deref().unwrap_or_default(),
            65536,
        ),
    ] {
        if value != previous {
            validate_text(label, value, maximum)?;
        }
    }
    if received_at != audit_before.received_at {
        validate_date(&received_at, true)?;
    }
    let saved_note = if note == audit_before.note.as_deref().unwrap_or_default() {
        audit_before.note.clone()
    } else {
        null_if_empty(&note)
    };
    let saved_return_gift =
        if return_gift == audit_before.return_gift.as_deref().unwrap_or_default() {
            audit_before.return_gift.clone()
        } else {
            null_if_empty(&return_gift)
        };
    let saved_payment = if payment_method == audit_before.payment_method {
        payment_method.clone()
    } else {
        payment_method.trim().to_string()
    };
    let saved_name = if person_name == audit_before.person_name {
        person_name.clone()
    } else {
        person_name.trim().to_string()
    };
    let (book_id, current_person_id, current_person_name, current_person_address, existing_return_gifted_at): (String, String, String, Option<String>, Option<String>) = transaction
        .query_row(
            "SELECT e.book_id, e.person_id, p.display_name, p.address, e.return_gifted_at
             FROM gift_entries e
             JOIN gift_books b ON b.id = e.book_id
             JOIN people p ON p.id = e.person_id
             WHERE e.id = ? AND e.deleted_at IS NULL AND b.deleted_at IS NULL AND p.deleted_at IS NULL",
            params![entry_id],
            |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?, row.get(3)?, row.get(4)?)),
        )
        .optional()
        .map_err(|e| e.to_string())?
        .ok_or_else(|| "礼金记录不存在或已在回收站中".to_string())?;

    let requested_address = if address == current_person_address.as_deref().unwrap_or_default() {
        current_person_address.clone()
    } else {
        null_if_empty(&address)
    };
    let same_person = current_person_name == saved_name
        && current_person_address.as_deref() == requested_address.as_deref();
    let (person_id, saved_address) = if same_person {
        (current_person_id, current_person_address)
    } else {
        let id = Uuid::new_v4().to_string();
        let timestamp = now();
        transaction
            .execute(
                "INSERT INTO people(id, display_name, address, created_at, updated_at) VALUES (?, ?, ?, ?, ?)",
                params![id, saved_name, requested_address, timestamp, timestamp],
            )
            .map_err(|e| e.to_string())?;
        (id, requested_address)
    };
    let timestamp = now();
    let received_at = if received_at == audit_before.received_at {
        received_at
    } else {
        normalize_imported_received_at(&received_at)
    };
    let return_gifted_at = if return_gift_amount_fen.is_none() {
        None
    } else if audit_before.return_gift_amount_fen.is_some() {
        existing_return_gifted_at
    } else {
        Some(timestamp.clone())
    };
    let tag_snapshot = serde_json::to_string(&tag_ids).map_err(|e| e.to_string())?;
    transaction
        .execute(
            "DELETE FROM person_tags WHERE person_id=?",
            params![person_id],
        )
        .map_err(|e| e.to_string())?;
    apply_entry_tags(&transaction, &person_id, &tag_ids)?;
    transaction
        .execute(
            "UPDATE gift_entries SET person_id = ?, amount_fen = ?, payment_method = ?, received_at = ?, note = ?, return_gift = ?, return_gift_amount_fen = ?, return_gifted_at = ?, tag_snapshot = ?, updated_at = ? WHERE id = ? AND deleted_at IS NULL",
            params![
                person_id,
                amount_fen,
                saved_payment,
                received_at,
                saved_note,
                saved_return_gift,
                return_gift_amount_fen,
                return_gifted_at,
                tag_snapshot,
                timestamp,
                entry_id
            ],
        )
        .map_err(|e| e.to_string())?;
    let audit_after = entry_audit_snapshot(&transaction, &entry_id)?;
    let changes = entry_audit_changes(&audit_before, &audit_after);
    if !changes.is_empty() {
        write_audit_detail_with_context(
            &transaction,
            "update",
            "gift_entry",
            &entry_id,
            AuditPayload {
                person_id: None,
                target: audit_after.person_name.clone(),
                book_title: Some(audit_after.book_title.clone()),
                description: "编辑人物信息".to_string(),
                changes,
            },
            Some(AuditContext {
                person_id: person_id.clone(),
                vault_id: audit_vault_id(&transaction)?,
                vault_path: vault_path.to_string(),
                book_id: Some(book_id.clone()),
                book_ids: vec![book_id.clone()],
                book_titles: vec![audit_after.book_title.clone()],
            }),
        )?;
    }
    transaction.commit().map_err(|e| e.to_string())?;
    Ok(GiftEntry {
        id: entry_id,
        book_id,
        person_id,
        person_name: saved_name,
        address: saved_address,
        amount_fen,
        payment_method: saved_payment,
        received_at,
        note: saved_note,
        return_gift: saved_return_gift,
        return_gift_amount_fen,
        return_gifted_at,
        tags: tag_ids,
        tag_names: Vec::new(),
    })
}

#[tauri::command(async)]
fn delete_entry(
    entry_id: String,
    vault_path: String,
    state: State<'_, AppState>,
) -> Result<(), String> {
    let _operation = begin_operation()?;
    let mut connection = admin_connection(&state, &vault_path, "delete-entry", false)?;
    let transaction = connection.transaction().map_err(|e| e.to_string())?;
    let snapshot = entry_audit_snapshot(&transaction, &entry_id)?;
    let timestamp = now();
    let changed = transaction.execute("UPDATE gift_entries SET deleted_at = ?, updated_at = ? WHERE id = ? AND deleted_at IS NULL", params![timestamp, timestamp, entry_id]).map_err(|e| e.to_string())?;
    if changed == 0 {
        return Err("礼金记录不存在或已在回收站中".to_string());
    }
    write_audit_detail(
        &transaction,
        "delete",
        "gift_entry",
        &entry_id,
        AuditPayload {
            person_id: None,
            target: snapshot.person_name,
            book_title: Some(snapshot.book_title),
            description: "将人物记录移入回收站".to_string(),
            changes: Vec::new(),
        },
    )?;
    transaction.commit().map_err(|e| e.to_string())
}

#[tauri::command(async)]
fn restore_entry(
    entry_id: String,
    vault_path: String,
    state: State<'_, AppState>,
) -> Result<(), String> {
    let _operation = begin_operation()?;
    let mut connection = admin_connection(&state, &vault_path, "restore-entry", false)?;
    restore_entry_record(&mut connection, &entry_id)
}

fn restore_entry_record(connection: &mut Connection, entry_id: &str) -> Result<(), String> {
    let transaction = connection.transaction().map_err(|e| e.to_string())?;
    ensure_entry_parents_active(&transaction, entry_id)?;
    let snapshot = entry_audit_snapshot(&transaction, entry_id)?;
    let timestamp = now();
    let changed = transaction.execute("UPDATE gift_entries SET deleted_at = NULL, updated_at = ? WHERE id = ? AND deleted_at IS NOT NULL", params![timestamp, entry_id]).map_err(|e| e.to_string())?;
    if changed == 0 {
        return Err("礼金记录不存在或未在回收站中".to_string());
    }
    write_audit_detail(
        &transaction,
        "restore",
        "gift_entry",
        entry_id,
        AuditPayload {
            person_id: None,
            target: snapshot.person_name,
            book_title: Some(snapshot.book_title),
            description: "从回收站恢复人物记录".to_string(),
            changes: Vec::new(),
        },
    )?;
    transaction.commit().map_err(|e| e.to_string())
}

fn ensure_entry_parents_active(connection: &Connection, entry_id: &str) -> Result<(), String> {
    let active: bool = connection.query_row(
        "SELECT EXISTS(SELECT 1 FROM gift_entries e JOIN people p ON p.id=e.person_id JOIN gift_books b ON b.id=e.book_id WHERE e.id=? AND p.deleted_at IS NULL AND b.deleted_at IS NULL)",
        params![entry_id], |row| row.get(0),
    ).map_err(|e| e.to_string())?;
    if !active {
        return Err("请先从回收站恢复所属人物和礼金簿，再恢复礼金记录".to_string());
    }
    Ok(())
}

fn ensure_person_restore_books_active(
    connection: &Connection,
    person_id: &str,
    deleted_at: &str,
) -> Result<(), String> {
    let deleted: bool = connection.query_row(
        "SELECT EXISTS(SELECT 1 FROM gift_entries e JOIN gift_books b ON b.id=e.book_id WHERE e.person_id=? AND e.deleted_at=? AND b.deleted_at IS NOT NULL)",
        params![person_id,deleted_at], |row| row.get(0),
    ).map_err(|e| e.to_string())?;
    if deleted {
        return Err("请先恢复人物所属的已删除礼金簿，再批量恢复人物及其记录".to_string());
    }
    Ok(())
}

#[tauri::command(async)]
fn delete_person(
    person_id: String,
    vault_path: String,
    state: State<'_, AppState>,
) -> Result<(), String> {
    let _operation = begin_operation()?;
    let audit_vault_path =
        displayable_path(&canonical_opened_vault_path(&state, Some(&vault_path))?);
    let mut connection = admin_connection(&state, &vault_path, "delete-person", true)?;
    let transaction = connection.transaction().map_err(|e| e.to_string())?;
    let person_name: String = transaction
        .query_row(
            "SELECT display_name FROM people WHERE id = ? AND deleted_at IS NULL",
            params![person_id],
            |row| row.get(0),
        )
        .optional()
        .map_err(|e| e.to_string())?
        .ok_or_else(|| "人物不存在或已在回收站中".to_string())?;
    let book_sources = audit_person_book_sources(&transaction, &person_id)?;
    let timestamp = now();
    transaction
    .execute(
        "UPDATE gift_entries SET deleted_at = ?, updated_at = ? WHERE person_id = ? AND deleted_at IS NULL",
        params![timestamp, timestamp, person_id],
    )
    .map_err(|e| e.to_string())?;
    transaction
        .execute(
            "UPDATE people SET deleted_at = ?, updated_at = ? WHERE id = ? AND deleted_at IS NULL",
            params![timestamp, timestamp, person_id],
        )
        .map_err(|e| e.to_string())?;
    let book_ids = book_sources
        .iter()
        .map(|(id, _)| id.clone())
        .collect::<Vec<_>>();
    let book_titles = book_sources
        .iter()
        .map(|(_, title)| title.clone())
        .collect::<Vec<_>>();
    write_audit_detail_with_context(
        &transaction,
        "delete",
        "person",
        &person_id,
        AuditPayload {
            person_id: None,
            target: person_name,
            book_title: book_titles.first().cloned(),
            description: "删除人物并移入回收站".to_string(),
            changes: Vec::new(),
        },
        Some(AuditContext {
            person_id: person_id.clone(),
            vault_id: audit_vault_id(&transaction)?,
            vault_path: audit_vault_path,
            book_id: book_ids.first().cloned(),
            book_ids,
            book_titles,
        }),
    )?;
    transaction.commit().map_err(|e| e.to_string())
}

fn restore_person_record(connection: &mut Connection, person_id: &str) -> Result<(), String> {
    let transaction = connection.transaction().map_err(|e| e.to_string())?;
    let (person_name, deleted_at): (String, String) = transaction
        .query_row(
            "SELECT display_name, deleted_at FROM people WHERE id = ? AND deleted_at IS NOT NULL",
            params![person_id],
            |row| Ok((row.get(0)?, row.get(1)?)),
        )
        .optional()
        .map_err(|e| e.to_string())?
        .ok_or_else(|| "人物不存在或不在回收站中".to_string())?;
    ensure_person_restore_books_active(&transaction, person_id, &deleted_at)?;
    let timestamp = now();
    transaction
        .execute(
            "UPDATE people SET deleted_at = NULL, updated_at = ? WHERE id = ?",
            params![timestamp, person_id],
        )
        .map_err(|e| e.to_string())?;
    transaction
        .execute(
            "UPDATE gift_entries SET deleted_at = NULL, updated_at = ? WHERE person_id = ? AND deleted_at = ?",
            params![timestamp, person_id, deleted_at],
        )
        .map_err(|e| e.to_string())?;
    write_audit_detail(
        &transaction,
        "restore",
        "person",
        person_id,
        AuditPayload {
            person_id: None,
            target: person_name,
            book_title: None,
            description: "从回收站恢复人物及其礼金记录".to_string(),
            changes: Vec::new(),
        },
    )?;
    transaction.commit().map_err(|e| e.to_string())
}

#[tauri::command(async)]
fn restore_person(
    person_id: String,
    vault_path: String,
    state: State<'_, AppState>,
) -> Result<(), String> {
    let _operation = begin_operation()?;
    let mut connection = admin_connection(&state, &vault_path, "restore-person", false)?;
    restore_person_record(&mut connection, &person_id)
}

fn list_trash_from_connection(
    connection: &Connection,
    vault_path: Option<&Path>,
) -> Result<Vec<TrashItem>, String> {
    let mut items = Vec::new();
    let mut books = connection
        .prepare("SELECT id, title, deleted_at FROM gift_books WHERE deleted_at IS NOT NULL ORDER BY deleted_at DESC")
        .map_err(|e| e.to_string())?;
    let book_rows = books
        .query_map([], |row| {
            let title: String = row.get(1)?;
            Ok(TrashItem {
                id: row.get(0)?,
                kind: "book".to_string(),
                vault_path: vault_path.map(displayable_path),
                title: title.clone(),
                book_title: title,
                deleted_at: row.get(2)?,
            })
        })
        .map_err(|e| e.to_string())?;
    items.extend(
        book_rows
            .collect::<Result<Vec<_>, _>>()
            .map_err(|e| e.to_string())?,
    );

    let mut entries = connection
        .prepare("SELECT e.id, p.display_name, b.title, e.deleted_at FROM gift_entries e JOIN people p ON p.id = e.person_id JOIN gift_books b ON b.id = e.book_id WHERE e.deleted_at IS NOT NULL AND b.deleted_at IS NULL ORDER BY e.deleted_at DESC")
        .map_err(|e| e.to_string())?;
    let entry_rows = entries
        .query_map([], |row| {
            Ok(TrashItem {
                id: row.get(0)?,
                kind: "entry".to_string(),
                vault_path: vault_path.map(displayable_path),
                title: row.get(1)?,
                book_title: row.get(2)?,
                deleted_at: row.get(3)?,
            })
        })
        .map_err(|e| e.to_string())?;
    items.extend(
        entry_rows
            .collect::<Result<Vec<_>, _>>()
            .map_err(|e| e.to_string())?,
    );
    if table_exists(connection, "outbound_gifts")? {
        let mut gifts = connection.prepare("SELECT id, person_name, deleted_at FROM outbound_gifts WHERE deleted_at IS NOT NULL ORDER BY deleted_at DESC").map_err(|e| e.to_string())?;
        let rows = gifts
            .query_map([], |row| {
                Ok(TrashItem {
                    id: row.get(0)?,
                    kind: "outbound_gift".to_string(),
                    vault_path: vault_path.map(displayable_path),
                    title: row.get(1)?,
                    book_title: "我的随礼".to_string(),
                    deleted_at: row.get(2)?,
                })
            })
            .map_err(|e| e.to_string())?;
        items.extend(
            rows.collect::<Result<Vec<_>, _>>()
                .map_err(|e| e.to_string())?,
        );
    }
    let mut tags = connection
        .prepare("SELECT id, name, deleted_at FROM tags WHERE deleted_at IS NOT NULL ORDER BY deleted_at DESC")
        .map_err(|e| e.to_string())?;
    let tag_rows = tags
        .query_map([], |row| {
            Ok(TrashItem {
                id: row.get(0)?,
                kind: "tag".to_string(),
                vault_path: vault_path.map(displayable_path),
                title: row.get(1)?,
                book_title: "人物标签".to_string(),
                deleted_at: row.get(2)?,
            })
        })
        .map_err(|e| e.to_string())?;
    items.extend(
        tag_rows
            .collect::<Result<Vec<_>, _>>()
            .map_err(|e| e.to_string())?,
    );
    let mut people = connection
        .prepare("SELECT id, display_name, deleted_at FROM people WHERE deleted_at IS NOT NULL ORDER BY deleted_at DESC")
        .map_err(|e| e.to_string())?;
    let person_rows = people
        .query_map([], |row| {
            Ok(TrashItem {
                id: row.get(0)?,
                kind: "person".to_string(),
                vault_path: vault_path.map(displayable_path),
                title: row.get(1)?,
                book_title: "人物及其礼金记录".to_string(),
                deleted_at: row.get(2)?,
            })
        })
        .map_err(|e| e.to_string())?;
    items.extend(
        person_rows
            .collect::<Result<Vec<_>, _>>()
            .map_err(|e| e.to_string())?,
    );
    Ok(items)
}

#[tauri::command(async)]
fn list_trash(state: State<'_, AppState>) -> Result<Vec<TrashItem>, String> {
    let mut items = Vec::new();
    for path in opened_vault_paths(&state)? {
        let canonical = path.canonicalize().unwrap_or(path);
        if !canonical.is_file() {
            continue;
        }
        let Ok(connection) = open_comparison_connection(&canonical) else {
            continue;
        };
        items.extend(list_trash_from_connection(&connection, Some(&canonical))?);
    }
    for manifest in read_vault_trash_manifests()? {
        items.push(TrashItem {
            id: manifest.id,
            kind: "vault".to_string(),
            vault_path: None,
            title: manifest.name,
            book_title: "礼金库文件".to_string(),
            deleted_at: manifest.deleted_at,
        });
    }
    items.sort_by(|left, right| right.deleted_at.cmp(&left.deleted_at));
    Ok(items)
}

#[tauri::command]
fn list_audit_logs(
    vault_path: String,
    state: State<'_, AppState>,
) -> Result<Vec<AuditLog>, String> {
    let connection = scoped_read_connection(&state, &vault_path)?;
    list_audit_logs_from_connection(&connection)
}

fn list_audit_logs_from_connection(connection: &Connection) -> Result<Vec<AuditLog>, String> {
    let mut statement = connection
        .prepare(
            "SELECT id, action, entity_type, entity_id, payload, created_at
             FROM audit_logs
             WHERE ((entity_type IN ('gift_entry', 'return_gift', 'outbound_gift') AND action IN ('update', 'delete', 'restore', 'create'))
                 OR (entity_type = 'person' AND action IN ('update', 'delete', 'restore'))
                 OR (entity_type = 'gift_book' AND action IN ('update', 'delete', 'restore'))
                 OR (entity_type = 'vault' AND action = 'update'))
             ORDER BY created_at DESC, rowid DESC",
        )
        .map_err(|error| error.to_string())?;
    let rows = statement
        .query_map([], |row| {
            let raw_payload: Option<String> = row.get(4)?;
            let payload = raw_payload
                .as_deref()
                .and_then(|value| serde_json::from_str::<AuditPayload>(value).ok())
                .unwrap_or_else(|| AuditPayload {
                    person_id: None,
                    target: "历史记录".to_string(),
                    book_title: None,
                    description: "历史记录未保存具体变更内容".to_string(),
                    changes: Vec::new(),
                });
            Ok((
                row.get::<_, String>(0)?,
                row.get::<_, String>(1)?,
                row.get::<_, String>(2)?,
                row.get::<_, String>(3)?,
                payload,
                row.get::<_, String>(5)?,
                raw_payload,
            ))
        })
        .map_err(|error| error.to_string())?;
    let rows = rows
        .collect::<Result<Vec<_>, _>>()
        .map_err(|error| error.to_string())?;
    drop(statement);
    let mut logs = Vec::with_capacity(rows.len());
    for (id, action, entity_type, entity_id, mut payload, created_at, raw_payload) in rows {
        if entity_type == "person" {
            let contextual_titles = raw_payload
                .as_deref()
                .and_then(|value| serde_json::from_str::<serde_json::Value>(value).ok())
                .and_then(|value| value.get("bookTitles").cloned())
                .and_then(|value| value.as_array().cloned())
                .map(|titles| {
                    titles
                        .into_iter()
                        .filter_map(|title| title.as_str().map(str::to_string))
                        .collect::<Vec<_>>()
                })
                .filter(|titles| !titles.is_empty());
            if let Some(titles) = contextual_titles {
                payload.book_title = Some(titles.join("、"));
            } else if payload.book_title.is_none() {
                payload.book_title = Some(audit_person_book_titles(connection, &entity_id)?);
            }
        }
        let tag_identity =
            if action == "update" && matches!(entity_type.as_str(), "gift_entry" | "return_gift") {
                audit_entry_tag_target(
                    connection,
                    &entity_id,
                    &payload.changes,
                    payload.person_id.as_deref(),
                )
            } else {
                Ok(None)
            };
        let mut record = AuditLog {
            id,
            entity_id,
            action,
            entity_type,
            target: payload.target,
            book_title: payload.book_title,
            description: payload.description,
            changes: payload.changes,
            created_at,
            reversible: false,
            reversible_reason: None,
        };
        record.reversible = tag_identity.is_ok() && audit_record_is_reversible(connection, &record);
        if !record.reversible {
            record.reversible_reason = Some(tag_identity.err().unwrap_or_else(|| {
                "目标已删除、缺少依赖或旧快照存在歧义，历史记录已保留".to_string()
            }));
        }
        logs.push(record);
    }
    Ok(logs)
}

fn audit_record_is_reversible(connection: &Connection, record: &AuditLog) -> bool {
    if (record.entity_type == "gift_entry" || record.entity_type == "return_gift")
        && record.action != "restore"
        && ensure_entry_parents_active(connection, &record.entity_id).is_err()
    {
        return false;
    }
    if record.action == "delete" && record.entity_type == "person" {
        let deleted_at = connection
            .query_row(
                "SELECT deleted_at FROM people WHERE id=?",
                params![record.entity_id],
                |row| row.get::<_, Option<String>>(0),
            )
            .ok()
            .flatten();
        if deleted_at.as_deref().is_none_or(|value| {
            ensure_person_restore_books_active(connection, &record.entity_id, value).is_err()
        }) {
            return false;
        }
    }
    if record.action == "update" {
        if record.changes.is_empty() {
            return false;
        }
        if !record
            .changes
            .iter()
            .all(|change| audit_change_is_reversible(connection, record, change))
        {
            return false;
        }
        let query = match record.entity_type.as_str() {
            "gift_entry" | "return_gift" => {
                "SELECT EXISTS(SELECT 1 FROM gift_entries WHERE id = ? AND deleted_at IS NULL)"
            }
            "person" => "SELECT EXISTS(SELECT 1 FROM people WHERE id = ? AND deleted_at IS NULL)",
            "gift_book" => {
                "SELECT EXISTS(SELECT 1 FROM gift_books WHERE id = ? AND deleted_at IS NULL)"
            }
            "vault" => "SELECT EXISTS(SELECT 1 FROM vault_meta WHERE key = 'vault_id')",
            _ => return false,
        };
        return connection
            .query_row(query, params![record.entity_id], |row| {
                row.get::<_, bool>(0)
            })
            .unwrap_or(false);
    }
    let query = match (record.action.as_str(), record.entity_type.as_str()) {
        ("delete", "gift_entry") => {
            "SELECT EXISTS(SELECT 1 FROM gift_entries WHERE id = ? AND deleted_at IS NOT NULL)"
        }
        ("restore", "gift_entry") => {
            "SELECT EXISTS(SELECT 1 FROM gift_entries WHERE id = ? AND deleted_at IS NULL)"
        }
        ("delete", "person") => {
            "SELECT EXISTS(SELECT 1 FROM people WHERE id = ? AND deleted_at IS NOT NULL)"
        }
        ("restore", "person") => {
            "SELECT EXISTS(SELECT 1 FROM people WHERE id = ? AND deleted_at IS NULL)"
        }
        ("delete", "gift_book") => {
            "SELECT EXISTS(SELECT 1 FROM gift_books WHERE id = ? AND deleted_at IS NOT NULL)"
        }
        ("restore", "gift_book") => {
            "SELECT EXISTS(SELECT 1 FROM gift_books WHERE id = ? AND deleted_at IS NULL)"
        }
        _ => return false,
    };
    connection
        .query_row(query, params![record.entity_id], |row| {
            row.get::<_, bool>(0)
        })
        .unwrap_or(false)
}

fn audit_change_is_reversible(
    connection: &Connection,
    record: &AuditLog,
    change: &AuditChange,
) -> bool {
    let entry = matches!(record.entity_type.as_str(), "gift_entry" | "return_gift");
    if let Some(machine) = &change.machine {
        if machine.version != 1 {
            return false;
        }
        let supported = match record.entity_type.as_str() {
            "gift_entry" | "return_gift" => matches!(
                machine.field_id.as_str(),
                "person_id"
                    | "person_name"
                    | "address"
                    | "amount_fen"
                    | "payment_method"
                    | "received_at"
                    | "note"
                    | "return_gift"
                    | "return_gift_amount_fen"
                    | "return_gifted_at"
                    | "tag_ids"
            ),
            "gift_book" => matches!(
                machine.field_id.as_str(),
                "title" | "occasion" | "event_date" | "location" | "notes"
            ),
            "vault" => matches!(machine.field_id.as_str(), "name" | "notes"),
            "person" => machine.field_id == "tag_ids",
            _ => false,
        };
        if !supported {
            return false;
        }
        if machine.field_id == "tag_ids" {
            let Ok(ids) = serde_json::from_value::<Vec<String>>(machine.before.clone()) else {
                return false;
            };
            return ids.iter().all(|id| {
                connection
                    .query_row(
                        "SELECT EXISTS(SELECT 1 FROM tags WHERE id=? AND deleted_at IS NULL)",
                        params![id],
                        |row| row.get::<_, bool>(0),
                    )
                    .unwrap_or(false)
            });
        }
        if machine.field_id == "person_id" {
            let (Some(before), Some(after)) = (machine.before.as_str(), machine.after.as_str())
            else {
                return false;
            };
            return connection.query_row("SELECT EXISTS(SELECT 1 FROM gift_entries e JOIN people p ON p.id=? AND p.deleted_at IS NULL WHERE e.id=? AND e.person_id=? AND e.deleted_at IS NULL)",params![before,record.entity_id,after],|row|row.get::<_,bool>(0)).unwrap_or(false);
        }
        if entry && matches!(machine.field_id.as_str(), "person_name" | "address") {
            return record.changes.iter().any(|item| {
                item.machine
                    .as_ref()
                    .is_some_and(|value| value.field_id == "person_id")
            });
        }
        if matches!(
            machine.field_id.as_str(),
            "amount_fen" | "return_gift_amount_fen"
        ) {
            return (machine.field_id == "return_gift_amount_fen" && machine.before.is_null())
                || machine
                    .before
                    .as_i64()
                    .is_some_and(|amount| validate_amount(amount).is_ok());
        }
        return machine.before.is_null() || machine.before.is_string();
    }
    if matches!(change.before.as_str(), "未填写" | "未设置") {
        return false;
    }
    match (record.entity_type.as_str(), change.field.as_str()) {
        ("gift_entry" | "return_gift", "金额" | "回礼金额") => {
            parse_amount_fen(&change.before).is_some_and(|value| value > 0)
        }
        ("gift_entry" | "return_gift", "支付方式" | "登记日期" | "备注" | "回礼备注") => {
            true
        }
        ("gift_entry" | "return_gift" | "person", "人物标签") => {
            !change.before.contains('、')
                && (change.before.is_empty()
                    || connection
                        .query_row(
                            "SELECT EXISTS(SELECT 1 FROM tags WHERE name=? AND deleted_at IS NULL)",
                            params![change.before],
                            |row| row.get::<_, bool>(0),
                        )
                        .unwrap_or(false))
        }
        ("gift_book", "礼金簿名称" | "活动类型" | "活动日期" | "地点" | "备注") => {
            true
        }
        ("vault", "礼金库名称" | "礼金库备注") => true,
        _ => false,
    }
}

#[tauri::command]
fn delete_audit_logs(connection: &Connection, ids: &[String]) -> Result<usize, String> {
    let scope = "((entity_type IN ('gift_entry', 'return_gift') AND action IN ('update', 'delete', 'restore'))
                   OR (entity_type = 'person' AND action IN ('update', 'delete', 'restore'))
                   OR (entity_type = 'gift_book' AND action IN ('update', 'delete', 'restore'))
                   OR (entity_type = 'vault' AND action = 'update'))";
    if ids.is_empty() {
        connection
            .execute(&format!("DELETE FROM audit_logs WHERE {scope}"), [])
            .map_err(|error| error.to_string())
    } else {
        let placeholders = (0..ids.len()).map(|_| "?").collect::<Vec<_>>().join(", ");
        connection
            .execute(
                &format!("DELETE FROM audit_logs WHERE {scope} AND id IN ({placeholders})"),
                params_from_iter(ids.iter()),
            )
            .map_err(|error| error.to_string())
    }
}

fn restore_person_tag_names(
    transaction: &Transaction<'_>,
    person_id: &str,
    value: &str,
) -> Result<(), String> {
    if value.contains('、') {
        return Err("旧标签快照使用分隔符，无法区分组合名称与多个标签，未执行恢复".to_string());
    }
    transaction
        .execute(
            "DELETE FROM person_tags WHERE person_id = ?",
            params![person_id],
        )
        .map_err(|e| e.to_string())?;
    if matches!(value, "未设置" | "未填写") || value.trim().is_empty() {
        return Ok(());
    }
    for name in value
        .split('、')
        .map(str::trim)
        .filter(|name| !name.is_empty())
    {
        let tag_id: Option<String> = transaction
            .query_row(
                "SELECT id FROM tags WHERE name = ? AND deleted_at IS NULL",
                params![name],
                |row| row.get(0),
            )
            .optional()
            .map_err(|e| e.to_string())?;
        let tag_id = tag_id.ok_or_else(|| format!("历史恢复依赖的标签不存在：{name}"))?;
        transaction
            .execute(
                "INSERT OR IGNORE INTO person_tags(person_id, tag_id) VALUES (?, ?)",
                params![person_id, tag_id],
            )
            .map_err(|e| e.to_string())?;
    }
    Ok(())
}

fn restore_deleted_audit_entity(
    transaction: &Transaction<'_>,
    entity_type: &str,
    entity_id: &str,
) -> Result<(), String> {
    let timestamp = now();
    match entity_type {
        "gift_entry" => {
            ensure_entry_parents_active(transaction, entity_id)?;
            let changed = transaction
                .execute(
                    "UPDATE gift_entries SET deleted_at = NULL, updated_at = ? WHERE id = ? AND deleted_at IS NOT NULL",
                    params![timestamp, entity_id],
                )
                .map_err(|e| e.to_string())?;
            if changed == 0 {
                return Err("礼金记录不在回收站中，无法通过历史改动恢复".to_string());
            }
        }
        "person" => {
            let deleted_at: String = transaction
                .query_row(
                    "SELECT deleted_at FROM people WHERE id = ? AND deleted_at IS NOT NULL",
                    params![entity_id],
                    |row| row.get(0),
                )
                .optional()
                .map_err(|e| e.to_string())?
                .ok_or_else(|| "人物不在回收站中，无法通过历史改动恢复".to_string())?;
            ensure_person_restore_books_active(transaction, entity_id, &deleted_at)?;
            transaction
                .execute(
                    "UPDATE people SET deleted_at = NULL, updated_at = ? WHERE id = ?",
                    params![timestamp, entity_id],
                )
                .map_err(|e| e.to_string())?;
            transaction
                .execute(
                    "UPDATE gift_entries SET deleted_at = NULL, updated_at = ? WHERE person_id = ? AND deleted_at = ?",
                    params![timestamp, entity_id, deleted_at],
                )
                .map_err(|e| e.to_string())?;
        }
        "gift_book" => {
            let changed = transaction
                .execute(
                    "UPDATE gift_books SET deleted_at = NULL, updated_at = ? WHERE id = ? AND deleted_at IS NOT NULL",
                    params![timestamp, entity_id],
                )
                .map_err(|e| e.to_string())?;
            if changed == 0 {
                return Err("礼金簿不在回收站中，无法通过历史改动恢复".to_string());
            }
        }
        _ => return Err("该删除操作没有安全的历史恢复机制".to_string()),
    }
    Ok(())
}

fn reverse_restore_audit_entity(
    transaction: &Transaction<'_>,
    entity_type: &str,
    entity_id: &str,
) -> Result<(), String> {
    let timestamp = now();
    let changed = match entity_type {
        "gift_entry" => transaction.execute(
            "UPDATE gift_entries SET deleted_at = ?, updated_at = ? WHERE id = ? AND deleted_at IS NULL",
            params![timestamp, timestamp, entity_id],
        ),
        "person" => {
            transaction.execute(
                "UPDATE gift_entries SET deleted_at = ?, updated_at = ? WHERE person_id = ? AND deleted_at IS NULL",
                params![timestamp, timestamp, entity_id],
            ).map_err(|error| error.to_string())?;
            transaction.execute(
                "UPDATE people SET deleted_at = ?, updated_at = ? WHERE id = ? AND deleted_at IS NULL",
                params![timestamp, timestamp, entity_id],
            )
        }
        "gift_book" => transaction.execute(
            "UPDATE gift_books SET deleted_at = ?, updated_at = ? WHERE id = ? AND deleted_at IS NULL",
            params![timestamp, timestamp, entity_id],
        ),
        _ => return Err("该恢复操作没有安全的反向机制".to_string()),
    }
    .map_err(|error| error.to_string())?;
    if changed == 0 {
        return Err("对应业务数据已不存在，无法撤销恢复操作".to_string());
    }
    Ok(())
}

// A tag-only entry audit targets its saved personId. A combined identity/tag
// edit expects the after identity, but restores tags on the before identity.
fn audit_entry_tag_target(
    connection: &Connection,
    entity_id: &str,
    changes: &[AuditChange],
    person_id: Option<&str>,
) -> Result<Option<String>, String> {
    if !changes.iter().any(|change| {
        change
            .machine
            .as_ref()
            .map_or(change.field == "人物标签", |machine| {
                machine.field_id == "tag_ids"
            })
    }) {
        return Ok(None);
    }
    let identity = changes
        .iter()
        .filter_map(|change| change.machine.as_ref())
        .find(|machine| machine.field_id == "person_id");
    let (target, expected) = if let Some(identity) = identity {
        if identity.version != 1 {
            return Err("不支持该历史人物关联快照版本".to_string());
        }
        let before = identity.before.as_str().ok_or("历史人物关联无效")?;
        let after = identity.after.as_str().ok_or("历史人物关联无效")?;
        if person_id.is_some_and(|saved| saved != after) {
            return Err("历史人物关联快照不一致，未执行恢复".to_string());
        }
        (before, after)
    } else {
        let saved = person_id.ok_or("历史缺少稳定人物关联，无法安全恢复标签")?;
        (saved, saved)
    };
    let current: String = connection
        .query_row(
            "SELECT person_id FROM gift_entries WHERE id=? AND deleted_at IS NULL",
            params![entity_id],
            |row| row.get(0),
        )
        .map_err(|error| error.to_string())?;
    let active: bool = connection
        .query_row(
            "SELECT EXISTS(SELECT 1 FROM people WHERE id=? AND deleted_at IS NULL)",
            params![target],
            |row| row.get(0),
        )
        .map_err(|error| error.to_string())?;
    if current != expected || !active {
        return Err("人物关联已改变或原人物已删除，未执行标签历史恢复；历史记录已保留".to_string());
    }
    Ok(Some(target.to_string()))
}

fn restore_audit_record(
    transaction: &Transaction<'_>,
    entity_type: &str,
    entity_id: &str,
    payload: &AuditPayload,
) -> Result<(), String> {
    if payload.changes.is_empty() {
        return Err("该历史记录没有保存可逆的字段快照，无法恢复".to_string());
    }
    let entry_entity = entity_type == "gift_entry" || entity_type == "return_gift";
    if entry_entity {
        ensure_entry_parents_active(transaction, entity_id)?;
    }
    let tag_target = if entry_entity {
        audit_entry_tag_target(
            transaction,
            entity_id,
            &payload.changes,
            payload.person_id.as_deref(),
        )?
    } else {
        None
    };
    if entry_entity
        && payload.changes.iter().any(|change| {
            change
                .machine
                .as_ref()
                .is_some_and(|value| matches!(value.field_id.as_str(), "person_name" | "address"))
        })
        && !payload.changes.iter().any(|change| {
            change
                .machine
                .as_ref()
                .is_some_and(|value| value.field_id == "person_id")
        })
    {
        return Err("历史缺少原人物关联，无法安全恢复姓名或地址".to_string());
    }
    for change in &payload.changes {
        if let Some(machine) = &change.machine {
            restore_machine_change(
                transaction,
                entity_type,
                entity_id,
                machine,
                tag_target.as_deref(),
            )?;
            continue;
        }
        let field = change.field.as_str();
        if matches!(change.before.as_str(), "未填写" | "未设置") {
            return Err("旧历史中的占位文本无法区分空值与真实文字，未执行恢复".to_string());
        }
        if entry_entity && matches!(field, "姓名" | "地址") {
            return Err("旧历史未保存稳定人物身份，无法安全恢复姓名或地址".to_string());
        }
        if entity_type == "person" && field.contains("标签") {
            restore_person_tag_names(transaction, entity_id, &change.before)?;
        } else if entity_type == "vault" && field.contains("名称") {
            transaction
                .execute(
                    "INSERT OR REPLACE INTO vault_meta(key, value) VALUES ('name', ?)",
                    params![change.before],
                )
                .map_err(|e| e.to_string())?;
        } else if entity_type == "vault" && field.contains("备注") {
            transaction
                .execute(
                    "INSERT OR REPLACE INTO vault_meta(key, value) VALUES ('notes', ?)",
                    params![if change.before == "未填写" {
                        ""
                    } else {
                        &change.before
                    }],
                )
                .map_err(|e| e.to_string())?;
        } else if entry_entity && field.contains("回礼金额") {
            let amount = if change.before == "未填写" {
                None
            } else {
                Some(
                    parse_amount_fen(&change.before)
                        .ok_or_else(|| "历史回礼金额格式无法恢复".to_string())?,
                )
            };
            transaction
                .execute(
                    "UPDATE gift_entries SET return_gift_amount_fen = ?, updated_at = ? WHERE id = ? AND deleted_at IS NULL",
                    params![amount, now(), entity_id],
                )
                .map_err(|e| e.to_string())?;
        } else if entry_entity && field.contains("回礼备注") {
            transaction
                .execute(
                    "UPDATE gift_entries SET return_gift = ?, updated_at = ? WHERE id = ? AND deleted_at IS NULL",
                    params![if change.before == "未填写" { None } else { Some(change.before.clone()) }, now(), entity_id],
                )
                .map_err(|e| e.to_string())?;
        } else if entry_entity && field.contains("金额") {
            let amount = parse_amount_fen(&change.before)
                .ok_or_else(|| "历史礼金金额格式无法恢复".to_string())?;
            transaction
                .execute(
                    "UPDATE gift_entries SET amount_fen = ?, updated_at = ? WHERE id = ? AND deleted_at IS NULL",
                    params![amount, now(), entity_id],
                )
                .map_err(|e| e.to_string())?;
        } else if entry_entity && field.contains("支付方式") {
            transaction
                .execute(
                    "UPDATE gift_entries SET payment_method = ?, updated_at = ? WHERE id = ? AND deleted_at IS NULL",
                    params![change.before, now(), entity_id],
                )
                .map_err(|e| e.to_string())?;
        } else if entry_entity && field.contains("登记日期") {
            transaction
                .execute(
                    "UPDATE gift_entries SET received_at = ?, updated_at = ? WHERE id = ? AND deleted_at IS NULL",
                    params![change.before, now(), entity_id],
                )
                .map_err(|e| e.to_string())?;
        } else if entry_entity && field.contains("备注") {
            transaction
                .execute(
                    "UPDATE gift_entries SET note = ?, updated_at = ? WHERE id = ? AND deleted_at IS NULL",
                    params![if change.before == "未填写" { None } else { Some(change.before.clone()) }, now(), entity_id],
                )
                .map_err(|e| e.to_string())?;
        } else if entry_entity && field.contains("人物标签") {
            let person_id = tag_target
                .as_deref()
                .ok_or("历史缺少稳定人物关联，无法安全恢复标签")?;
            restore_person_tag_names(transaction, person_id, &change.before)?;
        } else if entry_entity && field.contains("姓名") {
            transaction
                .execute(
                    "UPDATE people SET display_name = ?, updated_at = ? WHERE id = (SELECT person_id FROM gift_entries WHERE id = ?)",
                    params![change.before, now(), entity_id],
                )
                .map_err(|e| e.to_string())?;
        } else if entry_entity && field.contains("地址") {
            transaction
                .execute(
                    "UPDATE people SET address = ?, updated_at = ? WHERE id = (SELECT person_id FROM gift_entries WHERE id = ?)",
                    params![if change.before == "未填写" { None } else { Some(change.before.clone()) }, now(), entity_id],
                )
                .map_err(|e| e.to_string())?;
        } else if entity_type == "gift_book" && field == "礼金簿名称" {
            transaction
                .execute(
                    "UPDATE gift_books SET title = ?, updated_at = ? WHERE id = ? AND deleted_at IS NULL",
                    params![change.before, now(), entity_id],
                )
                .map_err(|e| e.to_string())?;
        } else if entity_type == "gift_book" && field == "活动类型" {
            transaction
                .execute(
                    "UPDATE gift_books SET occasion = ?, updated_at = ? WHERE id = ? AND deleted_at IS NULL",
                    params![change.before, now(), entity_id],
                )
                .map_err(|e| e.to_string())?;
        } else if entity_type == "gift_book" && field == "活动日期" {
            transaction
                .execute(
                    "UPDATE gift_books SET event_date = ?, updated_at = ? WHERE id = ? AND deleted_at IS NULL",
                    params![if matches!(change.before.as_str(), "未设置" | "未填写") { None } else { Some(change.before.clone()) }, now(), entity_id],
                )
                .map_err(|e| e.to_string())?;
        } else if entity_type == "gift_book" && field == "地点" {
            transaction
                .execute(
                    "UPDATE gift_books SET location = ?, updated_at = ? WHERE id = ? AND deleted_at IS NULL",
                    params![if matches!(change.before.as_str(), "未设置" | "未填写") { None } else { Some(change.before.clone()) }, now(), entity_id],
                )
                .map_err(|e| e.to_string())?;
        } else if entity_type == "gift_book" && field == "备注" {
            transaction
                .execute(
                    "UPDATE gift_books SET notes = ?, updated_at = ? WHERE id = ? AND deleted_at IS NULL",
                    params![if matches!(change.before.as_str(), "未设置" | "未填写") { None } else { Some(change.before.clone()) }, now(), entity_id],
                )
                .map_err(|e| e.to_string())?;
        } else {
            return Err(format!("历史字段“{}”没有安全的恢复映射", field));
        }
    }
    Ok(())
}

fn restore_machine_change(
    transaction: &Transaction<'_>,
    entity_type: &str,
    entity_id: &str,
    change: &AuditMachineChange,
    tag_target: Option<&str>,
) -> Result<(), String> {
    if change.version != 1 {
        return Err("不支持该历史快照版本".to_string());
    }
    let entry = matches!(entity_type, "gift_entry" | "return_gift");
    if change.field_id == "tag_ids" {
        let person_id = if entity_type == "person" {
            entity_id.to_string()
        } else if entry {
            tag_target
                .ok_or("历史缺少稳定人物关联，无法安全恢复标签")?
                .to_string()
        } else {
            return Err("标签快照实体无效".to_string());
        };
        let ids: Vec<String> =
            serde_json::from_value(change.before.clone()).map_err(|e| e.to_string())?;
        transaction
            .execute(
                "DELETE FROM person_tags WHERE person_id=?",
                params![person_id],
            )
            .map_err(|e| e.to_string())?;
        return apply_entry_tags(transaction, &person_id, &ids);
    }
    if entry && change.field_id == "person_id" {
        let before = change.before.as_str().ok_or("历史人物身份无效")?;
        let after = change.after.as_str().ok_or("历史人物身份无效")?;
        let current: String = transaction
            .query_row(
                "SELECT person_id FROM gift_entries WHERE id=? AND deleted_at IS NULL",
                params![entity_id],
                |row| row.get(0),
            )
            .map_err(|e| e.to_string())?;
        let active: bool = transaction
            .query_row(
                "SELECT EXISTS(SELECT 1 FROM people WHERE id=? AND deleted_at IS NULL)",
                params![before],
                |row| row.get(0),
            )
            .map_err(|e| e.to_string())?;
        if current != after || !active {
            return Err("人物关联已改变或原人物已删除，未执行历史恢复".to_string());
        }
        transaction
            .execute(
                "UPDATE gift_entries SET person_id=?, updated_at=? WHERE id=?",
                params![before, now(), entity_id],
            )
            .map_err(|e| e.to_string())?;
        return Ok(());
    }
    // Name/address display changes are backed by the preceding identity change;
    // relinking the entry must never mutate a person shared by another entry.
    if entry && matches!(change.field_id.as_str(), "person_name" | "address") {
        return Ok(());
    }
    let column = match (entity_type, change.field_id.as_str()) {
        (
            "gift_entry" | "return_gift",
            "amount_fen"
            | "payment_method"
            | "received_at"
            | "note"
            | "return_gift"
            | "return_gift_amount_fen"
            | "return_gifted_at",
        ) => change.field_id.as_str(),
        ("gift_book", "title" | "occasion" | "event_date" | "location" | "notes") => {
            change.field_id.as_str()
        }
        ("vault", "name" | "notes") => change.field_id.as_str(),
        _ => return Err(format!("历史字段 {} 没有安全的恢复映射", change.field_id)),
    };
    if matches!(column, "amount_fen" | "return_gift_amount_fen") {
        if !(column == "return_gift_amount_fen" && change.before.is_null()) {
            validate_amount(change.before.as_i64().ok_or("历史金额不是整数分")?)?;
        }
    } else if !change.before.is_null() && !change.before.is_string() {
        return Err("历史文本字段类型无效".to_string());
    }
    let value = match &change.before {
        serde_json::Value::Null => rusqlite::types::Value::Null,
        serde_json::Value::String(value) => rusqlite::types::Value::Text(value.clone()),
        serde_json::Value::Number(value) => {
            rusqlite::types::Value::Integer(value.as_i64().ok_or("历史金额不是整数分")?)
        }
        _ => return Err("历史字段类型无效".to_string()),
    };
    if entity_type == "vault" {
        transaction
            .execute(
                "INSERT OR REPLACE INTO vault_meta(key,value) VALUES (?,?)",
                params![column, value],
            )
            .map_err(|e| e.to_string())?;
    } else {
        let table = if entry { "gift_entries" } else { "gift_books" };
        let changed = transaction
            .execute(
                &format!(
                    "UPDATE {table} SET {column}=?, updated_at=? WHERE id=? AND deleted_at IS NULL"
                ),
                params![value, now(), entity_id],
            )
            .map_err(|e| e.to_string())?;
        if changed == 0 {
            return Err("历史恢复目标已不存在或在回收站中".to_string());
        }
    }
    Ok(())
}

type AuditRestoreRow = (String, String, String, Option<String>);

fn audit_restore_rows(
    transaction: &Transaction<'_>,
    ids: &[String],
) -> Result<Vec<AuditRestoreRow>, String> {
    let placeholders = (0..ids.len()).map(|_| "?").collect::<Vec<_>>().join(", ");
    let mut statement = transaction
        .prepare(&format!(
            "SELECT action, entity_type, entity_id, payload FROM audit_logs WHERE id IN ({placeholders}) ORDER BY created_at DESC, rowid DESC"
        ))
        .map_err(|e| e.to_string())?;
    let rows = statement
        .query_map(params_from_iter(ids.iter()), |row| {
            Ok((
                row.get::<_, String>(0)?,
                row.get::<_, String>(1)?,
                row.get::<_, String>(2)?,
                row.get::<_, Option<String>>(3)?,
            ))
        })
        .map_err(|e| e.to_string())?
        .collect::<Result<Vec<_>, _>>()
        .map_err(|e| e.to_string())?;
    drop(statement);
    Ok(rows)
}

#[tauri::command(async)]
fn restore_audit_logs(
    ids: Vec<String>,
    vault_path: String,
    state: State<'_, AppState>,
) -> Result<(), String> {
    let _operation = begin_operation()?;
    if ids.is_empty() {
        return Err("请先进入多选并选择要恢复的历史改动".to_string());
    }
    let mut connection = admin_connection(&state, &vault_path, "restore-audit-logs", false)?;
    restore_selected_audit_records(&mut connection, &ids)
}

fn restore_selected_audit_records(
    connection: &mut Connection,
    ids: &[String],
) -> Result<(), String> {
    let transaction = connection.transaction().map_err(|e| e.to_string())?;
    let rows = audit_restore_rows(&transaction, ids)?;
    if rows.len() != ids.len() {
        return Err("部分历史记录已不存在，未执行恢复".to_string());
    }
    for (action, entity_type, entity_id, raw_payload) in rows {
        if action == "delete" {
            restore_deleted_audit_entity(&transaction, &entity_type, &entity_id)?;
        } else if action == "restore" {
            reverse_restore_audit_entity(&transaction, &entity_type, &entity_id)?;
        } else if action == "update"
            && (entity_type == "gift_entry"
                || entity_type == "return_gift"
                || entity_type == "person"
                || entity_type == "vault"
                || entity_type == "gift_book")
        {
            let payload = raw_payload
                .as_deref()
                .ok_or_else(|| "历史记录没有保存可逆快照，无法恢复".to_string())
                .and_then(|value| {
                    serde_json::from_str::<AuditPayload>(value).map_err(|e| e.to_string())
                })?;
            restore_audit_record(&transaction, &entity_type, &entity_id, &payload)?;
        } else {
            return Err("该历史记录类型没有安全的恢复机制".to_string());
        }
    }
    let placeholders = (0..ids.len()).map(|_| "?").collect::<Vec<_>>().join(", ");
    transaction
        .execute(
            &format!("DELETE FROM audit_logs WHERE id IN ({placeholders})"),
            params_from_iter(ids.iter()),
        )
        .map_err(|error| error.to_string())?;
    transaction.commit().map_err(|e| e.to_string())
}

#[tauri::command(async)]
fn clear_audit_logs(
    ids: Option<Vec<String>>,
    pin: String,
    vault_path: String,
    state: State<'_, AppState>,
) -> Result<(), String> {
    let _operation = begin_operation()?;
    authorize_empty_trash(&state, &pin)?;
    let connection = admin_connection(&state, &vault_path, "clear-audit-logs", false)?;
    delete_audit_logs(&connection, &ids.unwrap_or_default())?;
    Ok(())
}

#[tauri::command(async)]
fn restore_trash_item(
    kind: String,
    id: String,
    vault_path: Option<String>,
    state: State<'_, AppState>,
) -> Result<(), String> {
    with_operation(|| match kind.as_str() {
        "book" | "entry" | "tag" | "person" | "outbound_gift" => {
            let requested_path = vault_path
                .as_deref()
                .filter(|path| !path.trim().is_empty())
                .ok_or("请选择回收站记录所属的礼金库")?;
            let mut connection = admin_connection_for_path(
                &state,
                Some(requested_path),
                "restore-trash-item",
                false,
            )?;
            match kind.as_str() {
                "book" => restore_book_record(&mut connection, &id),
                "entry" => restore_entry_record(&mut connection, &id),
                "tag" => restore_tag_record(&mut connection, &id),
                "person" => restore_person_record(&mut connection, &id),
                "outbound_gift" => {
                    connection.execute("UPDATE outbound_gifts SET deleted_at = NULL, updated_at = ? WHERE id = ? AND deleted_at IS NOT NULL", params![now(), id]).map_err(|e| e.to_string())?;
                    Ok(())
                }
                _ => unreachable!(),
            }
        }
        "vault" => restore_vault_file(&id, &state),
        _ => Err("不支持的回收站项目类型".to_string()),
    })
}

fn empty_trash_records(connection: &mut Connection) -> Result<(), String> {
    let transaction = connection.transaction().map_err(|e| e.to_string())?;
    transaction
        .execute(
            "DELETE FROM gift_entries WHERE deleted_at IS NOT NULL OR book_id IN (SELECT id FROM gift_books WHERE deleted_at IS NOT NULL)",
            [],
        )
        .map_err(|e| e.to_string())?;
    transaction
        .execute("DELETE FROM people WHERE deleted_at IS NOT NULL", [])
        .map_err(|e| e.to_string())?;
    transaction
        .execute("DELETE FROM gift_books WHERE deleted_at IS NOT NULL", [])
        .map_err(|e| e.to_string())?;
    transaction
        .execute("DELETE FROM tags WHERE deleted_at IS NOT NULL", [])
        .map_err(|e| e.to_string())?;
    if table_exists(&transaction, "outbound_gifts")? {
        transaction
            .execute(
                "DELETE FROM outbound_gifts WHERE deleted_at IS NOT NULL",
                [],
            )
            .map_err(|e| e.to_string())?;
    }
    write_audit_detail(
        &transaction,
        "purge",
        "trash",
        "all",
        AuditPayload {
            person_id: None,
            target: "回收站".to_string(),
            book_title: None,
            description: "永久清空回收站".to_string(),
            changes: Vec::new(),
        },
    )?;
    transaction.commit().map_err(|e| e.to_string())
}

#[tauri::command(async)]
fn empty_trash(pin: String, state: State<'_, AppState>) -> Result<(), String> {
    with_operation(|| {
        authorize_empty_trash(&state, &pin)?;
        let mut completed = Vec::new();
        for path in opened_vault_paths(&state)? {
            let name = displayable_path(&path);
            let result = (|| {
                let canonical = path
                    .canonicalize()
                    .map_err(|_| "礼金库文件已不可访问".to_string())?;
                let mut connection = admin_connection_for_path(
                    &state,
                    Some(&displayable_path(&canonical)),
                    "empty-trash",
                    true,
                )?;
                empty_trash_records(&mut connection)
            })();
            if let Err(error) = result {
                return Err(format!(
                    "已清空范围：{}；失败库：{name}：{error}；其余范围未清空",
                    if completed.is_empty() {
                        "无".to_string()
                    } else {
                        completed.join("、")
                    }
                ));
            }
            completed.push(name);
        }
        empty_vault_trash().map_err(|error| {
            format!(
                "已清空打开库：{}；删除库文件清理失败：{error}",
                completed.join("、")
            )
        })
    })
}

#[tauri::command]
fn list_tags(vault_path: String, state: State<'_, AppState>) -> Result<Vec<Tag>, String> {
    let connection = scoped_read_connection(&state, &vault_path)?;
    let mut statement = connection
        .prepare(
            "SELECT t.id, t.name, t.color
             FROM tags t
             LEFT JOIN person_tags pt ON pt.tag_id = t.id
             LEFT JOIN people p ON p.id = pt.person_id AND p.deleted_at IS NULL
             LEFT JOIN gift_entries e ON e.person_id = p.id AND e.deleted_at IS NULL
             WHERE t.deleted_at IS NULL
             GROUP BY t.id, t.name, t.color, t.created_at
             ORDER BY COUNT(DISTINCT p.id) DESC,
                      COALESCE(MAX(e.received_at), t.created_at) DESC,
                      t.name COLLATE NOCASE",
        )
        .map_err(|e| e.to_string())?;
    let rows = statement
        .query_map([], |row| {
            Ok(Tag {
                id: row.get(0)?,
                name: row.get(1)?,
                color: row.get(2)?,
            })
        })
        .map_err(|e| e.to_string())?;
    rows.collect::<Result<Vec<_>, _>>()
        .map_err(|e| e.to_string())
}

fn normalize_tag_color(color: &str) -> Result<String, String> {
    let color = color.trim();
    let valid = color.len() == 7
        && color.starts_with('#')
        && color.as_bytes()[1..]
            .iter()
            .all(|byte| byte.is_ascii_hexdigit());
    if !valid {
        return Err("标签颜色必须是 #RRGGBB 格式".to_string());
    }
    Ok(color.to_ascii_lowercase())
}

#[tauri::command(async)]
fn create_tag(
    name: String,
    color: String,
    vault_path: String,
    state: State<'_, AppState>,
) -> Result<Tag, String> {
    let _operation = begin_operation()?;
    validate_text("标签名称", &name, 256)?;
    let name = name.trim().to_string();
    if name.is_empty() {
        return Err("标签名称不能为空".to_string());
    }
    let color = if color.trim().is_empty() {
        "#3b82f6".to_string()
    } else {
        normalize_tag_color(&color)?
    };
    let mut connection = admin_connection(&state, &vault_path, "create-tag", false)?;
    let normalized = normalize_tag_name(&name);
    let existing = {
        let mut existing_statement = connection
            .prepare("SELECT name, deleted_at FROM tags")
            .map_err(|e| e.to_string())?;
        let result = existing_statement
            .query_map([], |row| {
                Ok((row.get::<_, String>(0)?, row.get::<_, Option<String>>(1)?))
            })
            .map_err(|e| e.to_string())?
            .find_map(|row| match row {
                Ok((existing_name, deleted_at))
                    if normalize_tag_name(&existing_name) == normalized =>
                {
                    Some(Ok((existing_name, deleted_at)))
                }
                Ok(_) => None,
                Err(error) => Some(Err(error)),
            })
            .transpose()
            .map_err(|e: rusqlite::Error| e.to_string())?;
        result
    };
    if let Some((existing_name, deleted_at)) = existing {
        return Err(if deleted_at.is_some() {
            format!("标签「{existing_name}」在回收站中，请先恢复或清空回收站")
        } else {
            format!("标签「{existing_name}」已经存在")
        });
    }
    let id = Uuid::new_v4().to_string();
    let transaction = connection.transaction().map_err(|e| e.to_string())?;
    transaction
        .execute(
            "INSERT INTO tags(id, name, color, created_at, deleted_at) VALUES (?, ?, ?, ?, NULL)",
            params![id, name, color, now()],
        )
        .map_err(|e| format!("标签可能已存在: {e}"))?;
    write_audit_detail(
        &transaction,
        "create",
        "tag",
        &id,
        AuditPayload {
            person_id: None,
            target: name.clone(),
            book_title: None,
            description: "新建人物标签".to_string(),
            changes: vec![audit_change("颜色", "未设置", &color)],
        },
    )?;
    transaction.commit().map_err(|e| e.to_string())?;
    Ok(Tag { id, name, color })
}

#[tauri::command(async)]
fn delete_tag(
    tag_id: String,
    vault_path: String,
    state: State<'_, AppState>,
) -> Result<(), String> {
    let _operation = begin_operation()?;
    let mut connection = admin_connection(&state, &vault_path, "delete-tag", true)?;
    delete_tag_record(&mut connection, &tag_id)
}

fn delete_tag_record(connection: &mut Connection, tag_id: &str) -> Result<(), String> {
    let transaction = connection.transaction().map_err(|e| e.to_string())?;
    let tag_name: String = transaction
        .query_row(
            "SELECT name FROM tags WHERE id = ?",
            params![tag_id],
            |row| row.get(0),
        )
        .map_err(|e| e.to_string())?;
    let timestamp = now();
    let changed = transaction
        .execute(
            "UPDATE tags SET deleted_at = ? WHERE id = ? AND deleted_at IS NULL",
            params![timestamp, tag_id],
        )
        .map_err(|e| e.to_string())?;
    if changed == 0 {
        return Err("标签不存在或已在回收站中".to_string());
    }
    write_audit_detail(
        &transaction,
        "delete",
        "tag",
        tag_id,
        AuditPayload {
            person_id: None,
            target: tag_name,
            book_title: None,
            description: "删除人物标签并解除人物绑定".to_string(),
            changes: Vec::new(),
        },
    )?;
    transaction.commit().map_err(|e| e.to_string())
}

fn restore_tag_record(connection: &mut Connection, tag_id: &str) -> Result<(), String> {
    let transaction = connection.transaction().map_err(|e| e.to_string())?;
    let tag_name: String = transaction
        .query_row(
            "SELECT name FROM tags WHERE id = ?",
            params![tag_id],
            |row| row.get(0),
        )
        .map_err(|e| e.to_string())?;
    let changed = transaction
        .execute(
            "UPDATE tags SET deleted_at = NULL WHERE id = ? AND deleted_at IS NOT NULL",
            params![tag_id],
        )
        .map_err(|e| e.to_string())?;
    if changed == 0 {
        return Err("标签不存在或不在回收站中".to_string());
    }
    write_audit_detail(
        &transaction,
        "restore",
        "tag",
        tag_id,
        AuditPayload {
            person_id: None,
            target: tag_name,
            book_title: None,
            description: "恢复人物标签".to_string(),
            changes: Vec::new(),
        },
    )?;
    transaction.commit().map_err(|e| e.to_string())
}

#[tauri::command(async)]
fn update_tag_color(
    tag_id: String,
    color: String,
    vault_path: String,
    state: State<'_, AppState>,
) -> Result<(), String> {
    let _operation = begin_operation()?;
    let color = normalize_tag_color(&color)?;
    let mut connection = admin_connection(&state, &vault_path, "update-tag-color", false)?;
    let transaction = connection.transaction().map_err(|e| e.to_string())?;
    let (tag_name, old_color): (String, String) = transaction
        .query_row(
            "SELECT name, color FROM tags WHERE id = ? AND deleted_at IS NULL",
            params![tag_id],
            |row| Ok((row.get(0)?, row.get(1)?)),
        )
        .map_err(|e| e.to_string())?;
    let changed = transaction
        .execute(
            "UPDATE tags SET color = ? WHERE id = ? AND deleted_at IS NULL",
            params![color, tag_id],
        )
        .map_err(|error| error.to_string())?;
    if changed == 0 {
        return Err("标签不存在".to_string());
    }
    write_audit_detail(
        &transaction,
        "update",
        "tag",
        &tag_id,
        AuditPayload {
            person_id: None,
            target: tag_name,
            book_title: None,
            description: "修改人物标签颜色".to_string(),
            changes: vec![audit_change("颜色", old_color, &color)],
        },
    )?;
    transaction.commit().map_err(|e| e.to_string())
}

#[tauri::command]
fn list_people(
    search: String,
    tag_search: String,
    book_id: Option<String>,
    vault_path: String,
    state: State<'_, AppState>,
) -> Result<Vec<Person>, String> {
    let connection = scoped_read_connection(&state, &vault_path)?;
    ensure_money_totals_safe(&connection)?;
    let pattern = format!("%{}%", search.trim());
    let tag_pattern = format!("%{}%", tag_search.trim());
    let tags_by_person = person_tag_map(&connection)?;
    let scoped_book_id = book_id.filter(|value| !value.trim().is_empty());
    let mut sql = "SELECT p.id, p.display_name, p.address, p.notes, COALESCE(SUM(e.amount_fen), 0), COUNT(e.id) FROM people p LEFT JOIN gift_entries e ON e.person_id = p.id AND e.deleted_at IS NULL".to_string();
    let mut values = Vec::new();
    if let Some(book_id) = scoped_book_id.as_ref() {
        sql.push_str(" AND e.book_id = ?");
        values.push(book_id.clone());
    }
    sql.push_str(
        " WHERE p.deleted_at IS NULL AND (p.display_name LIKE ? OR COALESCE(p.address, '') LIKE ?)",
    );
    values.push(pattern.clone());
    values.push(pattern);
    if let Some(book_id) = scoped_book_id {
        sql.push_str(" AND EXISTS (SELECT 1 FROM gift_entries book_scope WHERE book_scope.person_id = p.id AND book_scope.book_id = ? AND book_scope.deleted_at IS NULL)");
        values.push(book_id);
    }
    if !tag_search.trim().is_empty() {
        sql.push_str(" AND EXISTS (SELECT 1 FROM person_tags filter_pt JOIN tags filter_tag ON filter_tag.id = filter_pt.tag_id WHERE filter_pt.person_id = p.id AND filter_tag.deleted_at IS NULL AND filter_tag.name LIKE ?)");
        values.push(tag_pattern);
    }
    sql.push_str(" GROUP BY p.id ORDER BY p.display_name");
    let mut statement = connection.prepare(&sql).map_err(|e| e.to_string())?;
    let rows = statement
        .query_map(params_from_iter(values.iter()), |row| {
            Ok(Person {
                id: row.get(0)?,
                display_name: row.get(1)?,
                address: row.get(2)?,
                notes: row.get(3)?,
                tags: Vec::new(),
                total_fen: read_money_fen(row, 4)?,
                gift_count: row.get(5)?,
            })
        })
        .map_err(|e| e.to_string())?;
    let mut people = rows
        .collect::<Result<Vec<_>, _>>()
        .map_err(|e| e.to_string())?;
    for person in &mut people {
        person.tags = tags_by_person.get(&person.id).cloned().unwrap_or_default();
    }
    checked_money_total(people.iter().map(|person| person.total_fen))?;
    Ok(people)
}

#[tauri::command(async)]
fn set_person_tags(
    person_id: String,
    tag_ids: Vec<String>,
    vault_path: String,
    state: State<'_, AppState>,
) -> Result<(), String> {
    let _operation = begin_operation()?;
    let audit_vault_path =
        displayable_path(&canonical_opened_vault_path(&state, Some(&vault_path))?);
    let mut connection = admin_connection(&state, &vault_path, "set-person-tags", false)?;
    let transaction = connection.transaction().map_err(|e| e.to_string())?;
    let person_name: String = transaction
        .query_row(
            "SELECT display_name FROM people WHERE id = ? AND deleted_at IS NULL",
            params![person_id],
            |row| row.get(0),
        )
        .map_err(|e| e.to_string())?;
    let before_ids = active_person_tag_ids(&transaction, &person_id)?;
    let before_tags: String = transaction
    .query_row(
        "SELECT COALESCE((SELECT GROUP_CONCAT(t.name, '、') FROM person_tags pt JOIN tags t ON t.id = pt.tag_id WHERE pt.person_id = p.id AND t.deleted_at IS NULL), '') FROM people p WHERE p.id = ?",
        params![person_id],
        |row| row.get(0),
    )
    .map_err(|e| e.to_string())?;
    transaction
        .execute(
            "DELETE FROM person_tags WHERE person_id = ?",
            params![person_id],
        )
        .map_err(|e| e.to_string())?;
    apply_entry_tags(&transaction, &person_id, &tag_ids)?;
    let after_ids = active_person_tag_ids(&transaction, &person_id)?;
    let after_tags: String = transaction
    .query_row(
        "SELECT COALESCE((SELECT GROUP_CONCAT(t.name, '、') FROM person_tags pt JOIN tags t ON t.id = pt.tag_id WHERE pt.person_id = p.id AND t.deleted_at IS NULL), '') FROM people p WHERE p.id = ?",
        params![person_id],
        |row| row.get(0),
    )
    .map_err(|e| e.to_string())?;
    if before_ids != after_ids {
        let book_sources = audit_person_book_sources(&transaction, &person_id)?;
        let book_titles = book_sources
            .iter()
            .map(|(_, title)| title.clone())
            .collect::<Vec<_>>();
        let book_ids = book_sources
            .iter()
            .map(|(id, _)| id.clone())
            .collect::<Vec<_>>();
        let book_title = if book_titles.is_empty() {
            "未关联礼金簿".to_string()
        } else {
            book_titles.join("、")
        };
        write_audit_detail_with_context(
            &transaction,
            "update",
            "person",
            &person_id,
            AuditPayload {
                person_id: None,
                target: person_name,
                book_title: Some(book_title),
                description: "修改人物标签".to_string(),
                changes: vec![{
                    let mut change = machine_change("人物标签", "tag_ids", &before_ids, &after_ids);
                    change.before = if before_tags.is_empty() {
                        "未设置".to_string()
                    } else {
                        before_tags
                    };
                    change.after = if after_tags.is_empty() {
                        "未设置".to_string()
                    } else {
                        after_tags
                    };
                    change
                }],
            },
            Some(AuditContext {
                person_id: person_id.clone(),
                vault_id: audit_vault_id(&transaction)?,
                vault_path: audit_vault_path,
                book_id: book_ids.first().cloned(),
                book_ids,
                book_titles,
            }),
        )?;
        merge_contiguous_person_tag_audit(&transaction, &person_id)?;
    }
    transaction.commit().map_err(|e| e.to_string())
}

#[tauri::command]
fn list_book_stats(
    vault_path: String,
    state: State<'_, AppState>,
) -> Result<Vec<BookStat>, String> {
    let connection = scoped_read_connection(&state, &vault_path)?;
    ensure_money_totals_safe(&connection)?;
    let mut statement = connection.prepare("SELECT b.id, b.title, b.event_date, COUNT(DISTINCT e.person_id), COUNT(e.id), COALESCE(SUM(e.amount_fen), 0) FROM gift_books b LEFT JOIN gift_entries e ON e.book_id = b.id AND e.deleted_at IS NULL WHERE b.deleted_at IS NULL GROUP BY b.id ORDER BY COALESCE(b.event_date, b.created_at) DESC").map_err(|e| e.to_string())?;
    let rows = statement
        .query_map([], |row| {
            let gift_count: i64 = row.get(4)?;
            let total_fen: i64 = read_money_fen(row, 5)?;
            Ok(BookStat {
                book_id: row.get(0)?,
                title: row.get(1)?,
                event_date: row.get(2)?,
                people_count: row.get(3)?,
                gift_count,
                total_fen,
            })
        })
        .map_err(|e| e.to_string())?;
    let records = rows
        .collect::<Result<Vec<BookStat>, _>>()
        .map_err(|e| e.to_string())?;
    checked_money_total(records.iter().map(|record| record.total_fen))?;
    Ok(records)
}

#[tauri::command]
fn book_summary(
    book_id: String,
    vault_path: String,
    state: State<'_, AppState>,
) -> Result<BookSummary, String> {
    let connection = scoped_read_connection(&state, &vault_path)?;
    ensure_money_totals_safe(&connection)?;
    let result_book_id = book_id.clone();
    connection
        .query_row(
            "SELECT COUNT(e.id), COALESCE(MAX(e.amount_fen), 0), COALESCE(SUM(e.amount_fen), 0)
             FROM gift_books b
             LEFT JOIN gift_entries e ON e.book_id = b.id AND e.deleted_at IS NULL
             WHERE b.id = ? AND b.deleted_at IS NULL",
            params![book_id],
            |row| {
                Ok(BookSummary {
                    book_id: result_book_id.clone(),
                    gift_count: row.get(0)?,
                    highest_amount_fen: read_money_fen(row, 1)?,
                    total_fen: read_money_fen(row, 2)?,
                })
            },
        )
        .map_err(|e| e.to_string())
}

#[tauri::command]
fn person_history(
    person_id: String,
    vault_path: String,
    state: State<'_, AppState>,
) -> Result<Vec<PersonHistory>, String> {
    let connection = scoped_read_connection(&state, &vault_path)?;
    ensure_money_totals_safe(&connection)?;
    let mut statement = connection.prepare("SELECT b.id, b.title, b.event_date, COUNT(e.id), COALESCE(SUM(e.amount_fen), 0), MAX(e.received_at) FROM gift_books b JOIN gift_entries e ON e.book_id = b.id WHERE b.deleted_at IS NULL AND e.person_id = ? AND e.deleted_at IS NULL GROUP BY b.id ORDER BY COALESCE(b.event_date, MAX(e.received_at)) DESC").map_err(|e| e.to_string())?;
    let rows = statement
        .query_map(params![person_id], |row| {
            Ok(PersonHistory {
                book_id: row.get(0)?,
                book_title: row.get(1)?,
                event_date: row.get(2)?,
                gift_count: row.get(3)?,
                total_fen: read_money_fen(row, 4)?,
                latest_received_at: row.get(5)?,
            })
        })
        .map_err(|e| e.to_string())?;
    let records = rows
        .collect::<Result<Vec<PersonHistory>, _>>()
        .map_err(|e| e.to_string())?;
    checked_money_total(records.iter().map(|record| record.total_fen))?;
    Ok(records)
}

fn open_comparison_connection(path: &Path) -> Result<Connection, String> {
    if path.extension().and_then(|value| value.to_str()) != Some("giftvault") || !path.is_file() {
        return Err("请选择有效的礼金库文件".to_string());
    }
    let connection = Connection::open_with_flags(path, OpenFlags::SQLITE_OPEN_READ_ONLY)
        .map_err(|error| format!("无法以只读方式打开礼金库: {error}"))?;
    let format: Option<String> = connection
        .query_row(
            "SELECT value FROM vault_meta WHERE key = 'format'",
            [],
            |row| row.get(0),
        )
        .optional()
        .map_err(|error| format!("礼金库格式无效: {error}"))?;
    if format.as_deref() != Some("giftvault") {
        return Err("所选文件不是可比较的礼金库".to_string());
    }
    Ok(connection)
}

fn comparison_vault_name(connection: &Connection, path: &Path) -> Result<String, String> {
    let name: Option<String> = connection
        .query_row(
            "SELECT value FROM vault_meta WHERE key = 'name'",
            [],
            |row| row.get(0),
        )
        .optional()
        .map_err(|error| error.to_string())?;
    Ok(name
        .filter(|value| !value.trim().is_empty())
        .unwrap_or_else(|| {
            path.file_stem()
                .and_then(|value| value.to_str())
                .unwrap_or("礼金库")
                .to_string()
        }))
}

fn comparison_books_from_connection(
    connection: &Connection,
    vault_path: &str,
    vault_name: &str,
) -> Result<Vec<ComparisonBook>, String> {
    ensure_money_totals_safe(connection)?;
    let mut statement = connection
        .prepare(
            "SELECT b.id, b.title, b.event_date, COUNT(DISTINCT e.person_id), COUNT(e.id), COALESCE(SUM(e.amount_fen), 0)
             FROM gift_books b
             LEFT JOIN gift_entries e ON e.book_id = b.id AND e.deleted_at IS NULL
             WHERE b.deleted_at IS NULL
             GROUP BY b.id
             ORDER BY COALESCE(b.event_date, b.created_at) DESC",
        )
        .map_err(|error| error.to_string())?;
    let rows = statement
        .query_map([], |row| {
            Ok(ComparisonBook {
                vault_path: vault_path.to_string(),
                vault_name: vault_name.to_string(),
                book_id: row.get(0)?,
                title: row.get(1)?,
                event_date: row.get(2)?,
                people_count: row.get(3)?,
                gift_count: row.get(4)?,
                total_fen: read_money_fen(row, 5)?,
            })
        })
        .map_err(|error| error.to_string())?;
    let records = rows
        .collect::<Result<Vec<ComparisonBook>, _>>()
        .map_err(|e| e.to_string())?;
    checked_money_total(records.iter().map(|record| record.total_fen))?;
    Ok(records)
}

fn comparison_book_entries_from_connection(
    connection: &Connection,
    vault_path: &str,
    vault_name: &str,
    book_id: &str,
) -> Result<Vec<ComparisonBookEntry>, String> {
    let book_title = connection
        .query_row(
            "SELECT title FROM gift_books WHERE id = ? AND deleted_at IS NULL",
            params![book_id],
            |row| row.get::<_, String>(0),
        )
        .optional()
        .map_err(|error| error.to_string())?
        .ok_or_else(|| "比较的礼金簿已不存在".to_string())?;
    let entries = load_entries(connection, Some(book_id))?;
    let tags_by_person = person_tag_map(connection)?;
    Ok(entries
        .into_iter()
        .map(|entry| ComparisonBookEntry {
            vault_path: vault_path.to_string(),
            vault_name: vault_name.to_string(),
            book_id: entry.book_id,
            book_title: book_title.clone(),
            entry_id: entry.id,
            person_id: entry.person_id.clone(),
            person_name: entry.person_name,
            address: entry.address,
            amount_fen: entry.amount_fen,
            payment_method: entry.payment_method,
            received_at: entry.received_at,
            note: entry.note,
            return_gift: entry.return_gift,
            return_gift_amount_fen: entry.return_gift_amount_fen,
            tags: tags_by_person
                .get(&entry.person_id)
                .cloned()
                .unwrap_or_default(),
        })
        .collect())
}

fn comparison_people_from_connection(
    connection: &Connection,
    vault_path: &str,
    vault_name: &str,
    book_id: Option<&str>,
    query: &str,
) -> Result<Vec<ComparisonPerson>, String> {
    let query = query.trim();
    if query.is_empty() {
        return Ok(Vec::new());
    }
    let pattern = if query == "*" {
        "%".to_string()
    } else {
        format!("%{query}%")
    };
    let tags_by_person = person_tag_map(connection)?;
    let source_books_by_person =
        comparison_person_source_map(connection, vault_path, vault_name, book_id)?;
    let mut statement = connection
        .prepare(
            "SELECT DISTINCT p.id, p.display_name, p.address,
                    CASE
                      WHEN NULLIF(TRIM(COALESCE(p.notes, '')), '') IS NOT NULL
                        AND EXISTS (
                          SELECT 1 FROM gift_entries en
                          WHERE en.person_id = p.id AND en.deleted_at IS NULL
                            AND (? IS NULL OR en.book_id = ?)
                            AND NULLIF(TRIM(COALESCE(en.note, '')), '') IS NOT NULL
                        )
                      THEN p.notes || '、' || (
                        SELECT GROUP_CONCAT(DISTINCT TRIM(en.note))
                        FROM gift_entries en
                        WHERE en.person_id = p.id AND en.deleted_at IS NULL
                          AND (? IS NULL OR en.book_id = ?)
                          AND NULLIF(TRIM(COALESCE(en.note, '')), '') IS NOT NULL
                      )
                      ELSE COALESCE(NULLIF(TRIM(p.notes), ''), (
                        SELECT GROUP_CONCAT(DISTINCT TRIM(en.note))
                        FROM gift_entries en
                        WHERE en.person_id = p.id AND en.deleted_at IS NULL
                          AND (? IS NULL OR en.book_id = ?)
                          AND NULLIF(TRIM(COALESCE(en.note, '')), '') IS NOT NULL
                      ))
                    END
             FROM people p
             JOIN gift_entries e ON e.person_id = p.id AND e.deleted_at IS NULL
             JOIN gift_books b ON b.id = e.book_id AND b.deleted_at IS NULL
             WHERE p.deleted_at IS NULL
               AND (? IS NULL OR e.book_id = ?)
               AND (p.display_name LIKE ? OR COALESCE(p.address, '') LIKE ? OR COALESCE(p.notes, '') LIKE ? OR COALESCE(e.note, '') LIKE ?)
             ORDER BY p.display_name, COALESCE(p.address, ''), p.id
             ",
        )
        .map_err(|error| error.to_string())?;
    let rows = statement
        .query_map(
            params![
                book_id, book_id, book_id, book_id, book_id, book_id, book_id, book_id, pattern,
                pattern, pattern, pattern
            ],
            |row| {
                let person_id: String = row.get(0)?;
                Ok(ComparisonPerson {
                    vault_path: vault_path.to_string(),
                    vault_name: vault_name.to_string(),
                    book_id: book_id.unwrap_or_default().to_string(),
                    person_id: person_id.clone(),
                    display_name: row.get(1)?,
                    address: row.get(2)?,
                    notes: row.get(3)?,
                    tags: tags_by_person.get(&person_id).cloned().unwrap_or_default(),
                    source_books: source_books_by_person
                        .get(&person_id)
                        .cloned()
                        .unwrap_or_default(),
                })
            },
        )
        .map_err(|error| error.to_string())?;
    rows.collect::<Result<Vec<_>, _>>()
        .map_err(|error| error.to_string())
}

fn comparison_person_source_map(
    connection: &Connection,
    vault_path: &str,
    vault_name: &str,
    book_id: Option<&str>,
) -> Result<HashMap<String, Vec<ComparisonPersonSource>>, String> {
    ensure_money_totals_safe(connection)?;
    let mut statement = connection
        .prepare(
            "SELECT e.person_id, b.id, b.title, b.event_date, COUNT(e.id), COALESCE(SUM(e.amount_fen), 0)
             FROM gift_entries e
             JOIN gift_books b ON b.id = e.book_id
             WHERE e.deleted_at IS NULL AND b.deleted_at IS NULL
               AND (? IS NULL OR b.id = ?)
             GROUP BY e.person_id, b.id, b.title, b.event_date
             ORDER BY b.title, b.id",
        )
        .map_err(|error| error.to_string())?;
    let rows = statement
        .query_map(params![book_id, book_id], |row| {
            Ok((
                row.get::<_, String>(0)?,
                ComparisonPersonSource {
                    vault_path: vault_path.to_string(),
                    vault_name: vault_name.to_string(),
                    book_id: row.get(1)?,
                    book_title: row.get(2)?,
                    event_date: row.get(3)?,
                    gift_count: row.get(4)?,
                    total_fen: read_money_fen(row, 5)?,
                },
            ))
        })
        .map_err(|error| error.to_string())?;
    let mut sources = HashMap::<String, Vec<ComparisonPersonSource>>::new();
    for row in rows {
        let (person_id, source) = row.map_err(|error| error.to_string())?;
        sources.entry(person_id).or_default().push(source);
    }
    Ok(sources)
}

fn comparison_person_history_from_connection(
    connection: &Connection,
    vault_path: &str,
    vault_name: &str,
    person_id: &str,
    book_id: Option<&str>,
) -> Result<Vec<ComparisonPersonHistory>, String> {
    ensure_money_totals_safe(connection)?;
    let maybe_person: Option<(String, Option<String>, Option<String>)> = connection
        .query_row(
            "SELECT display_name, address, notes FROM people WHERE id = ? AND deleted_at IS NULL",
            params![person_id],
            |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?)),
        )
        .optional()
        .map_err(|error| error.to_string())?;
    let Some((person_name, person_address, person_notes)) = maybe_person else {
        return Ok(Vec::new());
    };
    let tags = person_tag_map(connection)?
        .get(person_id)
        .cloned()
        .unwrap_or_default();
    let mut statement = connection
        .prepare(
            "SELECT e.id, b.id, b.title, b.event_date, e.amount_fen, e.payment_method, e.note, e.return_gift, e.return_gift_amount_fen, e.received_at
             FROM gift_books b
             JOIN gift_entries e ON e.book_id = b.id
             WHERE b.deleted_at IS NULL AND e.person_id = ? AND e.deleted_at IS NULL
               AND (? IS NULL OR b.id = ?)
             ORDER BY COALESCE(b.event_date, e.received_at) DESC, e.received_at DESC, e.created_at DESC",
        )
        .map_err(|error| error.to_string())?;
    let rows = statement
        .query_map(params![person_id, book_id, book_id], |row| {
            Ok(ComparisonPersonHistory {
                vault_path: vault_path.to_string(),
                vault_name: vault_name.to_string(),
                person_id: person_id.to_string(),
                person_name: person_name.clone(),
                person_address: person_address.clone(),
                person_notes: person_notes.clone(),
                tags: tags.clone(),
                entry_id: row.get(0)?,
                book_id: row.get(1)?,
                book_title: row.get(2)?,
                event_date: row.get(3)?,
                gift_count: 1,
                total_fen: read_money_fen(row, 4)?,
                payment_method: row.get(5)?,
                note: row.get(6)?,
                return_gift: row.get(7)?,
                return_gift_amount_fen: read_optional_money_fen(row, 8)?,
                latest_received_at: row.get(9)?,
            })
        })
        .map_err(|error| error.to_string())?;
    let records = rows
        .collect::<Result<Vec<ComparisonPersonHistory>, _>>()
        .map_err(|e| e.to_string())?;
    checked_money_total(records.iter().map(|record| record.total_fen))?;
    Ok(records)
}

fn comparison_vault_paths(
    vault_paths: Vec<String>,
    state: &State<'_, AppState>,
) -> Result<Vec<PathBuf>, String> {
    if state
        .vault_path
        .lock()
        .map_err(|_| "礼金库状态不可用".to_string())?
        .clone()
        .is_none()
    {
        return Err("请先打开礼金库".to_string());
    }
    let requested = vault_paths.into_iter().map(PathBuf::from);
    let mut unique = HashSet::new();
    let mut paths = Vec::new();
    for path in requested {
        let canonical = std::fs::canonicalize(&path)
            .map_err(|_| format!("找不到用于比较的礼金库: {}", path.to_string_lossy()))?;
        if unique.insert(canonical.clone()) {
            paths.push(canonical);
        }
    }
    Ok(paths)
}

fn comparison_book_refs(
    book_refs: Vec<ComparisonBookRef>,
    state: &State<'_, AppState>,
) -> Result<Vec<(PathBuf, String)>, String> {
    if state
        .vault_path
        .lock()
        .map_err(|_| "礼金库状态不可用".to_string())?
        .is_none()
    {
        return Err("请先打开礼金库".to_string());
    }
    let mut unique = HashSet::new();
    let mut resolved = Vec::new();
    for reference in book_refs {
        let path = std::fs::canonicalize(&reference.vault_path)
            .map_err(|_| format!("找不到用于比较的礼金库: {}", reference.vault_path))?;
        let key = format!("{}\u{1f}{}", path.to_string_lossy(), reference.book_id);
        if !unique.insert(key) {
            continue;
        }
        let connection = open_comparison_connection(&path)?;
        let exists: bool = connection
            .query_row(
                "SELECT EXISTS(SELECT 1 FROM gift_books WHERE id = ? AND deleted_at IS NULL)",
                params![reference.book_id],
                |row| row.get(0),
            )
            .map_err(|error| error.to_string())?;
        if !exists {
            return Err("已选礼金簿不存在或已删除".to_string());
        }
        resolved.push((path, reference.book_id));
    }
    Ok(resolved)
}

#[tauri::command]
fn list_comparison_books(
    vault_paths: Vec<String>,
    state: State<'_, AppState>,
) -> Result<Vec<ComparisonBook>, String> {
    let mut books = Vec::new();
    for path in comparison_vault_paths(vault_paths, &state)? {
        let connection = open_comparison_connection(&path)?;
        let vault_name = comparison_vault_name(&connection, &path)?;
        books.extend(comparison_books_from_connection(
            &connection,
            &path.to_string_lossy(),
            &vault_name,
        )?);
    }
    books.sort_by(|left, right| {
        right
            .event_date
            .cmp(&left.event_date)
            .then_with(|| left.vault_name.cmp(&right.vault_name))
            .then_with(|| left.title.cmp(&right.title))
    });
    Ok(books)
}

#[tauri::command]
fn comparison_book_entries(
    vault_path: String,
    book_id: String,
    state: State<'_, AppState>,
) -> Result<Vec<ComparisonBookEntry>, String> {
    let paths = comparison_vault_paths(vec![vault_path.clone()], &state)?;
    let requested = std::fs::canonicalize(&vault_path).map_err(|error| error.to_string())?;
    let path = paths
        .into_iter()
        .find(|candidate| candidate == &requested)
        .ok_or_else(|| "比较的礼金库不在当前比较范围内".to_string())?;
    let connection = open_comparison_connection(&path)?;
    let vault_name = comparison_vault_name(&connection, &path)?;
    comparison_book_entries_from_connection(
        &connection,
        &path.to_string_lossy(),
        &vault_name,
        &book_id,
    )
}

#[tauri::command]
fn search_comparison_people(
    vault_paths: Vec<String>,
    query: String,
    state: State<'_, AppState>,
) -> Result<Vec<ComparisonPerson>, String> {
    let mut people = Vec::new();
    for path in comparison_vault_paths(vault_paths, &state)? {
        let connection = open_comparison_connection(&path)?;
        let vault_name = comparison_vault_name(&connection, &path)?;
        people.extend(comparison_people_from_connection(
            &connection,
            &path.to_string_lossy(),
            &vault_name,
            None,
            &query,
        )?);
    }
    Ok(people)
}

fn normalized_comparison_person_name(value: &str) -> String {
    value
        .trim()
        .chars()
        .filter(|character| !character.is_whitespace())
        .flat_map(char::to_lowercase)
        .collect()
}

#[tauri::command]
fn search_comparison_duplicate_people(
    vault_paths: Vec<String>,
    state: State<'_, AppState>,
) -> Result<Vec<ComparisonPerson>, String> {
    let mut people = Vec::new();
    for path in comparison_vault_paths(vault_paths, &state)? {
        let connection = open_comparison_connection(&path)?;
        let vault_name = comparison_vault_name(&connection, &path)?;
        people.extend(comparison_people_from_connection(
            &connection,
            &path.to_string_lossy(),
            &vault_name,
            None,
            "*",
        )?);
    }
    let mut source_counts = HashMap::<String, HashSet<String>>::new();
    for person in &people {
        let name = normalized_comparison_person_name(&person.display_name);
        if !name.is_empty() {
            source_counts
                .entry(name)
                .or_default()
                .insert(person.vault_path.clone());
        }
    }
    people.retain(|person| {
        let name = normalized_comparison_person_name(&person.display_name);
        source_counts
            .get(&name)
            .is_some_and(|sources| sources.len() >= 2)
    });
    people.sort_by(|left, right| {
        left.display_name
            .cmp(&right.display_name)
            .then_with(|| left.vault_name.cmp(&right.vault_name))
            .then_with(|| left.address.cmp(&right.address))
    });
    Ok(people)
}

#[tauri::command]
fn search_comparison_book_people(
    book_refs: Vec<ComparisonBookRef>,
    query: String,
    state: State<'_, AppState>,
) -> Result<Vec<ComparisonPerson>, String> {
    let mut unique_people = HashMap::<String, ComparisonPerson>::new();
    for (path, book_id) in comparison_book_refs(book_refs, &state)? {
        let connection = open_comparison_connection(&path)?;
        let vault_name = comparison_vault_name(&connection, &path)?;
        for person in comparison_people_from_connection(
            &connection,
            &path.to_string_lossy(),
            &vault_name,
            Some(&book_id),
            &query,
        )? {
            let key = format!(
                "{}\u{1f}{}\u{1f}{}",
                person.vault_path, person.book_id, person.person_id
            );
            if let Some(existing) = unique_people.get_mut(&key) {
                merge_comparison_person_sources(existing, person);
            } else {
                unique_people.insert(key, person);
            }
        }
    }
    let mut people = unique_people.into_values().collect::<Vec<_>>();
    people.sort_by(|left, right| {
        left.display_name
            .cmp(&right.display_name)
            .then_with(|| left.vault_name.cmp(&right.vault_name))
            .then_with(|| left.address.cmp(&right.address))
    });
    Ok(people)
}

#[tauri::command]
fn search_comparison_duplicate_book_people(
    book_refs: Vec<ComparisonBookRef>,
    state: State<'_, AppState>,
) -> Result<Vec<ComparisonPerson>, String> {
    let mut unique_people = HashMap::<String, ComparisonPerson>::new();
    for (path, book_id) in comparison_book_refs(book_refs, &state)? {
        let connection = open_comparison_connection(&path)?;
        let vault_name = comparison_vault_name(&connection, &path)?;
        for person in comparison_people_from_connection(
            &connection,
            &path.to_string_lossy(),
            &vault_name,
            Some(&book_id),
            "*",
        )? {
            let key = format!(
                "{}\u{1f}{}\u{1f}{}",
                person.vault_path, person.book_id, person.person_id
            );
            if let Some(existing) = unique_people.get_mut(&key) {
                merge_comparison_person_sources(existing, person);
            } else {
                unique_people.insert(key, person);
            }
        }
    }
    let mut people = duplicate_comparison_people(unique_people.into_values().collect());
    people.sort_by(|left, right| {
        left.display_name
            .cmp(&right.display_name)
            .then_with(|| left.vault_name.cmp(&right.vault_name))
            .then_with(|| left.address.cmp(&right.address))
    });
    Ok(people)
}

fn merge_comparison_person_sources(target: &mut ComparisonPerson, incoming: ComparisonPerson) {
    for source in incoming.source_books {
        if !target.source_books.iter().any(|existing| {
            existing.book_id == source.book_id && existing.vault_path == source.vault_path
        }) {
            target.source_books.push(source);
        }
    }
    target.source_books.sort_by(|left, right| {
        left.book_title
            .cmp(&right.book_title)
            .then_with(|| left.book_id.cmp(&right.book_id))
    });
}

fn duplicate_comparison_people(people: Vec<ComparisonPerson>) -> Vec<ComparisonPerson> {
    let mut identities_by_name = HashMap::<String, HashSet<String>>::new();
    for person in &people {
        let name = normalized_comparison_person_name(&person.display_name);
        if !name.is_empty() {
            identities_by_name.entry(name).or_default().insert(format!(
                "{}\u{1f}{}\u{1f}{}",
                person.vault_path, person.book_id, person.person_id
            ));
        }
    }
    people
        .into_iter()
        .filter(|person| {
            let name = normalized_comparison_person_name(&person.display_name);
            identities_by_name
                .get(&name)
                .is_some_and(|identities| identities.len() >= 2)
        })
        .collect()
}

#[tauri::command]
fn comparison_person_history(
    people: Vec<ComparisonPersonRef>,
    book_refs: Vec<ComparisonBookRef>,
    state: State<'_, AppState>,
) -> Result<Vec<ComparisonPersonHistory>, String> {
    // Detail loading must remain bound to the current exact book selection, but a
    // selection can become stale while a search request is in flight. Ignore only
    // those stale paths instead of failing every selected book's detail table.
    if state
        .vault_path
        .lock()
        .map_err(|_| "礼金库状态不可用".to_string())?
        .is_none()
    {
        return Err("请先打开礼金库".to_string());
    }
    let mut books_by_vault = HashMap::<PathBuf, Vec<String>>::new();
    for reference in book_refs {
        let Ok(path) = std::fs::canonicalize(&reference.vault_path) else {
            continue;
        };
        let Ok(connection) = open_comparison_connection(&path) else {
            continue;
        };
        let exists = connection
            .query_row(
                "SELECT EXISTS(SELECT 1 FROM gift_books WHERE id = ? AND deleted_at IS NULL)",
                params![reference.book_id],
                |row| row.get::<_, bool>(0),
            )
            .unwrap_or(false);
        if exists {
            let book_ids = books_by_vault.entry(path).or_default();
            if !book_ids.contains(&reference.book_id) {
                book_ids.push(reference.book_id);
            }
        }
    }
    let mut seen = HashSet::new();
    let mut history = Vec::new();
    for person in people {
        let Ok(path) = std::fs::canonicalize(&person.vault_path) else {
            continue;
        };
        let Some(book_ids) = books_by_vault.get(&path) else {
            // Search state can change while an older request is still in flight.
            // Ignore that stale person reference instead of widening the scope or failing all results.
            continue;
        };
        let key = format!(
            "{}\u{1f}{}\u{1f}{}",
            path.to_string_lossy(),
            person.book_id,
            person.person_id
        );
        if !seen.insert(key) {
            continue;
        }
        let Ok(connection) = open_comparison_connection(&path) else {
            continue;
        };
        let Ok(vault_name) = comparison_vault_name(&connection, &path) else {
            continue;
        };
        if !book_ids.contains(&person.book_id) {
            continue;
        }
        for book_id in std::iter::once(&person.book_id) {
            if let Ok(entries) = comparison_person_history_from_connection(
                &connection,
                &path.to_string_lossy(),
                &vault_name,
                &person.person_id,
                Some(book_id),
            ) {
                history.extend(entries);
            }
        }
    }
    history.sort_by(|left, right| {
        right
            .event_date
            .cmp(&left.event_date)
            .then_with(|| right.latest_received_at.cmp(&left.latest_received_at))
    });
    Ok(history)
}

pub fn run() {
    #[cfg(windows)]
    let _instance = {
        let profile = app_profile_directory();
        let key = format!("{:x}", Sha256::digest(comparable_path(&profile).as_bytes()));
        match single_instance::InstanceGuard::acquire(&format!("Global\\lijin-remediation-{key}")) {
            Ok(guard) => guard,
            Err(error) => {
                eprintln!("{error}");
                return;
            }
        }
    };
    configure_embedded_webview_runtime();
    tauri::Builder::default()
        .plugin(tauri_plugin_updater::Builder::new().pubkey("").build())
        .manage(software_updates::SoftwareUpdates::default())
        .setup(|app| {
            if let Err(error) = ensure_published_update_directory(app.handle()) {
                eprintln!("无法初始化桌面发布目录: {error}");
            }
            Ok(())
        })
        .manage(AppState {
            vault_path: Mutex::new(None),
            opened_vault_paths: Mutex::new(Vec::new()),
            security: AppSecurityStore::new(app_security_path()),
            session: Mutex::new(SessionState::default()),
        })
        .invoke_handler(tauri::generate_handler![
            choose_vault_path,
            choose_vault_path_named,
            choose_comparison_vault_paths,
            local_update_status,
            software_updates::software_update_status,
            software_updates::software_update_options,
            software_updates::prepare_software_update,
            software_updates::apply_software_update,
            software_updates::acknowledge_software_update,
            software_updates::open_download_channel,
            open_local_update_directory,
            start_local_update,
            official_release_status,
            settings_storage_info,
            choose_settings_directory,
            license_text,
            create_vault,
            open_vault,
            close_vault,
            close_opened_vault,
            return_to_start_page,
            exit_app,
            session_status,
            get_app_security_status,
            setup_app_admin_pin,
            unlock_admin,
            lock_admin,
            unlock_editing,
            lock_editing,
            reset_app_pin_with_recovery,
            change_app_admin_pin,
            list_books,
            list_books_for_vault,
            create_book,
            edit_book,
            restore_book,
            list_entries,
            list_return_gifts,
            list_outbound_gifts,
            outbound_gift_summary,
            create_outbound_gift,
            update_outbound_gift,
            delete_outbound_gift,
            search_vault,
            create_entry,
            update_entry,
            update_return_gift_information,
            delete_entry,
            restore_entry,
            delete_person,
            restore_person,
            trash_vault,
            list_trash,
            list_audit_logs,
            clear_audit_logs,
            restore_audit_logs,
            restore_trash_item,
            empty_trash,
            list_tags,
            create_tag,
            update_tag_color,
            delete_tag,
            list_people,
            set_person_tags,
            list_book_stats,
            book_summary,
            person_history,
            list_comparison_books,
            comparison_book_entries,
            search_comparison_people,
            search_comparison_duplicate_people,
            search_comparison_book_people,
            search_comparison_duplicate_book_people,
            comparison_person_history,
            choose_spreadsheet_path,
            choose_spreadsheet_paths,
            preview_spreadsheet,
            preview_spreadsheet_mapping,
            import_spreadsheet,
            import_spreadsheets,
            export_book_xlsx,
            edit_vault,
            current_vault_info,
            export_vault
        ])
        .run(tauri::generate_context!())
        .expect("error while running 礼金簿");
}

#[cfg(test)]
mod data_regression_tests;

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn remediation_http_client_enforces_timeout_inside_tauri_async_runtime() {
        use std::io::{Read, Write};
        let listener = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
        let address = listener.local_addr().unwrap();
        let server = std::thread::spawn(move || {
            let (mut stream, _) = listener.accept().unwrap();
            let mut request = [0_u8; 4096];
            let _ = stream.read(&mut request);
            std::thread::sleep(Duration::from_millis(150));
            let _ = stream
                .write_all(b"HTTP/1.1 200 OK\r\nContent-Length: 2\r\nConnection: close\r\n\r\n{}");
        });
        let result = tauri::async_runtime::block_on(async {
            let client = update_http_client(Duration::from_millis(40)).unwrap();
            client
                .get(format!("http://{address}/controlled-release-test"))
                .send()
                .await
        });
        server.join().unwrap();
        assert!(result.is_err_and(|error| error.is_timeout()));
    }

    #[test]
    fn remediation_serializes_actual_snapshot_before_read_and_transaction_commit() {
        use std::sync::{mpsc, Arc};
        let directory = PathBuf::from(env!("CARGO_MANIFEST_DIR"))
            .join("target")
            .join(format!("serial-{}", Uuid::new_v4()));
        std::fs::create_dir_all(&directory).unwrap();
        let path = directory.join("fixture.giftvault");
        create_vault_file(&path, "fixture", "").unwrap();
        let c = Connection::open(&path).unwrap();
        c.execute("INSERT INTO gift_books(id,title,created_at,updated_at) VALUES ('b','book','now','now')", []).unwrap();
        c.execute("INSERT INTO people(id,display_name,created_at,updated_at) VALUES ('p','person','now','now')", []).unwrap();
        c.execute("INSERT INTO gift_entries(id,book_id,person_id,amount_fen,payment_method,received_at,created_at,updated_at) VALUES ('e','b','p',100,'cash','2026-10-14','now','now')", []).unwrap();
        drop(c);
        let state = Arc::new(AppState {
            vault_path: Mutex::new(Some(path.clone())),
            opened_vault_paths: Mutex::new(vec![path.clone()]),
            security: AppSecurityStore::new(directory.join("unused-security.sqlite")),
            session: Mutex::new(SessionState {
                role: SessionRole::Admin,
                edit_locked: false,
                ..Default::default()
            }),
        });
        let (sent, received) = mpsc::channel();
        let first_state = state.clone();
        let first_path = path.clone();
        let first = std::thread::spawn(move || {
            with_operation(|| {
                let mut c = admin_connection(
                    &first_state,
                    &displayable_path(&first_path),
                    "serialization-test",
                    true,
                )?;
                let before: i64 = c
                    .query_row(
                        "SELECT amount_fen FROM gift_entries WHERE id='e'",
                        [],
                        |row| row.get(0),
                    )
                    .unwrap();
                sent.send(()).unwrap();
                std::thread::sleep(Duration::from_millis(200));
                let tx = c.transaction().unwrap();
                tx.execute(
                    "UPDATE gift_entries SET amount_fen=? WHERE id='e'",
                    [before + 1],
                )
                .unwrap();
                tx.commit().unwrap();
                Ok(())
            })
        });
        received.recv().unwrap();
        let second_state = state.clone();
        let second_path = path.clone();
        let second = std::thread::spawn(move || {
            with_operation(|| {
                let mut c = admin_connection(
                    &second_state,
                    &displayable_path(&second_path),
                    "serialization-test",
                    true,
                )?;
                let before: i64 = c
                    .query_row(
                        "SELECT amount_fen FROM gift_entries WHERE id='e'",
                        [],
                        |row| row.get(0),
                    )
                    .unwrap();
                let tx = c.transaction().unwrap();
                tx.execute(
                    "UPDATE gift_entries SET amount_fen=? WHERE id='e'",
                    [before + 1],
                )
                .unwrap();
                tx.commit().unwrap();
                Ok(before)
            })
        });
        first.join().unwrap().unwrap();
        assert_eq!(
            second.join().unwrap().unwrap(),
            101,
            "second preparation must see first commit"
        );
        let c = Connection::open(&path).unwrap();
        assert_eq!(
            c.query_row(
                "SELECT amount_fen FROM gift_entries WHERE id='e'",
                [],
                |row| row.get::<_, i64>(0)
            )
            .unwrap(),
            102
        );
        drop(c);
        std::fs::remove_dir_all(directory).unwrap();
    }

    fn remediation_security_state() -> AppState {
        let path = PathBuf::from(env!("CARGO_MANIFEST_DIR"))
            .join("target")
            .join(format!("auth-{}.sqlite", Uuid::new_v4()));
        let security = AppSecurityStore::new(path);
        security.setup_pin("123456").unwrap();
        AppState {
            vault_path: Mutex::new(None),
            opened_vault_paths: Mutex::new(Vec::new()),
            security,
            session: Mutex::new(SessionState::default()),
        }
    }

    #[test]
    fn remediation_clear_trash_requires_admin_pin_but_admin_starts_edit_unlocked() {
        let state = remediation_security_state();
        assert!(authorize_empty_trash(&state, "123456").is_err());
        assert!(state.session.lock().unwrap().role == SessionRole::Viewer);
        set_admin_session(&state).unwrap();
        assert!(!state.session.lock().unwrap().edit_locked);
        assert!(authorize_empty_trash(&state, "654321").is_err());
        authorize_empty_trash(&state, "123456").unwrap();
        assert!(state.session.lock().unwrap().role == SessionRole::Admin);
        assert!(!state.session.lock().unwrap().edit_locked);
        set_edit_locked(&state, true).unwrap();
        assert!(authorize_empty_trash(&state, "123456").is_err());
    }

    #[test]
    fn remediation_pin_and_recovery_share_limit_even_after_logout() {
        let state = remediation_security_state();
        for _ in 0..MAX_LOGIN_ATTEMPTS {
            assert!(verify_pin_for_operation(&state, "wrong").is_err());
            reset_session(&state).unwrap();
        }
        assert!(verify_pin_for_operation(&state, "123456")
            .unwrap_err()
            .contains("次数过多"));
        assert!(authentication_attempt(&state, || state
            .security
            .reset_with_recovery("bad", "654321"))
        .unwrap_err()
        .contains("次数过多"));
        assert!(state.security.verify_pin("123456").unwrap());
    }

    #[test]
    fn remediation_logout_preserves_attempt_cooldown() {
        let state = AppState {
            vault_path: Mutex::new(None),
            opened_vault_paths: Mutex::new(Vec::new()),
            security: AppSecurityStore::new(
                PathBuf::from(env!("CARGO_MANIFEST_DIR"))
                    .join("target")
                    .join("never-open.sqlite"),
            ),
            session: Mutex::new(SessionState {
                role: SessionRole::Admin,
                failed_attempts: 4,
                locked_until: Some(Instant::now() + LOGIN_COOLDOWN),
                edit_locked: false,
            }),
        };
        reset_session(&state).unwrap();
        let session = state.session.lock().unwrap();
        assert_eq!(session.failed_attempts, 4);
        assert!(session.locked_until.is_some());
        assert!(session.role == SessionRole::Viewer && session.edit_locked);
    }

    #[test]
    fn remediation_versions_reject_incomplete_and_noncanonical_inputs_without_panicking() {
        for value in ["1", "1.2", "1.2.3.4", "01.2.3", "+1.2.3", "1. 2.3"] {
            assert_eq!(parse_release_version(value), None, "{value}");
        }
    }

    #[test]
    fn remediation_local_candidates_are_exclusive_to_variant() {
        assert!(candidate_from_path(Path::new("礼金簿管理_9.9.9_x64-setup.exe")).is_none());
        assert!(candidate_from_path(Path::new("礼金簿_0.4.30_x64-setup.exe")).is_some());
        assert!(candidate_from_path(Path::new("礼金簿—改动_0.4.30_x64-setup.exe")).is_none());
    }

    #[test]
    fn display_path_removes_windows_extended_length_prefix() {
        assert_eq!(
            displayable_path(Path::new(r"\\?\D:\Desktop\礼金簿.xlsx")),
            r"D:\Desktop\礼金簿.xlsx"
        );
        assert_eq!(
            displayable_path(Path::new(r"\\?\UNC\server\礼金簿.xlsx")),
            r"\\server\礼金簿.xlsx"
        );
        assert_eq!(
            displayable_path(Path::new(r"D:\Desktop\礼金簿.xlsx")),
            r"D:\Desktop\礼金簿.xlsx"
        );
    }

    #[test]
    fn embedded_webview_runtime_path_supports_portable_and_installed_layouts() {
        let root = std::env::temp_dir().join(format!("lijin-book-webview-{}", Uuid::new_v4()));
        let portable_runtime = root.join("webview2-fixed");
        std::fs::create_dir_all(&portable_runtime).expect("portable runtime directory");
        std::fs::write(portable_runtime.join("msedgewebview2.exe"), b"runtime")
            .expect("portable runtime marker");
        let executable = root.join("lijin-book.exe");
        assert_eq!(selected_webview_runtime(&executable, true), None);
        assert_eq!(
            selected_webview_runtime(&executable, false),
            Some(portable_runtime.clone())
        );
        assert_eq!(
            embedded_webview_runtime_directory(&executable),
            Some(portable_runtime.clone())
        );

        std::fs::remove_file(portable_runtime.join("msedgewebview2.exe"))
            .expect("remove portable marker");
        let installed_runtime = root.join("resources").join("webview2-fixed");
        std::fs::create_dir_all(&installed_runtime).expect("installed runtime directory");
        std::fs::write(installed_runtime.join("msedgewebview2.exe"), b"runtime")
            .expect("installed runtime marker");
        assert_eq!(
            embedded_webview_runtime_directory(&executable),
            Some(installed_runtime)
        );
        std::fs::remove_dir_all(root).expect("remove runtime test directory");
        assert_eq!(selected_webview_runtime(&executable, false), None);
    }

    #[test]
    fn update_launcher_embeds_escaped_paths_without_positional_powershell_arguments() {
        let script = local_update_launcher_script(
            Path::new(r"C:\Users\Updater\updates\礼金簿管理_0.3.1_x64-setup.exe"),
            Path::new(r"C:\Users\Updater\AppData\Local\礼金簿管理\礼金簿管理.exe"),
            Path::new(r"C:\Program Files\lijin-book\lijin-book.exe"),
            4242,
            Path::new(r"C:\Users\Updater\updates\update.log"),
            &"a".repeat(64),
        );

        assert!(script.contains(
            "$installer = 'C:\\Users\\Updater\\updates\\礼金簿管理_0.3.1_x64-setup.exe'"
        ));
        assert!(script.contains(
            "$installedApplication = 'C:\\Users\\Updater\\AppData\\Local\\礼金簿管理\\礼金簿管理.exe'"
        ));
        assert!(script
            .contains("$fallbackApplication = 'C:\\Program Files\\lijin-book\\lijin-book.exe'"));
        assert!(script.contains("$oldProcessId = 4242"));
        assert!(script.contains("Get-Process -Id $oldProcessId"));
        assert!(script.contains("Start-Process -FilePath $installer"));
        assert!(script.contains("$launchTarget = if ($exitCode -eq 0) { $installedApplication } else { $fallbackApplication }"));
        assert!(script.contains("Start-Process -FilePath $launchTarget"));
        assert!(!script.contains("$args"));
    }

    #[test]
    fn update_launcher_script_uses_utf16le_bom_for_chinese_paths() {
        let script = "$installer = 'C:\\\\Users\\\\Updater\\\\AppData\\\\Local\\\\礼金簿管理\\\\updates\\\\礼金簿管理_0.3.5_x64-setup.exe'";
        let bytes = windows_powershell_script_bytes(script);
        assert_eq!(&bytes[..2], &[0xff, 0xfe]);
        let code_units = bytes[2..]
            .chunks_exact(2)
            .map(|pair| u16::from_le_bytes([pair[0], pair[1]]))
            .collect::<Vec<_>>();
        assert_eq!(
            String::from_utf16(&code_units).expect("valid UTF-16LE"),
            script
        );
    }

    #[test]
    fn comparison_queries_keep_same_named_people_separate_by_address_and_tags() {
        let connection = Connection::open_in_memory().expect("memory db");
        migrate(&connection).expect("migration");
        connection
            .execute(
                "INSERT OR REPLACE INTO vault_meta(key, value) VALUES ('name', 'Archived gifts')",
                [],
            )
            .expect("vault name");
        connection
            .execute(
                "INSERT INTO gift_books(id, title, event_date, created_at, updated_at) VALUES ('book-1', 'Spring wedding', '2025-05-01', 'now', 'now')",
                [],
            )
            .expect("book");
        for (id, address) in [
            ("person-a", "North district"),
            ("person-b", "South district"),
        ] {
            connection
                .execute(
                    "INSERT INTO people(id, display_name, address, created_at, updated_at) VALUES (?, 'Li Ergou', ?, 'now', 'now')",
                    params![id, address],
                )
                .expect("person");
        }
        connection
            .execute(
                "INSERT INTO tags(id, name, color, created_at) VALUES ('tag-a', 'Relative', '#d97706', 'now'), ('tag-b', 'Classmate', '#2563eb', 'now')",
                [],
            )
            .expect("tags");
        connection
            .execute(
                "INSERT INTO person_tags(person_id, tag_id) VALUES ('person-a', 'tag-a'), ('person-b', 'tag-b')",
                [],
            )
            .expect("person tags");
        connection
            .execute(
                "INSERT INTO gift_entries(id, book_id, person_id, amount_fen, payment_method, received_at, created_at, updated_at) VALUES ('entry-a', 'book-1', 'person-a', 50000, 'Cash', '2025-05-01 10:00:00', 'now', 'now'), ('entry-b', 'book-1', 'person-b', 80000, 'Cash', '2025-05-01 11:00:00', 'now', 'now')",
                [],
            )
            .expect("entries");

        let books = comparison_books_from_connection(
            &connection,
            "C:\\archive.giftvault",
            "Archived gifts",
        )
        .expect("comparison books");
        let people = comparison_people_from_connection(
            &connection,
            "C:\\archive.giftvault",
            "Archived gifts",
            None,
            "Li Ergou",
        )
        .expect("comparison people");

        assert_eq!(books.len(), 1);
        assert_eq!(books[0].vault_name, "Archived gifts");
        assert_eq!(books[0].people_count, 2);
        assert_eq!(people.len(), 2);
        assert_eq!(people[0].display_name, "Li Ergou");
        assert_ne!(people[0].address, people[1].address);
        assert_ne!(people[0].tags[0].name, people[1].tags[0].name);
    }

    #[test]
    fn comparison_search_matches_and_merges_person_and_entry_notes() {
        let connection = Connection::open_in_memory().expect("memory db");
        migrate(&connection).expect("migration");
        connection
            .execute(
                "INSERT INTO gift_books(id, title, created_at, updated_at) VALUES ('book-1', 'Test book', 'now', 'now')",
                [],
            )
            .expect("book");
        connection
            .execute(
                "INSERT INTO people(id, display_name, notes, created_at, updated_at) VALUES ('person-a', '张伟', '人物备注', 'now', 'now'), ('person-b', '张伟', NULL, 'now', 'now')",
                [],
            )
            .expect("people");
        connection
            .execute(
                "INSERT INTO gift_entries(id, book_id, person_id, amount_fen, payment_method, note, received_at, created_at, updated_at) VALUES ('entry-a', 'book-1', 'person-a', 100, '现金', '登记备注', 'now', 'now', 'now'), ('entry-b', 'book-1', 'person-b', 200, '现金', '另一条备注', 'now', 'now', 'now')",
                [],
            )
            .expect("entries");

        let person_note_matches = comparison_people_from_connection(
            &connection,
            "C:\\test.giftvault",
            "Test vault",
            Some("book-1"),
            "人物备注",
        )
        .expect("person note search");
        let entry_note_matches = comparison_people_from_connection(
            &connection,
            "C:\\test.giftvault",
            "Test vault",
            Some("book-1"),
            "另一条备注",
        )
        .expect("entry note search");

        assert_eq!(person_note_matches.len(), 1);
        assert_eq!(
            person_note_matches[0].notes.as_deref(),
            Some("人物备注、登记备注")
        );
        assert_eq!(entry_note_matches.len(), 1);
        assert_eq!(entry_note_matches[0].person_id, "person-b");
        assert_eq!(entry_note_matches[0].notes.as_deref(), Some("另一条备注"));
    }

    #[test]
    fn person_tag_audit_sources_list_all_related_gift_books() {
        let connection = Connection::open_in_memory().expect("memory db");
        migrate(&connection).expect("migration");
        connection
            .execute(
                "INSERT INTO people(id, display_name, created_at, updated_at) VALUES ('person-1', 'Person', 'now', 'now')",
                [],
            )
            .expect("person");
        connection
            .execute(
                "INSERT INTO gift_books(id, title, created_at, updated_at) VALUES ('book-a', 'Book A', 'now', 'now'), ('book-b', 'Book B', 'now', 'now')",
                [],
            )
            .expect("books");
        connection
            .execute(
                "INSERT INTO gift_entries(id, book_id, person_id, amount_fen, payment_method, received_at, created_at, updated_at) VALUES ('entry-a', 'book-a', 'person-1', 100, 'Cash', 'now', 'now', 'now'), ('entry-b', 'book-b', 'person-1', 100, 'Cash', 'now', 'now', 'now')",
                [],
            )
            .expect("entries");

        assert_eq!(
            audit_person_book_titles(&connection, "person-1").expect("audit source"),
            "Book A、Book B"
        );
        assert_eq!(
            audit_person_book_titles(&connection, "missing").expect("empty audit source"),
            "未关联礼金簿"
        );
    }

    #[test]
    fn comparison_search_returns_all_people_in_an_added_vault() {
        let connection = Connection::open_in_memory().expect("memory db");
        migrate(&connection).expect("migration");
        connection
            .execute(
                "INSERT INTO gift_books(id, title, created_at, updated_at) VALUES ('book-1', 'Search', 'now', 'now')",
                [],
            )
            .expect("book");
        for index in 0..101 {
            let person_id = format!("person-{index}");
            let entry_id = format!("entry-{index}");
            connection
                .execute(
                    "INSERT INTO people(id, display_name, created_at, updated_at) VALUES (?, '刘洋', 'now', 'now')",
                    params![person_id],
                )
                .expect("person");
            connection
                .execute(
                    "INSERT INTO gift_entries(id, book_id, person_id, amount_fen, payment_method, received_at, created_at, updated_at) VALUES (?, 'book-1', ?, 100, '现金', 'now', 'now', 'now')",
                    params![entry_id, person_id],
                )
                .expect("entry");
        }

        let people = comparison_people_from_connection(
            &connection,
            "D:\\added.giftvault",
            "Added vault",
            None,
            "刘洋",
        )
        .expect("comparison people");

        assert_eq!(people.len(), 101);
    }

    #[test]
    fn duplicate_comparison_people_keeps_same_book_collisions_and_distinct_paths() {
        let person = |vault_path: &str, book_id: &str, person_id: &str, display_name: &str| {
            ComparisonPerson {
                vault_path: vault_path.to_string(),
                vault_name: "Test vault".to_string(),
                book_id: book_id.to_string(),
                person_id: person_id.to_string(),
                display_name: display_name.to_string(),
                address: None,
                notes: None,
                tags: Vec::new(),
                source_books: Vec::new(),
            }
        };
        let people = vec![
            person("D:\\same.giftvault", "book-1", "person-a", "Liu Yang"),
            person("D:\\same.giftvault", "book-2", "person-b", "Liu Yang"),
            person("D:\\other.giftvault", "book-1", "person-a", "Liu Yang"),
            person("D:\\same.giftvault", "book-1", "person-c", "Wang Mei"),
        ];

        let duplicates = duplicate_comparison_people(people);
        let identities = duplicates
            .iter()
            .map(|person| {
                format!(
                    "{}\u{1f}{}\u{1f}{}",
                    person.vault_path, person.book_id, person.person_id
                )
            })
            .collect::<HashSet<_>>();

        assert_eq!(duplicates.len(), 3);
        assert!(identities.contains("D:\\same.giftvault\u{1f}book-1\u{1f}person-a"));
        assert!(identities.contains("D:\\same.giftvault\u{1f}book-2\u{1f}person-b"));
        assert!(identities.contains("D:\\other.giftvault\u{1f}book-1\u{1f}person-a"));
        assert!(!identities
            .iter()
            .any(|identity| identity.ends_with("person-c")));
    }

    #[test]
    fn tag_colors_accept_only_standard_rgb_hex_values() {
        assert_eq!(
            normalize_tag_color(" #A1b2C3 ").expect("valid color"),
            "#a1b2c3"
        );
        assert!(normalize_tag_color("red").is_err());
        assert!(normalize_tag_color("#12345").is_err());
        assert!(normalize_tag_color("#123456; color: red").is_err());
    }

    #[test]
    fn comparison_book_entries_include_detail_fields_and_tag_colors() {
        let connection = Connection::open_in_memory().expect("memory db");
        migrate(&connection).expect("migration");
        connection
            .execute(
                "INSERT INTO gift_books(id, title, created_at, updated_at) VALUES ('book-1', 'Detailed book', 'now', 'now')",
                [],
            )
            .expect("book");
        connection
            .execute(
                "INSERT INTO people(id, display_name, address, created_at, updated_at) VALUES ('person-1', 'Liu Yang', 'Kunming', 'now', 'now')",
                [],
            )
            .expect("person");
        connection
            .execute(
                "INSERT INTO tags(id, name, color, created_at) VALUES ('tag-1', 'Relative', '#0f766e', 'now')",
                [],
            )
            .expect("tag");
        connection
            .execute(
                "INSERT INTO person_tags(person_id, tag_id) VALUES ('person-1', 'tag-1')",
                [],
            )
            .expect("person tag");
        connection
            .execute(
                "INSERT INTO gift_entries(id, book_id, person_id, amount_fen, payment_method, received_at, note, return_gift, created_at, updated_at) VALUES ('entry-1', 'book-1', 'person-1', 12345, 'Cash', '2025-01-01 10:00:00', 'hello', '喜糖', 'now', 'now')",
                [],
            )
            .expect("entry");

        let entries = comparison_book_entries_from_connection(
            &connection,
            "D:\\detail.giftvault",
            "Detail vault",
            "book-1",
        )
        .expect("comparison entries");

        assert_eq!(entries.len(), 1);
        assert_eq!(entries[0].amount_fen, 12345);
        assert_eq!(entries[0].payment_method, "Cash");
        assert_eq!(entries[0].note.as_deref(), Some("hello"));
        assert_eq!(entries[0].return_gift.as_deref(), Some("喜糖"));
        assert_eq!(entries[0].tags[0].color, "#0f766e");
    }

    #[test]
    fn comparison_person_history_reads_only_the_requested_gift_book() {
        let connection = Connection::open_in_memory().expect("memory db");
        migrate(&connection).expect("migration");
        connection
            .execute_batch(
                "INSERT INTO gift_books(id, title, created_at, updated_at) VALUES
                   ('book-a', 'Book A', 'now', 'now'),
                   ('book-b', 'Book B', 'now', 'now');
                 INSERT INTO people(id, display_name, created_at, updated_at)
                   VALUES ('person-1', 'Liu Yang', 'now', 'now');
                 INSERT INTO gift_entries(id, book_id, person_id, amount_fen, payment_method, received_at, created_at, updated_at) VALUES
                   ('entry-a', 'book-a', 'person-1', 10000, 'Cash', '2026-08-10 10:00:00', 'now', 'now'),
                   ('entry-b', 'book-b', 'person-1', 20000, 'Cash', '2026-08-10 11:00:00', 'now', 'now');",
            )
            .expect("comparison fixtures");

        let entries = comparison_person_history_from_connection(
            &connection,
            "D:\\comparison.giftvault",
            "Comparison vault",
            "person-1",
            Some("book-a"),
        )
        .expect("book-scoped history");

        assert_eq!(entries.len(), 1);
        assert_eq!(entries[0].book_id, "book-a");
        assert_eq!(entries[0].book_title, "Book A");
        assert_eq!(entries[0].entry_id, "entry-a");
        assert_eq!(entries[0].total_fen, 10000);
    }

    #[test]
    fn native_file_dialog_default_is_the_windows_this_pc_namespace() {
        assert_eq!(
            WINDOWS_THIS_PC_NAMESPACE,
            "::{20D04FE0-3AEA-1069-A2D8-08002B30309D}"
        );
    }

    #[test]
    fn current_schema_keeps_source_columns_tag_soft_delete_and_return_gift_columns() {
        let connection = Connection::open_in_memory().expect("memory db");
        migrate(&connection).expect("migration");
        let version: i32 = connection
            .pragma_query_value(None, "user_version", |row| row.get(0))
            .expect("schema version");
        assert_eq!(version, CURRENT_SCHEMA);
        assert!(table_has_column(&connection, "tags", "deleted_at").expect("tag column"));
        assert!(
            table_has_column(&connection, "gift_books", "source_file_name")
                .expect("source file column")
        );
        assert!(
            table_has_column(&connection, "gift_books", "source_file_path")
                .expect("source file path column")
        );
        assert!(
            table_has_column(&connection, "gift_books", "source_imported_at")
                .expect("source time column")
        );
        assert!(table_has_column(&connection, "gift_entries", "return_gift")
            .expect("return gift column"));
        assert!(
            table_has_column(&connection, "gift_entries", "return_gift_amount_fen")
                .expect("return gift amount column")
        );
        assert!(
            table_has_column(&connection, "gift_entries", "return_gifted_at")
                .expect("return gift time column")
        );
        assert_eq!(
            connection
                .query_row(
                    "SELECT value FROM vault_meta WHERE key = 'notes'",
                    [],
                    |row| row.get::<_, String>(0),
                )
                .expect("vault notes metadata"),
            ""
        );
    }

    #[test]
    fn vault_validation_requires_format_tables_and_integrity() {
        let connection = Connection::open_in_memory().expect("memory db");
        migrate(&connection).expect("migration");
        validate_vault_connection(&connection).expect("valid giftvault schema");
        connection
            .execute("DELETE FROM vault_meta WHERE key = 'format'", [])
            .expect("remove format marker");
        assert!(validate_vault_connection(&connection).is_err());
    }

    #[test]
    fn schema_v5_adds_source_file_path_without_losing_existing_source_metadata() {
        let connection = Connection::open_in_memory().expect("memory db");
        connection
            .execute_batch(
                "CREATE TABLE gift_books (
                   id TEXT PRIMARY KEY NOT NULL,
                   title TEXT NOT NULL,
                   source_file_name TEXT,
                   source_imported_at TEXT
                 );
                 CREATE TABLE gift_entries (
                   id TEXT PRIMARY KEY NOT NULL
                 );
                 CREATE TABLE tags (
                   id TEXT PRIMARY KEY NOT NULL,
                   name TEXT NOT NULL,
                   color TEXT NOT NULL,
                   deleted_at TEXT
                 );
                 INSERT INTO gift_books(id, title, source_file_name, source_imported_at)
                   VALUES ('book-1', '婚礼礼金', '宾客名单.xlsx', '2026-08-07T00:00:00Z');
                 PRAGMA user_version = 4;",
            )
            .expect("v4 schema");

        migrate(&connection).expect("v4 to current migration");

        let version: i32 = connection
            .pragma_query_value(None, "user_version", |row| row.get(0))
            .expect("schema version");
        let source: (String, String, String, Option<String>) = connection
            .query_row(
                "SELECT title, source_file_name, source_imported_at, source_file_path FROM gift_books WHERE id = 'book-1'",
                [],
                |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?, row.get(3)?)),
            )
            .expect("preserved source metadata");

        assert_eq!(version, CURRENT_SCHEMA);
        assert_eq!(source.0, "婚礼礼金");
        assert_eq!(source.1, "宾客名单.xlsx");
        assert_eq!(source.2, "2026-08-07T00:00:00Z");
        assert_eq!(source.3, None);
    }

    #[test]
    fn deleting_and_restoring_tag_preserves_person_links() {
        let mut connection = Connection::open_in_memory().expect("memory db");
        migrate(&connection).expect("migration");
        connection
            .execute(
                "INSERT INTO people(id, display_name, created_at, updated_at) VALUES ('person-1', '张三', 'now', 'now')",
                [],
            )
            .expect("person");
        connection
            .execute(
                "INSERT INTO tags(id, name, color, created_at, deleted_at) VALUES ('tag-1', '同学', '#2563eb', 'now', NULL)",
                [],
            )
            .expect("tag");
        connection
            .execute(
                "INSERT INTO person_tags(person_id, tag_id) VALUES ('person-1', 'tag-1')",
                [],
            )
            .expect("person tag");
        delete_tag_record(&mut connection, "tag-1").expect("soft delete tag");
        let (deleted, links): (Option<String>, i64) = connection
            .query_row(
                "SELECT t.deleted_at, (SELECT COUNT(*) FROM person_tags WHERE tag_id = t.id) FROM tags t WHERE t.id = 'tag-1'",
                [],
                |row| Ok((row.get(0)?, row.get(1)?)),
            )
            .expect("deleted tag");
        assert!(deleted.is_some());
        assert_eq!(links, 1);
        restore_tag_record(&mut connection, "tag-1").expect("restore tag");
        let (deleted_after, links_after): (Option<String>, i64) = connection
            .query_row(
                "SELECT deleted_at, (SELECT COUNT(*) FROM person_tags WHERE tag_id = 'tag-1') FROM tags WHERE id = 'tag-1'",
                [],
                |row| Ok((row.get(0)?, row.get(1)?)),
            )
            .expect("restored tag");
        assert!(deleted_after.is_none());
        assert_eq!(links_after, 1);
    }

    #[test]
    fn mapped_spreadsheet_analysis_accepts_manual_required_columns() {
        let sheet = ParsedSheet {
            file_name: "manual.csv".to_string(),
            sheet_name: "CSV".to_string(),
            header_row: 1,
            headers: vec![
                "说明".to_string(),
                "金额文本".to_string(),
                "姓名文本".to_string(),
            ],
            rows: vec![vec![
                "备注".to_string(),
                "800".to_string(),
                "李四".to_string(),
            ]],
        };
        let analysis = analyze_sheet_with_mapping(
            &sheet,
            &SpreadsheetColumnMapping {
                name: Some(2),
                amount: Some(1),
                ..Default::default()
            },
        );
        assert!(analysis.errors.is_empty());
        assert_eq!(analysis.valid_rows, 1);
    }

    #[test]
    fn import_transaction_rolls_back_all_rows_when_batch_fails() {
        let sheet = ParsedSheet {
            file_name: "atomic.csv".to_string(),
            sheet_name: "CSV".to_string(),
            header_row: 1,
            headers: vec!["姓名".to_string(), "金额".to_string()],
            rows: vec![vec!["张三".to_string(), "500".to_string()]],
        };
        let analysis = analyze_sheet(&sheet);
        let mut connection = Connection::open_in_memory().expect("memory db");
        migrate(&connection).expect("migration");
        let mut catalog = load_tag_catalog(&connection).expect("tag catalog");
        {
            let transaction = connection.transaction().expect("transaction");
            transaction
                .execute(
                    "INSERT INTO gift_books(id, title, created_at, updated_at) VALUES ('book-1', '导入一', 'now', 'now')",
                    [],
                )
                .expect("book");
            import_sheet_into_transaction(&transaction, &sheet, &analysis, "book-1", &mut catalog)
                .expect("first file");
            // Dropping an uncommitted transaction models a later file failure.
        }
        let (books, entries): (i64, i64) = connection
            .query_row(
                "SELECT (SELECT COUNT(*) FROM gift_books), (SELECT COUNT(*) FROM gift_entries)",
                [],
                |row| Ok((row.get(0)?, row.get(1)?)),
            )
            .expect("counts");
        assert_eq!((books, entries), (0, 0));
    }

    fn trashed_records_connection() -> Connection {
        let connection = Connection::open_in_memory().expect("memory db");
        migrate(&connection).expect("migration");
        connection
            .execute(
                "INSERT INTO gift_books(id, title, created_at, updated_at, deleted_at) VALUES ('book-1', '婚礼礼金', 'now', 'now', 'deleted')",
                [],
            )
            .expect("trashed book");
        connection
            .execute(
                "INSERT INTO people(id, display_name, created_at, updated_at) VALUES ('person-1', '张三', 'now', 'now')",
                [],
            )
            .expect("person");
        connection
            .execute(
                "INSERT INTO gift_entries(id, book_id, person_id, amount_fen, payment_method, received_at, created_at, updated_at, deleted_at) VALUES ('entry-1', 'book-1', 'person-1', 50000, '现金', '2026-08-06 12:00:00', 'now', 'now', 'deleted')",
                [],
            )
            .expect("trashed entry");
        connection
    }

    #[test]
    fn emptying_trash_permanently_removes_trashed_books_and_entries() {
        let mut connection = trashed_records_connection();

        empty_trash_records(&mut connection).expect("empty trash");

        let books: i64 = connection
            .query_row("SELECT COUNT(*) FROM gift_books", [], |row| row.get(0))
            .expect("book count");
        let entries: i64 = connection
            .query_row("SELECT COUNT(*) FROM gift_entries", [], |row| row.get(0))
            .expect("entry count");
        assert_eq!((books, entries), (0, 0));
    }

    #[test]
    fn parses_exact_money_values_without_float_rounding() {
        assert_eq!(parse_amount_fen("500"), Some(50_000));
        assert_eq!(parse_amount_fen("¥1,200.50"), Some(120_050));
        assert_eq!(parse_amount_fen("12.3元"), Some(1_230));
        assert_eq!(parse_amount_fen(" 500 元 "), Some(50_000));
        assert_eq!(parse_amount_fen("12.345"), None);
        assert_eq!(parse_amount_fen("abc"), None);
    }

    #[test]
    fn normalizes_chinese_and_english_headers() {
        assert_eq!(normalized_header(" 金额： "), "金额");
        assert_eq!(normalized_header("\u{feff}姓名"), "姓名");
        assert_eq!(
            column_index(
                &["姓名".to_string(), "礼金金额".to_string()],
                &["金额", "amount"]
            ),
            Some(1)
        );
    }

    #[test]
    fn spreadsheet_parser_finds_header_after_title_rows_and_keeps_optional_columns() {
        let rows = vec![
            vec!["2026 年婚礼礼金登记".to_string()],
            vec![
                "姓名".to_string(),
                "金额（元）".to_string(),
                "备注".to_string(),
                "人物标签".to_string(),
            ],
            vec![
                "张三".to_string(),
                "500".to_string(),
                "带礼品".to_string(),
                "亲戚 / 同学".to_string(),
            ],
        ];

        let sheet = parsed_sheet_from_rows("test.xlsx", "礼金明细", rows)
            .expect("header row should be detected");

        assert_eq!(sheet.headers, ["姓名", "金额（元）", "备注", "人物标签"]);
        assert_eq!(sheet.rows.len(), 1);
        assert_eq!(sheet.rows[0][3], "亲戚 / 同学");
    }

    #[test]
    fn spreadsheet_analysis_recognizes_optional_chinese_aliases() {
        let sheet = ParsedSheet {
            file_name: "aliases.csv".to_string(),
            sheet_name: "CSV".to_string(),
            header_row: 1,
            headers: vec![
                "来宾".to_string(),
                "礼金金额（元）".to_string(),
                "住址".to_string(),
                "付款方式".to_string(),
                "登记时间".to_string(),
                "附言".to_string(),
                "人物标签".to_string(),
            ],
            rows: vec![vec![
                "张三".to_string(),
                "500 元".to_string(),
                "昆明".to_string(),
                "微信".to_string(),
                "2026-08-06".to_string(),
                "带礼品".to_string(),
                "亲戚/同学".to_string(),
            ]],
        };
        let analysis = analyze_sheet(&sheet);
        assert!(analysis.name_index.is_some());
        assert!(analysis.amount_index.is_some());
        assert!(analysis.address_index.is_some());
        assert!(analysis.payment_index.is_some());
        assert!(analysis.date_index.is_some());
        assert!(analysis.note_index.is_some());
        assert!(analysis.tag_index.is_some());
        assert_eq!(analysis.valid_rows, 1);
        assert!(analysis.errors.is_empty());
    }

    #[test]
    fn tag_cells_split_common_excel_delimiters_and_deduplicate_names() {
        assert_eq!(
            split_tag_names("亲戚 / 同学、人才\n亲戚；家人"),
            vec!["亲戚", "同学", "人才", "家人"]
        );
    }

    #[test]
    fn imported_tag_colors_are_unique_and_skip_existing_colors() {
        let used = ["#0f766e", "#2563eb"]
            .into_iter()
            .map(str::to_string)
            .collect::<HashSet<_>>();

        let first = next_auto_tag_color(&used);
        assert_ne!(first, "#0f766e");
        assert_ne!(first, "#2563eb");

        let mut exhausted = AUTO_TAG_COLORS
            .iter()
            .map(|color| (*color).to_string())
            .collect::<HashSet<_>>();
        let generated = next_auto_tag_color(&exhausted);
        assert!(!exhausted.contains(&generated));
        exhausted.insert(generated.clone());
        assert_ne!(next_auto_tag_color(&exhausted), generated);
    }

    #[test]
    fn tag_preview_marks_existing_and_new_values_with_planned_colors() {
        let sheet = ParsedSheet {
            file_name: "tags.xlsx".to_string(),
            sheet_name: "明细".to_string(),
            header_row: 1,
            headers: vec!["姓名".to_string(), "金额".to_string(), "标签".to_string()],
            rows: vec![
                vec![
                    "张三".to_string(),
                    "500".to_string(),
                    "亲戚、同学".to_string(),
                ],
                vec!["李四".to_string(), "800".to_string(), "同学".to_string()],
            ],
        };
        let existing = [(
            normalize_tag_name("亲戚"),
            TagCatalogEntry {
                id: "tag-relative".to_string(),
                name: "亲戚".to_string(),
                color: "#0f766e".to_string(),
            },
        )]
        .into_iter()
        .collect::<HashMap<_, _>>();

        let analysis = analyze_sheet(&sheet);
        let preview = tag_previews(&sheet, analysis.tag_index, &existing);

        assert_eq!(preview.column_name.as_deref(), Some("标签"));
        assert_eq!(preview.values.len(), 2);
        assert!(preview.values[0].existing);
        assert!(!preview.values[1].existing);
        assert_ne!(preview.values[1].color, "#0f766e");
    }

    #[test]
    fn spreadsheet_picker_accepts_common_excel_variants() {
        let extensions = spreadsheet_extensions();
        assert!(extensions.contains(&"xlsx"));
        assert!(extensions.contains(&"xls"));
        assert!(extensions.contains(&"xlsm"));
        assert!(extensions.contains(&"xlsb"));
        assert!(extensions.contains(&"ods"));
        assert!(extensions.contains(&"csv"));
    }

    #[test]
    fn comparison_picker_accepts_case_insensitive_vault_extensions() {
        assert!(is_giftvault_path(Path::new("ledger.GIFTVAULT")));
        assert!(is_giftvault_path(Path::new("ledger.giftvault")));
        assert!(!is_giftvault_path(Path::new("ledger.xlsx")));
        assert!(is_comparison_spreadsheet(Path::new("ledger.XLSX")));
    }

    #[test]
    fn csv_import_creates_new_tags_and_preserves_optional_fields_in_one_transaction() {
        let csv_path =
            std::env::temp_dir().join(format!("lijin-book-import-{}.csv", Uuid::new_v4()));
        std::fs::write(
            &csv_path,
            "2026 年婚礼礼金导入说明\n来宾,礼金金额,住址,付款方式,登记时间,附言,人物标签,回礼\n张三,500 元,昆明市五华区,微信,2026-08-06 10:30:00,带礼品,亲戚 / 同学,喜糖\n李四,1200.50,昆明市盘龙区,现金,2026-08-06 11:00:00,婚礼祝福,同学、人才,\n",
        )
        .expect("write CSV fixture");
        let sheet =
            parse_sheet(csv_path.to_str().expect("UTF-8 temp path")).expect("parse CSV fixture");
        std::fs::remove_file(&csv_path).expect("remove CSV fixture");

        let analysis = analyze_sheet(&sheet);
        assert!(analysis.errors.is_empty());
        let mut connection = Connection::open_in_memory().expect("memory db");
        migrate(&connection).expect("migration");
        connection
            .execute(
                "INSERT INTO gift_books(id, title, created_at, updated_at) VALUES ('book-1', '婚礼礼金', 'now', 'now')",
                [],
            )
            .expect("book");
        connection
            .execute(
                "INSERT INTO tags(id, name, color, created_at) VALUES ('tag-relative', '亲戚', '#0f766e', 'now')",
                [],
            )
            .expect("existing tag");

        let result = import_sheet_into_book(&mut connection, &sheet, &analysis, "book-1")
            .expect("import spreadsheet");

        assert_eq!(result.imported, 2);
        assert_eq!(
            result
                .created_tags
                .iter()
                .map(|tag| tag.name.as_str())
                .collect::<Vec<_>>(),
            ["同学", "人才"]
        );
        assert!(result.created_tags.iter().all(|tag| tag.color != "#0f766e"));
        assert_ne!(result.created_tags[0].color, result.created_tags[1].color);

        let zhangsan: (i64, String, String, String, String) = connection
            .query_row(
                "SELECT e.amount_fen, e.payment_method, e.note, e.return_gift, e.received_at FROM gift_entries e JOIN people p ON p.id = e.person_id WHERE p.display_name = '张三'",
                [],
                |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?, row.get(3)?, row.get(4)?)),
            )
            .expect("张三 entry");
        assert_eq!(
            zhangsan,
            (
                50_000,
                "微信".to_string(),
                "带礼品".to_string(),
                "喜糖".to_string(),
                "2026-08-06 10:30:00".to_string()
            )
        );
        let people_with_tags: i64 = connection
            .query_row("SELECT COUNT(*) FROM person_tags", [], |row| row.get(0))
            .expect("person tag count");
        assert_eq!(people_with_tags, 4);
        let tag_count: i64 = connection
            .query_row("SELECT COUNT(*) FROM tags", [], |row| row.get(0))
            .expect("tag count");
        assert_eq!(tag_count, 3);
    }

    #[test]
    fn administrator_session_is_global_until_explicitly_locked() {
        let session = SessionState {
            role: SessionRole::Admin,
            failed_attempts: 0,
            locked_until: None,
            edit_locked: true,
        };
        assert!(matches!(session.role, SessionRole::Admin));
        assert!(session.locked_until.is_none());
    }

    #[test]
    fn migration_creates_a_valid_empty_vault() {
        let connection = Connection::open_in_memory().expect("memory db");
        migrate(&connection).expect("migration");
        let format: String = connection
            .query_row(
                "SELECT value FROM vault_meta WHERE key = 'format'",
                [],
                |row| row.get(0),
            )
            .expect("format marker");
        assert_eq!(format, "giftvault");
        let table_count: i64 = connection.query_row("SELECT COUNT(*) FROM sqlite_master WHERE type = 'table' AND name IN ('gift_books', 'people', 'gift_entries')", [], |row| row.get(0)).expect("tables");
        assert_eq!(table_count, 3);
    }

    #[test]
    fn spreadsheet_analysis_rejects_bad_rows() {
        let sheet = ParsedSheet {
            file_name: "test.csv".to_string(),
            sheet_name: "CSV".to_string(),
            header_row: 1,
            headers: vec!["姓名".to_string(), "金额".to_string()],
            rows: vec![
                vec!["张三".to_string(), "500".to_string()],
                vec!["李四".to_string(), "不是金额".to_string()],
            ],
        };
        let analysis = analyze_sheet(&sheet);
        assert_eq!(analysis.valid_rows, 1);
        assert_eq!(analysis.errors.len(), 1);
    }

    #[test]
    fn empty_entry_time_is_local_timestamp_with_seconds() {
        let generated = received_at_or_now("");
        assert_eq!(generated.len(), 19);
        assert!(chrono::NaiveDateTime::parse_from_str(&generated, "%Y-%m-%d %H:%M:%S").is_ok());
        assert_eq!(
            received_at_or_now(" 2026-08-05 12:34:56 "),
            "2026-08-05 12:34:56"
        );
    }

    #[test]
    fn imported_excel_dates_are_normalized_before_storage() {
        assert_eq!(
            normalize_imported_received_at("45292"),
            "2024-01-01 00:00:00"
        );
        assert_eq!(
            normalize_imported_received_at("45292.5"),
            "2024-01-01 12:00:00"
        );
        assert_eq!(
            normalize_imported_received_at("2026/8/7 00:00:03"),
            "2026-08-07 00:00:03"
        );
        assert_eq!(normalize_imported_received_at("原始日期"), "原始日期");
    }

    #[test]
    fn entry_tags_are_attached_to_person() {
        let mut connection = Connection::open_in_memory().expect("memory db");
        migrate(&connection).expect("migration");
        connection
            .execute(
                "INSERT INTO people(id, display_name, created_at, updated_at) VALUES ('person-1', '张三', 'now', 'now')",
                [],
            )
            .expect("person");
        connection
            .execute(
                "INSERT INTO tags(id, name, color, created_at) VALUES ('tag-1', '同学', '#3b82f6', 'now')",
                [],
            )
            .expect("tag");
        let transaction = connection.transaction().expect("transaction");
        apply_entry_tags(&transaction, "person-1", &["tag-1".to_string()]).expect("attach tag");
        transaction.commit().expect("commit");
        let count: i64 = connection
            .query_row(
                "SELECT COUNT(*) FROM person_tags WHERE person_id = 'person-1' AND tag_id = 'tag-1'",
                [],
                |row| row.get(0),
            )
            .expect("count tags");
        assert_eq!(count, 1);
    }

    #[test]
    fn migration_removes_legacy_pin_hashes_without_changing_business_records() {
        let connection = Connection::open_in_memory().expect("memory db");
        migrate(&connection).expect("initial migration");
        connection
            .execute(
                "INSERT INTO gift_books(id, title, created_at, updated_at) VALUES ('book-1', '婚礼礼金', 'now', 'now')",
                [],
            )
            .expect("book");
        connection
            .execute_batch(
                "CREATE TABLE vault_security (
                   id INTEGER PRIMARY KEY CHECK (id = 1),
                   pin_hash TEXT NOT NULL,
                   recovery_hash TEXT NOT NULL,
                   created_at TEXT NOT NULL,
                   updated_at TEXT NOT NULL
                 );
                 INSERT INTO vault_security VALUES (1, 'old-pin-hash', 'old-recovery-hash', 'now', 'now');
                 PRAGMA user_version = 3;",
            )
            .expect("simulate v3 vault");
        migrate(&connection).expect("v3 to current migration");

        let version: i32 = connection
            .pragma_query_value(None, "user_version", |row| row.get(0))
            .expect("schema version");
        let security_table: i64 = connection
            .query_row(
                "SELECT COUNT(*) FROM sqlite_master WHERE type = 'table' AND name = 'vault_security'",
                [],
                |row| row.get(0),
            )
            .expect("security table");
        let preserved_title: String = connection
            .query_row(
                "SELECT title FROM gift_books WHERE id = 'book-1'",
                [],
                |row| row.get(0),
            )
            .expect("preserved book");

        assert_eq!(version, CURRENT_SCHEMA);
        assert_eq!(security_table, 0);
        assert_eq!(preserved_title, "婚礼礼金");
    }

    #[test]
    fn amount_parser_rejects_negative_and_overprecise_values() {
        assert_eq!(parse_amount_fen("-500"), None);
        assert_eq!(parse_amount_fen("500.001"), None);
        assert_eq!(parse_amount_fen("¥30,200.00"), Some(3_020_000));
    }

    #[test]
    fn excel_names_are_cleaned_for_windows_and_worksheet_limits() {
        assert_eq!(safe_excel_file_stem("2026/婚礼:礼金?"), "2026婚礼礼金");
        assert_eq!(safe_worksheet_name("'2026[婚礼]*礼金'"), "2026婚礼礼金");
        assert_eq!(safe_worksheet_name(&"礼".repeat(40)).chars().count(), 31);
    }

    #[test]
    fn global_search_matches_every_supported_gift_field() {
        let entry = GiftEntry {
            id: "entry-1".to_string(),
            book_id: "book-1".to_string(),
            person_id: "person-1".to_string(),
            person_name: "张三".to_string(),
            address: Some("昆明市五华区".to_string()),
            amount_fen: 3_020_000,
            payment_method: "微信".to_string(),
            received_at: "2026-08-06 12:34:56".to_string(),
            note: Some("另有一份礼品".to_string()),
            return_gift: Some("回赠喜糖".to_string()),
            return_gift_amount_fen: Some(50000),
            return_gifted_at: Some("2026-08-07 12:34:56".to_string()),
            tags: vec!["tag-1".to_string()],
            tag_names: vec!["同学".to_string()],
        };
        let cases = [
            ("张三", "姓名"),
            ("微信", "支付方式"),
            ("五华", "地址"),
            ("礼品", "备注"),
            ("喜糖", "回礼"),
            ("2026-08-06", "登记日期"),
            ("2026婚礼", "礼金簿"),
            ("同学", "标签"),
            ("¥30,200.00", "金额"),
        ];

        for (query, expected_field) in cases {
            assert!(
                entry_match_fields(&entry, "2026婚礼礼金", query)
                    .iter()
                    .any(|field| field == expected_field),
                "query {query} should match {expected_field}"
            );
        }
    }

    #[test]
    fn global_search_scope_defaults_to_all_opened_vaults() {
        let root = std::env::temp_dir().join(format!("lijin-search-scope-{}", Uuid::new_v4()));
        std::fs::create_dir_all(&root).expect("scope directory");
        let first = root.join("first.giftvault");
        let second = root.join("second.giftvault");
        std::fs::write(&first, b"").expect("first vault placeholder");
        std::fs::write(&second, b"").expect("second vault placeholder");

        let all = resolve_opened_search_paths(&[], &[first.clone(), second.clone()], &first);
        assert_eq!(all.len(), 2);

        let selected = resolve_opened_search_paths(
            &[second.to_string_lossy().to_string()],
            &[first.clone(), second.clone()],
            &first,
        );
        assert_eq!(selected.len(), 1);
        assert_eq!(comparable_path(&selected[0]), comparable_path(&second));

        let _ = std::fs::remove_dir_all(root);
    }

    #[test]
    fn structured_audit_records_preserve_field_changes() {
        let mut connection = Connection::open_in_memory().expect("memory db");
        migrate(&connection).expect("migration");
        let transaction = connection.transaction().expect("transaction");
        write_audit_detail(
            &transaction,
            "update",
            "gift_entry",
            "entry-1",
            AuditPayload {
                person_id: None,
                target: "张三".to_string(),
                book_title: Some("测试A".to_string()),
                description: "编辑人物信息".to_string(),
                changes: vec![audit_change("回礼备注", "未填写", "喜糖")],
            },
        )
        .expect("write audit");
        transaction.commit().expect("commit audit");

        let raw: String = connection
            .query_row(
                "SELECT payload FROM audit_logs WHERE entity_id = 'entry-1'",
                [],
                |row| row.get(0),
            )
            .expect("stored payload");
        let payload: AuditPayload = serde_json::from_str(&raw).expect("read audit payload");
        assert_eq!(payload.target, "张三");
        assert_eq!(payload.book_title.as_deref(), Some("测试A"));
        assert_eq!(payload.changes[0].field, "回礼备注");
        assert_eq!(payload.changes[0].before, "未填写");
        assert_eq!(payload.changes[0].after, "喜糖");
    }

    #[test]
    fn history_restore_reinstates_a_deleted_person_and_vault_name_without_new_audit_rows() {
        let mut connection = Connection::open_in_memory().expect("memory db");
        migrate(&connection).expect("migration");
        connection
            .execute_batch(
                "INSERT INTO vault_meta(key, value) VALUES ('name', '婚礼');
                 INSERT INTO gift_books(id, title, created_at, updated_at) VALUES ('book-1', '测试礼金簿', 'now', 'now');
                 INSERT INTO people(id, display_name, created_at, updated_at, deleted_at) VALUES ('person-1', '孙丽', 'now', 'now', 'delete-batch');
                 INSERT INTO gift_entries(id, book_id, person_id, amount_fen, payment_method, received_at, created_at, updated_at, deleted_at)
                 VALUES ('entry-1', 'book-1', 'person-1', 10000, '现金', '2026-08-11 12:00:00', 'now', 'now', 'delete-batch');",
            )
            .expect("restore fixtures");

        let transaction = connection.transaction().expect("transaction");
        restore_deleted_audit_entity(&transaction, "person", "person-1").expect("restore person");
        restore_audit_record(
            &transaction,
            "vault",
            "vault-1",
            &AuditPayload {
                person_id: None,
                target: "婚礼".to_string(),
                book_title: None,
                description: "编辑礼金库信息".to_string(),
                changes: vec![audit_change("礼金库名称", "婚礼礼金", "婚礼")],
            },
        )
        .expect("restore vault name");
        transaction.commit().expect("commit restore");

        let deleted_person: Option<String> = connection
            .query_row(
                "SELECT deleted_at FROM people WHERE id = 'person-1'",
                [],
                |row| row.get(0),
            )
            .expect("person state");
        let deleted_entry: Option<String> = connection
            .query_row(
                "SELECT deleted_at FROM gift_entries WHERE id = 'entry-1'",
                [],
                |row| row.get(0),
            )
            .expect("entry state");
        let vault_name: String = connection
            .query_row(
                "SELECT value FROM vault_meta WHERE key = 'name'",
                [],
                |row| row.get(0),
            )
            .expect("vault name");
        let audit_count: i64 = connection
            .query_row("SELECT COUNT(*) FROM audit_logs", [], |row| row.get(0))
            .expect("audit count");

        assert_eq!(deleted_person, None);
        assert_eq!(deleted_entry, None);
        assert_eq!(vault_name, "婚礼礼金");
        assert_eq!(audit_count, 0);
    }

    #[test]
    fn audit_restore_orders_same_second_updates_by_reverse_insertion_order() {
        let mut connection = Connection::open_in_memory().expect("memory db");
        migrate(&connection).expect("migration");
        connection
            .execute(
                "INSERT INTO vault_meta(key, value) VALUES ('name', 'latest')",
                [],
            )
            .expect("current vault name");

        let oldest_payload = serde_json::to_string(&AuditPayload {
            person_id: None,
            target: "vault".to_string(),
            book_title: None,
            description: "rename vault".to_string(),
            changes: vec![audit_change("礼金库名称", "oldest", "middle")],
        })
        .expect("oldest payload");
        let newest_payload = serde_json::to_string(&AuditPayload {
            person_id: None,
            target: "vault".to_string(),
            book_title: None,
            description: "rename vault".to_string(),
            changes: vec![audit_change("礼金库名称", "middle", "latest")],
        })
        .expect("newest payload");
        connection
            .execute(
                "INSERT INTO audit_logs(id, action, entity_type, entity_id, payload, created_at)
                 VALUES (?, 'update', 'vault', 'vault-1', ?, '2026-08-11 12:00:00')",
                params!["audit-oldest", oldest_payload],
            )
            .expect("oldest audit");
        connection
            .execute(
                "INSERT INTO audit_logs(id, action, entity_type, entity_id, payload, created_at)
                 VALUES (?, 'update', 'vault', 'vault-1', ?, '2026-08-11 12:00:00')",
                params!["audit-newest", newest_payload],
            )
            .expect("newest audit");

        let ids = vec!["audit-oldest".to_string(), "audit-newest".to_string()];
        let transaction = connection.transaction().expect("restore transaction");
        let rows = audit_restore_rows(&transaction, &ids).expect("ordered audit rows");
        for (action, entity_type, entity_id, raw_payload) in rows {
            assert_eq!(action, "update");
            let payload: AuditPayload =
                serde_json::from_str(raw_payload.as_deref().expect("reversible audit payload"))
                    .expect("parse audit payload");
            restore_audit_record(&transaction, &entity_type, &entity_id, &payload)
                .expect("restore audit record");
        }
        transaction.commit().expect("commit restore");

        let restored_name: String = connection
            .query_row(
                "SELECT value FROM vault_meta WHERE key = 'name'",
                [],
                |row| row.get(0),
            )
            .expect("restored vault name");
        assert_eq!(restored_name, "oldest");
    }

    #[test]
    fn person_tag_audit_persists_stable_source_context() {
        let mut connection = Connection::open_in_memory().expect("memory db");
        migrate(&connection).expect("migration");
        let transaction = connection.transaction().expect("transaction");
        write_audit_detail_with_context(
            &transaction,
            "update",
            "person",
            "person-1",
            AuditPayload {
                person_id: None,
                target: "二狗".to_string(),
                book_title: Some("测试数据 B".to_string()),
                description: "修改人物标签".to_string(),
                changes: vec![audit_change("人物标签", "兄弟", "52班")],
            },
            Some(AuditContext {
                person_id: "person-1".to_string(),
                vault_id: Some("vault-1".to_string()),
                vault_path: "D:\\测试数据.giftvault".to_string(),
                book_id: Some("book-b".to_string()),
                book_ids: vec!["book-b".to_string()],
                book_titles: vec!["测试数据 B".to_string()],
            }),
        )
        .expect("write contextual audit");
        transaction.commit().expect("commit audit");

        let raw: String = connection
            .query_row(
                "SELECT payload FROM audit_logs WHERE entity_id = 'person-1'",
                [],
                |row| row.get(0),
            )
            .expect("stored payload");
        let payload: serde_json::Value = serde_json::from_str(&raw).expect("read payload");
        assert_eq!(payload["personId"], "person-1");
        assert_eq!(payload["vaultId"], "vault-1");
        assert_eq!(payload["bookId"], "book-b");
        assert_eq!(payload["bookTitles"][0], "测试数据 B");
    }

    #[test]
    fn contiguous_person_tag_audits_merge_into_one_change() {
        let mut connection = Connection::open_in_memory().expect("memory db");
        migrate(&connection).expect("migration");
        let transaction = connection.transaction().expect("transaction");
        for (before, after) in [("兄弟", "未设置"), ("未设置", "52班")] {
            write_audit_detail(
                &transaction,
                "update",
                "person",
                "person-1",
                AuditPayload {
                    person_id: None,
                    target: "二狗".to_string(),
                    book_title: Some("测试数据 B".to_string()),
                    description: "修改人物标签".to_string(),
                    changes: vec![{
                        let mut change = audit_change("人物标签", before, after);
                        change.machine = Some(AuditMachineChange {
                            version: 1,
                            field_id: "tag_ids".to_string(),
                            before: serde_json::json!([before]),
                            after: serde_json::json!([after]),
                        });
                        change
                    }],
                },
            )
            .expect("write tag audit");
        }
        merge_contiguous_person_tag_audit(&transaction, "person-1").expect("merge audits");
        transaction.commit().expect("commit audit");

        let (count, raw): (i64, String) = connection
            .query_row(
                "SELECT COUNT(*), MIN(payload) FROM audit_logs WHERE entity_type = 'person'",
                [],
                |row| Ok((row.get(0)?, row.get(1)?)),
            )
            .expect("merged audit");
        let payload: AuditPayload = serde_json::from_str(&raw).expect("read merged payload");
        assert_eq!(count, 1);
        assert_eq!(payload.changes[0].before, "兄弟");
        assert_eq!(payload.changes[0].after, "52班");
    }

    #[test]
    fn audit_delete_can_target_selected_records_without_touching_other_history() {
        let connection = Connection::open_in_memory().expect("memory db");
        migrate(&connection).expect("migration");
        connection
            .execute_batch(
                "INSERT INTO audit_logs(id, action, entity_type, entity_id, payload, created_at) VALUES
                 ('audit-1', 'update', 'gift_entry', 'entry-1', '{\"target\":\"甲\"}', 'now'),
                 ('audit-2', 'update', 'gift_entry', 'entry-2', '{\"target\":\"乙\"}', 'now'),
                 ('tag-audit', 'create', 'tag', 'tag-1', '{\"target\":\"标签\"}', 'now');",
            )
            .expect("audit fixtures");

        let selected = vec!["audit-1".to_string()];
        assert_eq!(
            delete_audit_logs(&connection, &selected).expect("delete selected"),
            1
        );
        let remaining: Vec<String> = connection
            .prepare("SELECT id FROM audit_logs ORDER BY id")
            .expect("remaining statement")
            .query_map([], |row| row.get(0))
            .expect("remaining rows")
            .collect::<Result<Vec<String>, _>>()
            .expect("remaining ids");
        assert_eq!(remaining, vec!["audit-2", "tag-audit"]);

        assert_eq!(
            delete_audit_logs(&connection, &[]).expect("delete all scoped"),
            1
        );
        let count: i64 = connection
            .query_row("SELECT COUNT(*) FROM audit_logs", [], |row| row.get(0))
            .expect("count remaining history");
        assert_eq!(count, 1);
    }

    #[test]
    fn audit_log_scope_excludes_global_tag_operations() {
        let mut connection = Connection::open_in_memory().expect("memory db");
        migrate(&connection).expect("migration");
        let transaction = connection.transaction().expect("transaction");
        write_audit_detail(
            &transaction,
            "create",
            "tag",
            "tag-1",
            AuditPayload {
                person_id: None,
                target: "test tag".to_string(),
                book_title: None,
                description: "global tag creation".to_string(),
                changes: Vec::new(),
            },
        )
        .expect("ignore global tag audit");
        transaction.commit().expect("commit transaction");

        let audit_count: i64 = connection
            .query_row("SELECT COUNT(*) FROM audit_logs", [], |row| row.get(0))
            .expect("count audit logs");
        assert_eq!(audit_count, 0);
    }

    #[test]
    fn automatic_backup_pruning_keeps_the_ten_newest_snapshots() {
        let directory = std::env::temp_dir().join(format!("lijin-book-backups-{}", Uuid::new_v4()));
        std::fs::create_dir_all(&directory).expect("backup directory");
        for index in 1..=12 {
            std::fs::write(
                directory.join(format!("daily-20260806-0000{index:02}.giftvault")),
                b"test backup",
            )
            .expect("test backup");
        }

        prune_automatic_backups(&directory, None).expect("prune backups");
        let remaining = std::fs::read_dir(&directory)
            .expect("read backup directory")
            .filter_map(Result::ok)
            .count();
        std::fs::remove_dir_all(&directory).expect("remove test backup directory");
        assert_eq!(remaining, 10);
    }

    #[test]
    fn automatic_backup_paths_remain_unique_within_one_millisecond() {
        let directory = std::env::temp_dir().join(format!("lijin-book-backups-{}", Uuid::new_v4()));
        std::fs::create_dir_all(&directory).expect("backup directory");

        let first = automatic_backup_path(&directory, "delete-entry");
        let second = automatic_backup_path(&directory, "delete-entry");

        assert_ne!(first, second);
        assert!(first
            .file_name()
            .is_some_and(|name| name.to_string_lossy().starts_with("delete-entry-")));
        assert!(first
            .extension()
            .is_some_and(|extension| extension == "giftvault"));
        std::fs::remove_dir_all(&directory).expect("remove test backup directory");
    }

    #[test]
    fn read_only_export_copy_preserves_source_schema_and_data() {
        let directory = std::env::temp_dir().join(format!("lijin-book-export-{}", Uuid::new_v4()));
        std::fs::create_dir_all(&directory).expect("export directory");
        let source = directory.join("source.giftvault");
        let destination = directory.join("destination.giftvault");

        {
            let connection = Connection::open(&source).expect("create source vault");
            migrate(&connection).expect("migrate source vault");
            connection
                .execute(
                    "INSERT INTO vault_meta(key, value) VALUES ('name', '只读导出测试')",
                    [],
                )
                .expect("add source data");
            connection
                .execute_batch("PRAGMA user_version = 7;")
                .expect("simulate an older supported vault");
        }

        let source_before = std::fs::read(&source).expect("read source before export");
        copy_vault_read_only(&source, &destination).expect("copy from read-only source");
        let source_after = std::fs::read(&source).expect("read source after export");

        assert_eq!(source_after, source_before);
        let source_connection =
            Connection::open_with_flags(&source, OpenFlags::SQLITE_OPEN_READ_ONLY)
                .expect("open source read-only");
        let source_version: i32 = source_connection
            .pragma_query_value(None, "user_version", |row| row.get(0))
            .expect("source version");
        let destination_connection =
            Connection::open_with_flags(&destination, OpenFlags::SQLITE_OPEN_READ_ONLY)
                .expect("open exported vault read-only");
        let destination_version: i32 = destination_connection
            .pragma_query_value(None, "user_version", |row| row.get(0))
            .expect("destination version");
        let exported_name: String = destination_connection
            .query_row(
                "SELECT value FROM vault_meta WHERE key = 'name'",
                [],
                |row| row.get(0),
            )
            .expect("exported data");

        assert_eq!(source_version, 7);
        assert_eq!(destination_version, 7);
        assert_eq!(exported_name, "只读导出测试");
        validate_vault_file(&destination).expect("validate exported vault");
        drop(destination_connection);
        drop(source_connection);
        std::fs::remove_dir_all(&directory).expect("remove export directory");
    }

    #[test]
    fn moving_vault_validates_the_new_copy_before_removing_the_source() {
        let directory = std::env::temp_dir().join(format!("lijin-book-move-{}", Uuid::new_v4()));
        let source = directory.join("source.giftvault");
        let destination = directory.join("moved").join("destination.giftvault");
        std::fs::create_dir_all(&directory).expect("move test directory");
        std::fs::create_dir_all(destination.parent().expect("move destination directory"))
            .expect("create move destination directory");
        {
            let connection = Connection::open(&source).expect("create source vault");
            migrate(&connection).expect("migrate source vault");
            connection
                .execute(
                    "INSERT INTO vault_meta(key, value) VALUES ('name', '迁移测试')",
                    [],
                )
                .expect("add source metadata");
        }

        move_vault_file(&source, &destination).expect("move validated vault");

        assert!(!source.exists());
        assert!(destination.is_file());
        validate_vault_file(&destination).expect("validate moved vault");
        let connection =
            Connection::open_with_flags(&destination, OpenFlags::SQLITE_OPEN_READ_ONLY)
                .expect("open moved vault");
        let name: String = connection
            .query_row(
                "SELECT value FROM vault_meta WHERE key = 'name'",
                [],
                |row| row.get(0),
            )
            .expect("read moved metadata");
        assert_eq!(name, "迁移测试");
        drop(connection);
        std::fs::remove_dir_all(&directory).expect("remove move test directory");
    }

    #[test]
    fn local_update_selection_only_accepts_a_newer_gift_ledger_installer() {
        let candidates = vec![
            PathBuf::from("礼金簿_0.1.0_x64-setup.exe"),
            PathBuf::from("礼金簿_0.2.0_x64-setup.exe"),
            PathBuf::from("其他程序_9.9.9_x64-setup.exe"),
            PathBuf::from("礼金簿_无效版本_x64-setup.exe"),
        ];

        assert_eq!(
            latest_local_update(&candidates, "0.1.0")
                .expect("newer installer")
                .version,
            "0.2.0"
        );
        assert!(latest_local_update(&candidates, "0.2.0").is_none());

        let current_release_candidates = vec![
            PathBuf::from("礼金簿_0.3.5_x64-setup.exe"),
            PathBuf::from("礼金簿_0.3.6_x64-setup.exe"),
        ];
        assert_eq!(
            latest_local_update(&current_release_candidates, "0.3.5")
                .expect("0.3.6 should update 0.3.5")
                .version,
            "0.3.6"
        );
        assert!(latest_local_update(&current_release_candidates, "0.3.6").is_none());
    }

    #[test]
    fn spreadsheet_import_requires_an_explicit_target_mode() {
        assert!(validate_spreadsheet_target(Some("book-1"), false).is_ok());
        assert!(validate_spreadsheet_target(None, true).is_ok());
        assert!(validate_spreadsheet_target(None, false).is_err());
        assert!(validate_spreadsheet_target(Some("book-1"), true).is_err());
    }
}
