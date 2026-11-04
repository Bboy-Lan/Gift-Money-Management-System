use super::*;
use std::io::Read;

#[derive(Serialize, Deserialize)]
struct Manifest {
    format: u32,
    vaults: Vec<VaultEntry>,
}
#[derive(Serialize, Deserialize)]
struct VaultEntry {
    name: String,
    sha256: String,
}

fn digest(path: &Path) -> Result<String, String> {
    let mut file = std::fs::File::open(path).map_err(|e| e.to_string())?;
    let mut hash = Sha256::new();
    let mut buffer = [0u8; 65536];
    loop {
        let n = file.read(&mut buffer).map_err(|e| e.to_string())?;
        if n == 0 {
            break;
        }
        hash.update(&buffer[..n]);
    }
    Ok(format!("{:x}", hash.finalize()))
}

fn export_to(sources: &[PathBuf], directory: &Path) -> Result<usize, String> {
    if sources.is_empty() || sources.len() > 100 {
        return Err("请选择 1 至 100 个礼金库".into());
    }
    let mut vaults = Vec::new();
    for (index, source) in sources.iter().enumerate() {
        let target = directory.join(format!("vault-{:04}.giftvault", index + 1));
        snapshot_vault(source, &target)?;
        vaults.push(VaultEntry {
            name: source
                .file_name()
                .and_then(|s| s.to_str())
                .unwrap_or("礼金库.giftvault")
                .to_string(),
            sha256: digest(&target)?,
        });
    }
    let bytes =
        serde_json::to_vec_pretty(&Manifest { format: 1, vaults }).map_err(|e| e.to_string())?;
    let mut file = OpenOptions::new()
        .write(true)
        .create_new(true)
        .open(directory.join("manifest.json"))
        .map_err(|e| e.to_string())?;
    use std::io::Write;
    file.write_all(&bytes)
        .and_then(|_| file.sync_all())
        .map_err(|e| e.to_string())?;
    Ok(sources.len())
}

fn import_to(source: &Path, destination: &Path) -> Result<usize, String> {
    let meta = std::fs::metadata(source.join("manifest.json")).map_err(|e| e.to_string())?;
    if meta.len() > 100_000 {
        return Err("迁移清单过大".into());
    }
    let manifest: Manifest = serde_json::from_slice(
        &std::fs::read(source.join("manifest.json")).map_err(|e| e.to_string())?,
    )
    .map_err(|_| "迁移清单无效")?;
    if manifest.format != 1 || manifest.vaults.is_empty() || manifest.vaults.len() > 100 {
        return Err("迁移清单版本或数量无效".into());
    }
    for (index, item) in manifest.vaults.iter().enumerate() {
        let path = source.join(format!("vault-{:04}.giftvault", index + 1));
        if std::fs::symlink_metadata(&path)
            .map_err(|e| e.to_string())?
            .file_type()
            .is_symlink()
            || digest(&path)? != item.sha256
        {
            return Err(format!("第 {} 个礼金库校验失败", index + 1));
        }
        validate_vault_file(&path)?;
    }
    for index in 0..manifest.vaults.len() {
        let name = format!("vault-{:04}.giftvault", index + 1);
        snapshot_vault(&source.join(&name), &destination.join(&name))?;
    }
    Ok(manifest.vaults.len())
}

#[tauri::command(async)]
pub(crate) fn export_migration(state: State<'_, AppState>) -> Result<Option<String>, String> {
    let _operation = begin_operation()?;
    require_admin(&state)?;
    let Some(sources) = FileDialog::new()
        .add_filter("礼金库", &["giftvault"])
        .pick_files()
    else {
        return Ok(None);
    };
    let Some(parent) = FileDialog::new()
        .set_title("选择迁移数据保存位置")
        .pick_folder()
    else {
        return Ok(None);
    };
    let directory = parent.join(format!("礼金簿迁移-{}", Uuid::new_v4()));
    std::fs::create_dir(&directory).map_err(|e| e.to_string())?;
    let count = export_to(&sources, &directory).map_err(|e| {
        format!(
            "导出未完成，原文件未修改；未完成目录 {}：{e}",
            displayable_path(&directory)
        )
    })?;
    Ok(Some(format!(
        "已导出 {count} 个礼金库至 {}",
        displayable_path(&directory)
    )))
}

#[tauri::command(async)]
pub(crate) fn import_migration(state: State<'_, AppState>) -> Result<Option<String>, String> {
    let _operation = begin_operation()?;
    require_admin(&state)?;
    let Some(source) = FileDialog::new()
        .set_title("选择迁移数据文件夹")
        .pick_folder()
    else {
        return Ok(None);
    };
    let Some(parent) = FileDialog::new()
        .set_title("选择导入后礼金库的保存位置")
        .pick_folder()
    else {
        return Ok(None);
    };
    let directory = parent.join(format!("礼金簿导入-{}", Uuid::new_v4()));
    std::fs::create_dir(&directory).map_err(|e| e.to_string())?;
    let count = import_to(&source, &directory).map_err(|e| {
        format!(
            "导入未完成，原有文件未覆盖；未完成目录 {}：{e}",
            displayable_path(&directory)
        )
    })?;
    Ok(Some(format!(
        "已导入 {count} 个礼金库至 {}，请使用打开礼金库选择文件。",
        displayable_path(&directory)
    )))
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn roundtrip_preserves_data_and_rejects_corruption() {
        let root = std::env::temp_dir().join(format!("migration-{}", Uuid::new_v4()));
        std::fs::create_dir_all(root.join("bundle")).unwrap();
        std::fs::create_dir_all(root.join("restore")).unwrap();
        let source = root.join("source.giftvault");
        create_vault_file(&source, "迁移测试", "").unwrap();
        let original = Connection::open(&source).unwrap();
        original.execute("INSERT INTO gift_books(id,title,created_at,updated_at) VALUES ('b','book','now','now')", []).unwrap();
        original.execute("INSERT INTO people(id,display_name,created_at,updated_at) VALUES ('p','person','now','now')", []).unwrap();
        original.execute("INSERT INTO gift_entries(id,book_id,person_id,amount_fen,payment_method,received_at,created_at,updated_at) VALUES ('e','b','p',12345,'cash','2026-10-13','now','now')", []).unwrap();
        original
            .execute(
                "INSERT INTO vault_meta(key,value) VALUES ('migration_test', '保留的数据')",
                [],
            )
            .unwrap();
        drop(original);
        export_to(std::slice::from_ref(&source), &root.join("bundle")).unwrap();
        assert_eq!(
            import_to(&root.join("bundle"), &root.join("restore")).unwrap(),
            1
        );
        validate_vault_file(&root.join("restore/vault-0001.giftvault")).unwrap();
        let restored = Connection::open(root.join("restore/vault-0001.giftvault")).unwrap();
        let value: String = restored
            .query_row(
                "SELECT value FROM vault_meta WHERE key='migration_test'",
                [],
                |row| row.get(0),
            )
            .unwrap();
        assert_eq!(value, "保留的数据");
        let amount: i64 = restored
            .query_row(
                "SELECT amount_fen FROM gift_entries WHERE id='e'",
                [],
                |row| row.get(0),
            )
            .unwrap();
        assert_eq!(amount, 12345);
        drop(restored);
        assert!(import_to(&root.join("bundle"), &root.join("restore")).is_err());
        std::fs::write(root.join("bundle/vault-0001.giftvault"), b"corrupt").unwrap();
        assert!(import_to(&root.join("bundle"), &root.join("restore")).is_err());
        validate_vault_file(&root.join("restore/vault-0001.giftvault")).unwrap();
        std::fs::remove_dir_all(root).unwrap();
    }
}
