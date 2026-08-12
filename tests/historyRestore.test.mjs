import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

test("history recovery restores delete operations without creating a duplicate audit record", async () => {
  const rust = await readFile(new URL("../src-tauri/src/lib.rs", import.meta.url), "utf8");

  assert.match(rust, /fn restore_deleted_audit_entity\(/);
  assert.match(rust, /"person"\s*=>/);
  assert.match(rust, /"gift_entry"\s*=>/);
  assert.match(rust, /"gift_book"\s*=>/);
  const restoreCommand = rust.slice(rust.indexOf("fn restore_audit_logs"), rust.indexOf("fn clear_audit_logs"));
  assert.match(restoreCommand, /if action == "delete"/);
  assert.match(restoreCommand, /else if action == "restore"/);
  assert.match(restoreCommand, /reverse_restore_audit_entity\(&transaction, &entity_type, &entity_id\)/);
  assert.match(restoreCommand, /DELETE FROM audit_logs WHERE id IN/);
  assert.doesNotMatch(restoreCommand, /write_audit_detail\(/);
});

test("history recovery keeps batch selection actionable and refreshes all affected views", async () => {
  const app = await readFile(new URL("../src/App.tsx", import.meta.url), "utf8");
  const historyView = app.slice(app.indexOf("function HistoryView"), app.indexOf("function formatReturnGiftTime"));

  assert.match(historyView, /const restoreAllowed = selectedCount > 0 && selectedRecords\.every\(isRestorableAuditRecord\)/);
  assert.match(historyView, /await client\.invalidateQueries\(\)/);
  assert.match(historyView, /onNotice\(`恢复成功：\$\{historyTargets\(records\)\}`\)/);
  assert.match(historyView, /onNotice\(`恢复失败：\$\{String\(error\)\.replace/);
  assert.match(historyView, /onVaultUpdated\(await api\.currentVaultInfo\(\)\)/);
  assert.match(historyView, /<th className="audit-time">时间<\/th><th className="audit-object">对象<\/th><th className="audit-vault">礼金库<\/th><th className="audit-book">礼金簿<\/th><th className="audit-action">操作<\/th><th className="audit-detail">变更明细<\/th>/);
});

test("gift-book editing is triggered by a title-adjacent pencil instead of a toolbar text button", async () => {
  const app = await readFile(new URL("../src/App.tsx", import.meta.url), "utf8");
  const heading = app.slice(app.indexOf('<div className="content-heading">'), app.indexOf('<nav className="tab-bar">'));
  const entriesView = app.slice(app.indexOf("function EntriesView"), app.indexOf("type BatchPreviewState"));

  assert.match(heading, /<h2>\{activeBook\.title\}\{canEdit && <button className="icon-button subtle book-title-edit"/);
  assert.match(heading, /title="编辑礼金簿"/);
  assert.doesNotMatch(entriesView, /编辑礼金簿/);
});
