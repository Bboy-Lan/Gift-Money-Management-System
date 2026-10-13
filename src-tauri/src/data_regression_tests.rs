use super::*;

fn database() -> Connection {
    let c = Connection::open_in_memory().unwrap();
    migrate(&c).unwrap();
    c.execute(
        "INSERT INTO gift_books(id,title,created_at,updated_at) VALUES ('b','book','now','now')",
        [],
    )
    .unwrap();
    c.execute("INSERT INTO people(id,display_name,created_at,updated_at) VALUES ('p','person','now','now')", []).unwrap();
    c.execute("INSERT INTO gift_entries(id,book_id,person_id,amount_fen,payment_method,received_at,created_at,updated_at) VALUES ('e','b','p',100,'cash','2026-10-13','now','now')", []).unwrap();
    c
}

#[test]
fn mixed_backup_reasons_keep_newest_ten() {
    let directory = PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .join("target")
        .join(format!("backup-regression-{}", Uuid::new_v4()));
    std::fs::create_dir_all(&directory).unwrap();
    for day in 1..=11 {
        let prefix = if day == 11 { "daily" } else { "restore-entry" };
        std::fs::write(
            directory.join(format!("{prefix}-202610{day:02}-120000-000-id.giftvault")),
            b"fixture",
        )
        .unwrap();
    }
    prune_automatic_backups(&directory, None).unwrap();
    assert!(directory
        .join("daily-20261011-120000-000-id.giftvault")
        .exists());
    assert!(!directory
        .join("restore-entry-20261001-120000-000-id.giftvault")
        .exists());
    std::fs::remove_dir_all(directory).unwrap();
}

#[test]
fn both_import_paths_assign_independent_identity_for_same_name() {
    for batch in [false, true] {
        let mut c = database();
        let sheet = ParsedSheet {
            file_name: "same.csv".into(),
            sheet_name: "CSV".into(),
            header_row: 1,
            headers: vec!["姓名".into(), "金额".into()],
            rows: vec![
                vec!["person".into(), "1".into()],
                vec!["person".into(), "2".into()],
            ],
        };
        let analysis = analyze_sheet(&sheet);
        if batch {
            let mut catalog = load_tag_catalog(&c).unwrap();
            let tx = c.transaction().unwrap();
            import_sheet_into_transaction(&tx, &sheet, &analysis, "b", &mut catalog).unwrap();
            tx.commit().unwrap();
        } else {
            import_sheet_into_book(&mut c, &sheet, &analysis, "b").unwrap();
        }
        let count: i64 = c
            .query_row(
                "SELECT COUNT(DISTINCT person_id) FROM gift_entries",
                [],
                |r| r.get(0),
            )
            .unwrap();
        assert_eq!(count, 3, "batch={batch}");
    }
}

#[test]
fn entry_recovery_rejects_deleted_parent_and_keeps_audit_unchanged() {
    let mut c = database();
    c.execute("UPDATE gift_entries SET deleted_at='gone'", [])
        .unwrap();
    c.execute("UPDATE gift_books SET deleted_at='gone'", [])
        .unwrap();
    assert!(restore_entry_record(&mut c, "e").is_err());
    let deleted: Option<String> = c
        .query_row("SELECT deleted_at FROM gift_entries", [], |r| r.get(0))
        .unwrap();
    assert_eq!(deleted.as_deref(), Some("gone"));
    let count: i64 = c
        .query_row("SELECT COUNT(*) FROM audit_logs", [], |r| r.get(0))
        .unwrap();
    assert_eq!(count, 0);
}

#[test]
fn repeated_entry_restore_rejects_zero_rows_without_audit() {
    let mut c = database();
    assert!(restore_entry_record(&mut c, "e").is_err());
    let count: i64 = c
        .query_row("SELECT COUNT(*) FROM audit_logs", [], |r| r.get(0))
        .unwrap();
    assert_eq!(count, 0);
}

#[test]
fn legacy_real_text_containing_placeholder_is_preserved() {
    let mut c = database();
    let payload: AuditPayload = serde_json::from_value(serde_json::json!({"target":"person","description":"edit","bookTitle":"book","changes":[{"field":"备注","before":"未填写地址的客人","after":"changed"}]})).unwrap();
    let tx = c.transaction().unwrap();
    restore_audit_record(&tx, "gift_entry", "e", &payload).unwrap();
    tx.commit().unwrap();
    let note: Option<String> = c
        .query_row("SELECT note FROM gift_entries", [], |r| r.get(0))
        .unwrap();
    assert_eq!(note.as_deref(), Some("未填写地址的客人"));
}

#[test]
fn vault_info_serializes_camel_case() {
    let value = serde_json::to_value(VaultInfo {
        path: "x".into(),
        name: "n".into(),
        notes: None,
        book_count: 1,
    })
    .unwrap();
    assert_eq!(value["bookCount"], 1);
}

#[test]
fn snapshot_rejects_invalid_source_without_leaving_final_file() {
    let directory = PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .join("target")
        .join(format!("snapshot-regression-{}", Uuid::new_v4()));
    std::fs::create_dir_all(&directory).unwrap();
    let source = directory.join("invalid.giftvault");
    let destination = directory.join("snapshot.giftvault");
    drop(Connection::open(&source).unwrap());
    assert!(snapshot_vault(&source, &destination).is_err());
    assert!(!destination.exists());
    std::fs::remove_dir_all(directory).unwrap();
}

#[test]
fn machine_null_and_real_sentinel_text_survive_json_restore_round_trip() {
    for before in [
        serde_json::Value::Null,
        serde_json::json!("未填写"),
        serde_json::json!("未设置信息"),
    ] {
        let mut c = database();
        let raw = serde_json::json!({"target":"person","description":"edit","bookTitle":"book","changes":[{
            "field":"备注","before":"未填写","after":"changed",
            "machine":{"version":1,"fieldId":"note","before":before,"after":"changed"}
        }]}).to_string();
        let payload: AuditPayload = serde_json::from_str(&raw).unwrap();
        let payload: AuditPayload =
            serde_json::from_str(&serde_json::to_string(&payload).unwrap()).unwrap();
        let tx = c.transaction().unwrap();
        restore_audit_record(&tx, "gift_entry", "e", &payload).unwrap();
        tx.commit().unwrap();
        let note: Option<String> = c
            .query_row("SELECT note FROM gift_entries", [], |r| r.get(0))
            .unwrap();
        assert_eq!(note, before.as_str().map(str::to_string));
    }
}

#[test]
fn machine_tags_restore_ids_even_when_names_contain_separator() {
    let mut c = database();
    c.execute(
        "INSERT INTO tags(id,name,color,created_at) VALUES ('t','未设置、亲戚','#000000','now')",
        [],
    )
    .unwrap();
    let payload: AuditPayload = serde_json::from_value(
        serde_json::json!({"target":"person","description":"edit","changes":[{
            "field":"人物标签","before":"未设置、亲戚","after":"未设置",
            "machine":{"version":1,"fieldId":"tag_ids","before":["t"],"after":[]}
        }]}),
    )
    .unwrap();
    let tx = c.transaction().unwrap();
    restore_audit_record(&tx, "person", "p", &payload).unwrap();
    tx.commit().unwrap();
    let ids: String = c
        .query_row(
            "SELECT tag_id FROM person_tags WHERE person_id='p'",
            [],
            |r| r.get(0),
        )
        .unwrap();
    assert_eq!(ids, "t");
}

#[test]
fn legacy_exact_placeholder_rejects_ambiguous_restore() {
    let mut c = database();
    let payload: AuditPayload = serde_json::from_value(serde_json::json!({"target":"person","description":"edit","changes":[{"field":"备注","before":"未填写","after":"changed"}]})).unwrap();
    let tx = c.transaction().unwrap();
    assert!(restore_audit_record(&tx, "gift_entry", "e", &payload).is_err());
}

#[test]
fn import_preview_flags_unknown_dates_and_out_of_range_money() {
    let sheet = ParsedSheet {
        file_name: "bounds.csv".into(),
        sheet_name: "CSV".into(),
        header_row: 1,
        headers: vec!["姓名".into(), "金额".into(), "登记日期".into()],
        rows: vec![
            vec!["person".into(), "1".into(), "not a date".into()],
            vec![
                "person".into(),
                "90071992547409.92".into(),
                "2026-10-13".into(),
            ],
        ],
    };
    let analysis = analyze_sheet(&sheet);
    assert_eq!(analysis.valid_rows, 0);
    assert_eq!(analysis.invalid_rows, vec![0, 1]);
}

#[test]
fn huge_legacy_amount_read_errors_instead_of_rounding_in_javascript() {
    let c = database();
    c.execute("UPDATE gift_entries SET amount_fen=9007199254740992", [])
        .unwrap();
    assert!(load_entries(&c, Some("b")).is_err());
}

fn edit_input() -> UpdateEntryInput {
    UpdateEntryInput {
        entry_id: "e".into(),
        person_name: "person".into(),
        address: String::new(),
        amount_fen: 100,
        payment_method: "cash".into(),
        received_at: "2026-10-13".into(),
        note: String::new(),
        return_gift: String::new(),
        return_gift_amount_fen: None,
        tag_ids: Vec::new(),
    }
}

#[test]
fn editing_replaces_tags_with_audited_full_set_and_can_restore() {
    let mut c = database();
    c.execute(
        "INSERT INTO tags(id,name,color,created_at) VALUES ('t','亲戚、家人','#000000','now')",
        [],
    )
    .unwrap();
    c.execute(
        "INSERT INTO person_tags(person_id,tag_id) VALUES ('p','t')",
        [],
    )
    .unwrap();
    update_entry_record(edit_input(), &mut c, "fixture").unwrap();
    let tags = active_person_tag_ids(&c, "p").unwrap();
    assert!(tags.is_empty());
    let raw: String = c
        .query_row(
            "SELECT payload FROM audit_logs ORDER BY rowid DESC LIMIT 1",
            [],
            |r| r.get(0),
        )
        .unwrap();
    let payload = serde_json::from_str::<AuditPayload>(&raw).unwrap();
    let tx = c.transaction().unwrap();
    restore_audit_record(&tx, "gift_entry", "e", &payload).unwrap();
    tx.commit().unwrap();
    assert_eq!(active_person_tag_ids(&c, "p").unwrap(), vec!["t"]);
}

#[test]
fn editing_existing_return_gift_keeps_absent_original_timestamp() {
    let mut c = database();
    c.execute(
        "UPDATE gift_entries SET return_gift_amount_fen=200,return_gifted_at=NULL",
        [],
    )
    .unwrap();
    let mut input = edit_input();
    input.return_gift_amount_fen = Some(300);
    update_entry_record(input, &mut c, "fixture").unwrap();
    let date: Option<String> = c
        .query_row("SELECT return_gifted_at FROM gift_entries", [], |r| {
            r.get(0)
        })
        .unwrap();
    assert_eq!(date, None);
}

#[test]
fn editing_invalid_date_or_huge_amount_rejects_before_mutation() {
    for date in [false, true] {
        let mut c = database();
        let mut input = edit_input();
        if date {
            input.received_at = "impossible".into();
        } else {
            input.amount_fen = MAX_SAFE_FEN + 1;
        }
        assert!(update_entry_record(input, &mut c, "fixture").is_err());
        let amount: i64 = c
            .query_row("SELECT amount_fen FROM gift_entries", [], |r| r.get(0))
            .unwrap();
        assert_eq!(amount, 100);
    }
}

#[test]
fn history_parent_recovery_rejects_deleted_book_without_phantom_entry() {
    let mut c = database();
    c.execute("UPDATE gift_entries SET deleted_at='gone'", [])
        .unwrap();
    c.execute("UPDATE gift_books SET deleted_at='gone'", [])
        .unwrap();
    let tx = c.transaction().unwrap();
    assert!(restore_deleted_audit_entity(&tx, "gift_entry", "e").is_err());
}

#[test]
fn reading_history_never_erases_temporarily_nonreversible_records() {
    let c = database();
    c.execute("INSERT INTO audit_logs(id,action,entity_type,entity_id,payload,created_at) VALUES ('a','update','gift_entry','e','{\"target\":\"person\",\"description\":\"edit\",\"changes\":[]}','now')",[]).unwrap();
    let logs = list_audit_logs_from_connection(&c).unwrap();
    assert_eq!(logs.len(), 1);
    assert!(!logs[0].reversible);
    let count: i64 = c
        .query_row("SELECT COUNT(*) FROM audit_logs", [], |r| r.get(0))
        .unwrap();
    assert_eq!(count, 1);
}

#[test]
fn invalid_tag_edit_rolls_back_person_and_entry() {
    let mut c = database();
    let mut input = edit_input();
    input.person_name = "renamed".into();
    input.tag_ids = vec!["missing".into()];
    assert!(update_entry_record(input, &mut c, "fixture").is_err());
    let count: i64 = c
        .query_row("SELECT COUNT(*) FROM people", [], |r| r.get(0))
        .unwrap();
    assert_eq!(count, 1);
    let person: String = c
        .query_row("SELECT person_id FROM gift_entries", [], |r| r.get(0))
        .unwrap();
    assert_eq!(person, "p");
}

#[test]
fn renamed_entry_restore_relinks_original_identity_without_mutating_shared_person() {
    let mut c = database();
    c.execute("INSERT INTO gift_entries(id,book_id,person_id,amount_fen,payment_method,received_at,created_at,updated_at) VALUES ('e2','b','p',100,'cash','2026-10-13','now','now')",[]).unwrap();
    let mut input = edit_input();
    input.person_name = "renamed".into();
    input.address = "new address".into();
    update_entry_record(input, &mut c, "fixture").unwrap();
    let raw: String = c
        .query_row(
            "SELECT payload FROM audit_logs ORDER BY rowid DESC LIMIT 1",
            [],
            |r| r.get(0),
        )
        .unwrap();
    let payload: AuditPayload = serde_json::from_str(&raw).unwrap();
    let tx = c.transaction().unwrap();
    restore_audit_record(&tx, "gift_entry", "e", &payload).unwrap();
    tx.commit().unwrap();
    let person: String = c
        .query_row("SELECT person_id FROM gift_entries WHERE id='e'", [], |r| {
            r.get(0)
        })
        .unwrap();
    assert_eq!(person, "p");
    let original: String = c
        .query_row("SELECT display_name FROM people WHERE id='p'", [], |r| {
            r.get(0)
        })
        .unwrap();
    assert_eq!(original, "person");
}

struct TempDirectory(PathBuf);
impl TempDirectory {
    fn new() -> Self {
        let path = PathBuf::from(env!("CARGO_MANIFEST_DIR"))
            .join("target")
            .join(format!("data-regression-{}", Uuid::new_v4()));
        std::fs::create_dir_all(&path).unwrap();
        Self(path)
    }
}
impl Drop for TempDirectory {
    fn drop(&mut self) {
        let _ = std::fs::remove_dir_all(&self.0);
    }
}

#[test]
fn publication_failure_never_leaves_final_or_removes_other_creators_file() {
    let dir = TempDirectory::new();
    let path = dir.0.join("new.giftvault");
    assert!(publish_vault_file(&path, |temporary| {
        drop(Connection::open(temporary).unwrap());
        Err("injected before migration".into())
    })
    .is_err());
    assert!(!path.exists());
    assert!(publish_vault_file(&path, |temporary| {
        let c = Connection::open(temporary).unwrap();
        migrate(&c).unwrap();
        drop(c);
        std::fs::write(&path, b"another creator won").unwrap();
        Ok(())
    })
    .is_err());
    assert_eq!(std::fs::read(&path).unwrap(), b"another creator won");
    assert_eq!(std::fs::read_dir(&dir.0).unwrap().count(), 1);
}

#[test]
fn two_concurrent_vault_creators_publish_one_valid_winner() {
    let dir = TempDirectory::new();
    let path = dir.0.join("new.giftvault");
    let a = path.clone();
    let b = path.clone();
    let first = std::thread::spawn(move || create_vault_file(&a, "first", ""));
    let second = std::thread::spawn(move || create_vault_file(&b, "second", ""));
    let outcomes = [first.join().unwrap(), second.join().unwrap()];
    assert_eq!(outcomes.iter().filter(|result| result.is_ok()).count(), 1);
    validate_vault_file(&path).unwrap();
    assert_eq!(std::fs::read_dir(&dir.0).unwrap().count(), 1);
}

#[test]
fn trash_success_releases_sqlite_handle_and_restorable_manifest_precedes_removal() {
    let dir = TempDirectory::new();
    let source = dir.0.join("source.giftvault");
    let trash = dir.0.join("trash");
    create_vault_file(&source, "fixture", "").unwrap();
    trash_vault_into_directory(&source, &trash, &Uuid::new_v4().to_string()).unwrap();
    assert!(!source.exists());
    let manifests = read_vault_trash_directory(&trash).unwrap();
    assert_eq!(manifests.len(), 1);
    assert_eq!(manifests[0].original_path, displayable_path(&source));
    validate_vault_file(Path::new(&manifests[0].trash_path)).unwrap();
}

#[test]
fn manifest_write_failure_keeps_source_and_discoverable_snapshot() {
    let dir = TempDirectory::new();
    let source = dir.0.join("source.giftvault");
    let trash = dir.0.join("trash");
    create_vault_file(&source, "fixture", "").unwrap();
    std::fs::create_dir_all(&trash).unwrap();
    let id = Uuid::new_v4().to_string();
    std::fs::create_dir(trash.join(format!("{id}.json"))).unwrap();
    assert!(trash_vault_into_directory(&source, &trash, &id).is_err());
    validate_vault_file(&source).unwrap();
    let manifests = read_vault_trash_directory(&trash).unwrap();
    assert_eq!(manifests.len(), 1);
    assert!(manifests[0].original_path.is_empty());
    validate_vault_file(Path::new(&manifests[0].trash_path)).unwrap();
}

#[cfg(windows)]
#[test]
fn windows_locked_source_removal_keeps_recoverable_manifest_and_snapshot() {
    let dir = TempDirectory::new();
    let source = dir.0.join("source.giftvault");
    let trash = dir.0.join("trash");
    create_vault_file(&source, "fixture", "").unwrap();
    let held = Connection::open_with_flags(&source, OpenFlags::SQLITE_OPEN_READ_ONLY).unwrap();
    assert!(trash_vault_into_directory(&source, &trash, &Uuid::new_v4().to_string()).is_err());
    drop(held);
    assert!(source.exists());
    let manifests = read_vault_trash_directory(&trash).unwrap();
    assert_eq!(manifests.len(), 1);
    validate_vault_file(Path::new(&manifests[0].trash_path)).unwrap();
}

#[test]
fn partial_manifest_never_hides_the_only_surviving_snapshot() {
    let dir = TempDirectory::new();
    let id = Uuid::new_v4().to_string();
    let snapshot = dir.0.join(format!("{id}.giftvault"));
    create_vault_file(&snapshot, "fixture", "").unwrap();
    std::fs::write(dir.0.join(format!("{id}.json")), b"{partial").unwrap();
    let manifests = read_vault_trash_directory(&dir.0).unwrap();
    assert_eq!(manifests.len(), 1);
    assert_eq!(manifests[0].id, id);
}

#[test]
fn legacy_date_and_unchanged_long_text_survive_unrelated_amount_edit() {
    let mut c = database();
    let note = format!("  {}  ", "x".repeat(65537));
    c.execute(
        "UPDATE gift_entries SET received_at='历史待核对日期',note=?",
        params![note],
    )
    .unwrap();
    let mut input = edit_input();
    input.received_at = "历史待核对日期".into();
    input.note = note.clone();
    input.amount_fen = 200;
    update_entry_record(input, &mut c, "fixture").unwrap();
    let stored: (String, String, i64) = c
        .query_row(
            "SELECT received_at,note,amount_fen FROM gift_entries",
            [],
            |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?)),
        )
        .unwrap();
    assert_eq!(stored, ("历史待核对日期".to_string(), note, 200));
}

#[test]
fn aggregate_boundary_rejects_collection_before_unsafe_client_sum() {
    let c = database();
    c.execute(
        "UPDATE gift_entries SET amount_fen=?",
        params![MAX_SAFE_FEN],
    )
    .unwrap();
    c.execute("INSERT INTO gift_entries(id,book_id,person_id,amount_fen,payment_method,received_at,created_at,updated_at) VALUES ('e2','b','p',1,'cash','2026-10-13','now','now')",[]).unwrap();
    assert!(load_entries(&c, Some("b")).is_err());
    assert!(ensure_money_totals_safe(&c).is_err());
}

#[test]
fn exact_close_keeps_other_opened_vault_and_clears_last_active() {
    let dir = TempDirectory::new();
    let first = dir.0.join("first.giftvault");
    let second = dir.0.join("second.giftvault");
    create_vault_file(&first, "first", "").unwrap();
    create_vault_file(&second, "second", "").unwrap();
    let state = AppState {
        vault_path: Mutex::new(Some(first.clone())),
        opened_vault_paths: Mutex::new(vec![
            first.canonicalize().unwrap(),
            second.canonicalize().unwrap(),
        ]),
        security: AppSecurityStore::new(dir.0.join("test-security.json")),
        session: Mutex::new(SessionState::default()),
    };
    let captured = canonical_opened_vault_path(&state, Some(first.to_str().unwrap())).unwrap();
    *state.vault_path.lock().unwrap() = Some(second.clone());
    assert_eq!(captured, first.canonicalize().unwrap());
    assert_eq!(
        canonical_opened_vault_path(&state, Some(first.to_str().unwrap())).unwrap(),
        captured
    );
    close_opened_vault_path(&state, &first).unwrap();
    assert!(canonical_opened_vault_path(&state, Some(first.to_str().unwrap())).is_err());
    assert_eq!(state.opened_vault_paths.lock().unwrap().len(), 1);
    assert_eq!(state.vault_path.lock().unwrap().as_ref(), Some(&second));
    close_opened_vault_path(&state, &second).unwrap();
    assert!(state.vault_path.lock().unwrap().is_none());
    assert!(state.opened_vault_paths.lock().unwrap().is_empty());
}

#[test]
fn history_marks_ambiguous_legacy_payload_nonreversible_without_deleting_it() {
    let c = database();
    let payload=serde_json::json!({"target":"person","description":"edit","changes":[{"field":"备注","before":"未填写","after":"changed"}]}).to_string();
    c.execute("INSERT INTO audit_logs(id,action,entity_type,entity_id,payload,created_at) VALUES ('a','update','gift_entry','e',?,'now')",params![payload]).unwrap();
    let logs = list_audit_logs_from_connection(&c).unwrap();
    assert_eq!(logs.len(), 1);
    assert!(!logs[0].reversible);
    assert!(logs[0].reversible_reason.is_some());
}

#[test]
fn legacy_tag_separator_rejects_ambiguous_composite_name() {
    let mut c = database();
    c.execute("INSERT INTO tags(id,name,color,created_at) VALUES ('full','亲戚、家人','#000000','now'),('one','亲戚','#000000','now'),('two','家人','#000000','now')",[]).unwrap();
    let payload:AuditPayload=serde_json::from_value(serde_json::json!({"target":"person","description":"edit","changes":[{"field":"人物标签","before":"亲戚、家人","after":"changed"}]})).unwrap();
    let tx = c.transaction().unwrap();
    assert!(restore_audit_record(&tx, "person", "p", &payload).is_err());
}

#[test]
fn machine_book_null_and_placeholder_text_restore_original_values() {
    for (field, value) in [
        ("event_date", serde_json::Value::Null),
        ("location", serde_json::json!("未设置")),
        ("notes", serde_json::json!("未填写")),
    ] {
        let mut c = database();
        let payload:AuditPayload=serde_json::from_value(serde_json::json!({"target":"book","description":"edit","changes":[{"field":"任意显示标题","before":"label","after":"new","machine":{"version":1,"fieldId":field,"before":value,"after":"new"}}]})).unwrap();
        let tx = c.transaction().unwrap();
        restore_audit_record(&tx, "gift_book", "b", &payload).unwrap();
        tx.commit().unwrap();
        let stored: Option<String> = c
            .query_row(
                &format!("SELECT {field} FROM gift_books WHERE id='b'"),
                [],
                |r| r.get(0),
            )
            .unwrap();
        assert_eq!(stored, value.as_str().map(str::to_string));
    }
}

#[test]
fn return_gift_list_can_read_legacy_missing_timestamp_without_inventing_one() {
    let c = database();
    c.execute(
        "UPDATE gift_entries SET return_gift_amount_fen=100,return_gifted_at=NULL",
        [],
    )
    .unwrap();
    let records = list_return_gifts_from_connection(&c).unwrap();
    assert_eq!(records.len(), 1);
    assert!(records[0].return_gifted_at.is_empty());
}

fn vault_files_under(directory: &Path) -> Vec<PathBuf> {
    let mut files = Vec::new();
    for entry in std::fs::read_dir(directory).unwrap() {
        let path = entry.unwrap().path();
        if path.is_dir() {
            files.extend(vault_files_under(&path));
        } else if path
            .extension()
            .is_some_and(|extension| extension == "giftvault")
        {
            files.push(path);
        }
    }
    files
}

#[test]
fn copied_vaults_with_same_id_each_get_their_first_daily_snapshot() {
    let dir = TempDirectory::new();
    let first = dir.0.join("first.giftvault");
    let second = dir.0.join("second.giftvault");
    let root = dir.0.join("backups");
    create_vault_file(&first, "first", "").unwrap();
    snapshot_vault(&first, &second).unwrap();
    let first_id = Connection::open(&first)
        .unwrap()
        .query_row(
            "SELECT value FROM vault_meta WHERE key='vault_id'",
            [],
            |r| r.get::<_, String>(0),
        )
        .unwrap();
    {
        let c = Connection::open(&second).unwrap();
        c.execute("UPDATE vault_meta SET value='second' WHERE key='name'", [])
            .unwrap();
        assert_eq!(
            c.query_row(
                "SELECT value FROM vault_meta WHERE key='vault_id'",
                [],
                |r| r.get::<_, String>(0)
            )
            .unwrap(),
            first_id
        );
    }
    auto_backup_in_root(&first, &root, "edit", false).unwrap();
    auto_backup_in_root(&second, &root, "edit", false).unwrap();
    let files = vault_files_under(&root);
    assert_eq!(files.len(), 2);
    let mut names = files
        .iter()
        .map(|path| {
            Connection::open_with_flags(
                path.canonicalize().unwrap(),
                OpenFlags::SQLITE_OPEN_READ_ONLY,
            )
            .unwrap()
            .query_row("SELECT value FROM vault_meta WHERE key='name'", [], |r| {
                r.get::<_, String>(0)
            })
            .unwrap()
        })
        .collect::<Vec<_>>();
    names.sort();
    assert_eq!(names, vec!["first", "second"]);
}

#[test]
fn manual_backups_do_not_participate_in_automatic_rotation() {
    let dir = TempDirectory::new();
    for day in 1..=11 {
        std::fs::write(
            dir.0
                .join(format!("daily-202610{day:02}-120000-000-id.giftvault")),
            b"fixture",
        )
        .unwrap();
    }
    let manual = dir.0.join("manual-20261001-120000-000-id.giftvault");
    std::fs::write(&manual, b"manual").unwrap();
    prune_automatic_backups(&dir.0, None).unwrap();
    assert!(manual.exists());
    assert_eq!(std::fs::read_dir(&dir.0).unwrap().count(), 11);
}

#[test]
fn family_rotation_includes_known_source_groups_and_legacy_files_only() {
    let dir = TempDirectory::new();
    let source = dir.0.join("source.giftvault");
    create_vault_file(&source, "fixture", "").unwrap();
    let family = dir.0.join("family");
    let first = family.join("a".repeat(64));
    let moved = family.join("b".repeat(64));
    std::fs::create_dir_all(&first).unwrap();
    std::fs::create_dir_all(&moved).unwrap();
    for day in 1..=11 {
        let group = if day <= 6 { &first } else { &moved };
        snapshot_vault(
            &source,
            &group.join(format!(
                "restore-entry-202610{day:02}-120000-000-id.giftvault"
            )),
        )
        .unwrap();
    }
    let legacy = family.join("daily-20261012-120000-000-id.giftvault");
    snapshot_vault(&source, &legacy).unwrap();
    let newest = moved.join("daily-20261013-120000-000-id.giftvault");
    snapshot_vault(&source, &newest).unwrap();
    let manual = family.join("manual-20261001-120000-000-id.giftvault");
    snapshot_vault(&source, &manual).unwrap();
    let unknown = family.join("unknown-source");
    std::fs::create_dir_all(&unknown).unwrap();
    let unknown_file = unknown.join("daily-20261001-120000-000-id.giftvault");
    snapshot_vault(&source, &unknown_file).unwrap();
    prune_automatic_backups(&family, None).unwrap();
    assert_eq!(vault_files_under(&family).len(), 12);
    assert!(newest.exists());
    assert!(manual.exists());
    assert!(unknown_file.exists());
    assert!(!first
        .join("restore-entry-20261001-120000-000-id.giftvault")
        .exists());
}

#[test]
fn external_vault_id_cannot_escape_backup_root() {
    let dir = TempDirectory::new();
    let source = dir.0.join("source.giftvault");
    create_vault_file(&source, "fixture", "").unwrap();
    {
        let c = Connection::open(&source).unwrap();
        c.execute(
            "UPDATE vault_meta SET value='../escape' WHERE key='vault_id'",
            [],
        )
        .unwrap();
    }
    assert!(auto_backup_in_root(&source, &dir.0.join("backups"), "edit", false).is_err());
    assert!(!dir.0.join("escape").exists());
    assert!(!dir.0.join("backups").exists());
    validate_vault_file(&source).unwrap();
}

#[test]
fn orphan_snapshot_selects_save_as_and_restores_without_overwriting() {
    let dir = TempDirectory::new();
    let id = Uuid::new_v4().to_string();
    let snapshot = dir.0.join(format!("{id}.giftvault"));
    create_vault_file(&snapshot, "orphan", "").unwrap();
    std::fs::write(dir.0.join(format!("{id}.json")), b"{partial").unwrap();
    let manifest = read_vault_trash_directory(&dir.0).unwrap().remove(0);
    assert!(vault_restore_original_destination(&manifest)
        .unwrap()
        .is_none());
    let destination = dir.0.join("restored.giftvault");
    create_vault_file(&destination, "other", "").unwrap();
    assert!(restore_vault_snapshot_to(&snapshot, &destination).is_err());
    assert!(snapshot.exists());
    let destination = dir.0.join("restored-new.giftvault");
    restore_vault_snapshot_to(&snapshot, &destination).unwrap();
    assert!(!snapshot.exists());
    validate_vault_file(&destination).unwrap();
}

#[test]
fn newly_created_snapshot_is_retained_even_if_older_files_have_future_timestamps() {
    let dir = TempDirectory::new();
    let first = dir.0.join("first.giftvault");
    let second = dir.0.join("second.giftvault");
    let root = dir.0.join("backups");
    create_vault_file(&first, "first", "").unwrap();
    snapshot_vault(&first, &second).unwrap();
    let id = Connection::open(&first)
        .unwrap()
        .query_row(
            "SELECT value FROM vault_meta WHERE key='vault_id'",
            [],
            |r| r.get::<_, String>(0),
        )
        .unwrap();
    {
        let c = Connection::open(&second).unwrap();
        c.execute("UPDATE vault_meta SET value='second' WHERE key='name'", [])
            .unwrap();
    }
    let group = root.join(id).join(format!(
        "{:x}",
        Sha256::digest(comparable_path(&first.canonicalize().unwrap()).as_bytes())
    ));
    std::fs::create_dir_all(&group).unwrap();
    for day in 21..=30 {
        snapshot_vault(
            &first,
            &group.join(format!(
                "restore-entry-209912{day:02}-120000-000-id.giftvault"
            )),
        )
        .unwrap();
    }
    auto_backup_in_root(&second, &root, "edit", false).unwrap();
    let files = vault_files_under(&root);
    assert_eq!(files.len(), 10);
    assert!(files.iter().any(|path| Connection::open_with_flags(
        path.canonicalize().unwrap(),
        OpenFlags::SQLITE_OPEN_READ_ONLY
    )
    .unwrap()
    .query_row("SELECT value FROM vault_meta WHERE key='name'", [], |r| {
        r.get::<_, String>(0)
    })
    .unwrap()
        == "second"));
}

#[test]
fn non_uuid_vault_id_cannot_claim_reserved_backup_family() {
    let dir = TempDirectory::new();
    let source = dir.0.join("source.giftvault");
    create_vault_file(&source, "fixture", "").unwrap();
    {
        let c = Connection::open(&source).unwrap();
        c.execute(
            "UPDATE vault_meta SET value='migration' WHERE key='vault_id'",
            [],
        )
        .unwrap();
    }
    assert!(auto_backup_in_root(&source, &dir.0.join("backups"), "edit", false).is_err());
    assert!(!dir.0.join("backups").exists());
}
