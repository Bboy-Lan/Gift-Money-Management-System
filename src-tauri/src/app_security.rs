use argon2::password_hash::{rand_core::OsRng, SaltString};
use argon2::{Argon2, PasswordHash, PasswordHasher, PasswordVerifier};
use chrono::Utc;
use rusqlite::{params, Connection, OptionalExtension};
use std::path::PathBuf;
use uuid::Uuid;

#[derive(Clone)]
pub struct AppSecurityStore {
    path: PathBuf,
}

impl AppSecurityStore {
    pub fn new(path: PathBuf) -> Self {
        Self { path }
    }

    pub fn configured(&self) -> Result<bool, String> {
        let connection = self.open()?;
        connection
            .query_row(
                "SELECT EXISTS(SELECT 1 FROM app_security WHERE id = 1)",
                [],
                |row| row.get(0),
            )
            .map_err(|error| error.to_string())
    }

    pub fn setup_pin(&self, pin: &str) -> Result<String, String> {
        validate_pin(pin)?;
        let connection = self.open()?;
        let exists = self.configured()?;
        if exists {
            return Err("软件管理员 PIN 已设置".to_string());
        }
        let recovery = recovery_code();
        connection
            .execute(
                "INSERT INTO app_security(id, pin_hash, recovery_hash, created_at, updated_at) VALUES (1, ?, ?, ?, ?)",
                params![hash_secret(pin.trim())?, hash_secret(&recovery)?, now(), now()],
            )
            .map_err(|error| error.to_string())?;
        Ok(recovery)
    }

    pub fn verify_pin(&self, pin: &str) -> Result<bool, String> {
        validate_pin(pin)?;
        let connection = self.open()?;
        let stored: Option<String> = connection
            .query_row(
                "SELECT pin_hash FROM app_security WHERE id = 1",
                [],
                |row| row.get(0),
            )
            .optional()
            .map_err(|error| error.to_string())?;
        let hash = stored.ok_or_else(|| "请先设置软件管理员 PIN".to_string())?;
        Ok(verify_secret(pin.trim(), &hash))
    }

    pub fn change_pin(&self, old_pin: &str, new_pin: &str) -> Result<String, String> {
        validate_pin(old_pin)?;
        validate_pin(new_pin)?;
        if !self.verify_pin(old_pin)? {
            return Err("旧管理员 PIN 不正确".to_string());
        }
        let connection = self.open()?;
        let replacement = recovery_code();
        connection
            .execute(
                "UPDATE app_security SET pin_hash = ?, recovery_hash = ?, updated_at = ? WHERE id = 1",
                params![hash_secret(new_pin.trim())?, hash_secret(&replacement)?, now()],
            )
            .map_err(|error| error.to_string())?;
        Ok(replacement)
    }

    pub fn reset_with_recovery(&self, recovery: &str, new_pin: &str) -> Result<String, String> {
        validate_pin(new_pin)?;
        let connection = self.open()?;
        let stored: Option<String> = connection
            .query_row(
                "SELECT recovery_hash FROM app_security WHERE id = 1",
                [],
                |row| row.get(0),
            )
            .optional()
            .map_err(|error| error.to_string())?;
        let stored = stored.ok_or_else(|| "请先设置软件管理员 PIN".to_string())?;
        if !verify_secret(recovery.trim(), &stored) {
            return Err("恢复码不正确".to_string());
        }
        let replacement = recovery_code();
        connection
            .execute(
                "UPDATE app_security SET pin_hash = ?, recovery_hash = ?, updated_at = ? WHERE id = 1",
                params![hash_secret(new_pin.trim())?, hash_secret(&replacement)?, now()],
            )
            .map_err(|error| error.to_string())?;
        Ok(replacement)
    }

    fn open(&self) -> Result<Connection, String> {
        if let Some(parent) = self.path.parent() {
            std::fs::create_dir_all(parent).map_err(|error| error.to_string())?;
        }
        let connection = Connection::open(&self.path).map_err(|error| error.to_string())?;
        connection
            .execute_batch(
                "PRAGMA journal_mode = WAL;
                 PRAGMA busy_timeout = 5000;
                 CREATE TABLE IF NOT EXISTS app_security (
                   id INTEGER PRIMARY KEY CHECK (id = 1),
                   pin_hash TEXT NOT NULL,
                   recovery_hash TEXT NOT NULL,
                   created_at TEXT NOT NULL,
                   updated_at TEXT NOT NULL
                 );",
            )
            .map_err(|error| error.to_string())?;
        Ok(connection)
    }
}

pub fn validate_pin(pin: &str) -> Result<(), String> {
    let pin = pin.trim();
    if !(6..=12).contains(&pin.len()) || !pin.chars().all(|value| value.is_ascii_digit()) {
        return Err("管理员 PIN 必须是 6 至 12 位数字".to_string());
    }
    Ok(())
}

fn hash_secret(secret: &str) -> Result<String, String> {
    let salt = SaltString::generate(&mut OsRng);
    Argon2::default()
        .hash_password(secret.as_bytes(), &salt)
        .map(|value| value.to_string())
        .map_err(|error| format!("无法保护管理员凭据: {error}"))
}

fn verify_secret(secret: &str, encoded_hash: &str) -> bool {
    let Ok(parsed) = PasswordHash::new(encoded_hash) else {
        return false;
    };
    Argon2::default()
        .verify_password(secret.as_bytes(), &parsed)
        .is_ok()
}

fn recovery_code() -> String {
    let value =
        format!("{}{}", Uuid::new_v4().simple(), Uuid::new_v4().simple()).to_ascii_uppercase();
    format!(
        "{}-{}-{}-{}",
        &value[0..6],
        &value[6..12],
        &value[12..18],
        &value[18..24]
    )
}

fn now() -> String {
    Utc::now().to_rfc3339()
}

#[cfg(test)]
mod tests {
    use super::*;

    fn test_store() -> (AppSecurityStore, PathBuf) {
        let path =
            std::env::temp_dir().join(format!("lijin-book-security-{}.sqlite", Uuid::new_v4()));
        (AppSecurityStore::new(path.clone()), path)
    }

    #[test]
    fn global_pin_is_hashed_and_can_be_reset_with_recovery() {
        let (store, path) = test_store();
        assert!(!store.configured().expect("status"));
        let recovery = store.setup_pin("123456").expect("setup");
        assert!(store.configured().expect("configured"));
        assert!(store.verify_pin("123456").expect("verify"));
        assert!(!store.verify_pin("654321").expect("wrong pin"));

        let replacement = store
            .reset_with_recovery(&recovery, "654321")
            .expect("reset");
        assert_ne!(recovery, replacement);
        assert!(store.verify_pin("654321").expect("replacement pin"));
        assert!(!store.verify_pin("123456").expect("old pin"));
        let _ = std::fs::remove_file(path);
    }

    #[test]
    fn pin_format_is_strict() {
        assert!(validate_pin("123456").is_ok());
        assert!(validate_pin("12345").is_err());
        assert!(validate_pin("1234567890123").is_err());
        assert!(validate_pin("abcdef").is_err());
    }

    #[test]
    fn configured_pin_can_be_changed_with_the_old_pin() {
        let (store, path) = test_store();
        let first_recovery = store.setup_pin("123456").expect("setup");
        let replacement = store.change_pin("123456", "654321").expect("change");
        assert_ne!(first_recovery, replacement);
        assert!(store.verify_pin("654321").expect("new pin"));
        assert!(!store.verify_pin("123456").expect("old pin"));
        assert!(store.change_pin("123456", "111111").is_err());
        let _ = std::fs::remove_file(path);
    }
}
