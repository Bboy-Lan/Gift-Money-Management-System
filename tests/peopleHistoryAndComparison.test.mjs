import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

test("person edits keep stable source context and tag-only edits are explicit", async () => {
  const rust = await readFile(new URL("../src-tauri/src/lib.rs", import.meta.url), "utf8");
  const app = await readFile(new URL("../src/App.tsx", import.meta.url), "utf8");

  assert.match(rust, /fn set_person_tags\([\s\S]*?AuditContext/);
  assert.match(rust, /fn update_entry\([\s\S]*?AuditContext/);
  assert.match(rust, /book_ids/);
  assert.match(rust, /book_titles/);
  assert.match(app, /onChange=\{\(tagIds\) => setPersonTags\.mutate/);
  const personRow = app.slice(app.lastIndexOf("function PersonRow"), app.indexOf("function HistoryView"));
  assert.doesNotMatch(personRow, /person-tag-remove/);
  assert.match(rust, /WHERE \(\(entity_type IN \('gift_entry', 'return_gift'\)/);
  assert.doesNotMatch(rust, /payload LIKE/);
  assert.match(app, /const restoreAllowed = selectedCount > 0 && selectedRecords\.every\(isRestorableAuditRecord\)/);
  assert.match(app, /disabled=\{!restorableRecords\.length \|\| restoreHistory\.isPending \|\| \(selectedCount > 0 && !restoreAllowed\)\}/);
  assert.match(app, /!selectedCount \? "点击后进入多选，再选择可恢复的改动"/);
});

test("comparison details are source-book bound and keep only source entry tables", async () => {
  const rust = await readFile(new URL("../src-tauri/src/lib.rs", import.meta.url), "utf8");
  const source = await readFile(new URL("../src/CompareView.tsx", import.meta.url), "utf8");
  const types = await readFile(new URL("../src/types.ts", import.meta.url), "utf8");

  assert.match(rust, /fn comparison_person_history\([\s\S]*?book_refs/);
  assert.match(rust, /Some\(&book_id\)/);
  assert.match(source, /comparison-entry-groups/);
  assert.match(source, /first\.vaultName\} \/ \{first\.bookTitle/);
  assert.match(source, /personAddress/);
  assert.match(source, /historyError/);
  assert.doesNotMatch(source, /comparisonSourceDetails/);
  assert.doesNotMatch(source, /comparison-profile-facts/);
  assert.match(types, /interface ComparisonPersonHistory/);
});

test("people panel starts collapsed, stays full width, and duplicate plus controls are removed", async () => {
  const app = await readFile(new URL("../src/App.tsx", import.meta.url), "utf8");
  const styles = await readFile(new URL("../src/styles.css", import.meta.url), "utf8");

  assert.match(app, /const \[tagPanelOpen, setTagPanelOpen\] = useState\(false\)/);
  assert.doesNotMatch(app, /opened-vault-add/);
  assert.match(styles, /\.people-layout,\s*\.people-main,\s*\.people-main \.table-panel/);
});
