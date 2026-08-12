import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

test("comparison overview selects exact gift books and queries only that exact scope", async () => {
  const source = await readFile(new URL("../src/CompareView.tsx", import.meta.url), "utf8");
  const styles = await readFile(new URL("../src/styles.css", import.meta.url), "utf8");

  assert.match(source, /className="comparison-book-list"/);
  assert.match(source, /selectedBookRefs/);
  assert.match(source, /comparisonBookKey/);
  assert.match(source, /className=\{`comparison-book-item \$\{selected \? "selected" : ""\}`\}/);
  assert.match(source, /api\.searchComparisonBookPeople\(selectedBookRefs, debouncedPersonQuery\)/);
  assert.match(source, /api\.searchComparisonDuplicateBookPeople\(selectedBookRefs\)/);
  assert.match(source, /disabled=\{selectedBookRefs\.length < 1\}/);
  assert.match(source, /enabled: duplicateSearchRequested && selectedBookRefs\.length > 0/);
  assert.match(source, /找到 \$\{comparisonPeople\.length\} 位/);
  assert.match(source, /api\.comparisonPersonHistory\([\s\S]*?selectedBookRefs\)/);
  assert.match(source, /client\.removeQueries\(\{ queryKey: \["comparison-book-people"\] \}\)/);
  assert.match(source, /readComparisonBookSelection/);
  assert.match(source, /rememberComparisonBookSelection/);
  assert.match(source, /const scopeChanged = selectionScope\.current !== scope/);
  assert.match(source, /搜索同名人物/);
  assert.doesNotMatch(source, /跨簿人物档案/);
  assert.doesNotMatch(source, /api\.comparisonBookEntries/);
  assert.doesNotMatch(source, /comparison-book-detail/);
  assert.doesNotMatch(source, /comparison-book-link/);
  assert.match(source, /function ComparisonEntryGroups/);
  assert.match(source, /sourceEntryKey\(entry\)/);
  assert.match(source, /first\.vaultName\} \/ \{first\.bookTitle/);
  assert.match(source, /<th>姓名<\/th><th>金额<\/th><th>支付方式<\/th>/);
  assert.doesNotMatch(source, /function comparisonSourceDetails/);
  assert.doesNotMatch(source, /comparison-profile-facts/);
  assert.doesNotMatch(source, /comparison-identity-details/);
  assert.doesNotMatch(styles, /comparison-identity-detail \{/);
  assert.match(source, /historyError \? <span className="field-hint">人物明细读取失败/);
  assert.match(source, /comparison-source-summary/);
  assert.doesNotMatch(source, /member\.vaultName/);
});

test("comparison history skips stale references without widening the selected-book scope", async () => {
  const rust = await readFile(new URL("../src-tauri/src/lib.rs", import.meta.url), "utf8");
  const command = rust.slice(rust.indexOf("fn comparison_person_history("), rust.indexOf("pub fn run()"));

  assert.match(command, /let mut books_by_vault = HashMap::<PathBuf, Vec<String>>::new\(\)/);
  assert.match(command, /SELECT EXISTS\(SELECT 1 FROM gift_books WHERE id = \? AND deleted_at IS NULL\)/);
  assert.match(command, /let Some\(book_ids\) = books_by_vault\.get\(&path\) else/);
  assert.match(command, /Some\(book_id\)/);
  assert.doesNotMatch(command, /None\s*\)\s*\{/);
});

test("gift detail rows render at most two tags without changing entry data", async () => {
  const source = await readFile(new URL("../src/App.tsx", import.meta.url), "utf8");

  assert.match(source, /entryTags\.slice\(0, 2\)\.map/);
});

test("comparison book cards use a responsive grid and a wider search field", async () => {
  const styles = await readFile(new URL("../src/styles.css", import.meta.url), "utf8");

  assert.match(styles, /\.comparison-book-list \{ display: grid; grid-template-columns: repeat\(auto-fit, minmax\(180px, 1fr\)\)/);
  assert.match(styles, /\.comparison-person-search \{[^}]*width: min\(560px, calc\(100% - 34px\)\)[^}]*margin: 14px 17px 12px/);
});

test("workspace breadcrumb prefers the currently opened gift book title", async () => {
  const source = await readFile(new URL("../src/App.tsx", import.meta.url), "utf8");

  assert.match(source, /<span className="vault-label">\{activeBook\?\.title \?\? vault\.name\}<\/span>/);
  assert.doesNotMatch(source, /person\.vaultName/);
});

test("comparison removal uses one toolbar control and keeps source cards read-only", async () => {
  const source = await readFile(new URL("../src/CompareView.tsx", import.meta.url), "utf8");
  const workspace = await readFile(new URL("../src/App.tsx", import.meta.url), "utf8");

  assert.match(source, /readHiddenComparisonBooks/);
  assert.match(source, /rememberHiddenComparisonBooks/);
  assert.match(source, /const visibleBooks/);
  assert.match(source, /const deleteSelectedComparisonBooks/);
  assert.match(source, /comparison-delete-selected/);
  assert.match(source, /canEdit: boolean/);
  assert.match(source, /if \(!canEdit\)/);
  assert.match(source, /const selectedExternalVaultPaths = selectedBookRefs/);
  assert.match(source, /visibleBooks/);
  assert.match(source, /selectedKeys/);
  assert.match(source, /\u5220\u9664\u9009\u4e2d/);
  assert.match(source, /原始文件和数据未删除/);
  assert.match(workspace, /<CompareViewPanel vaultPath=\{vault\.path\} onNotice=\{onNotice\} canEdit=\{canEdit\} bookOrder=\{bookOrder\} \/>/);
  assert.match(source, /externalVaultPaths\.length === 0 \? orderGiftBooks\(visible, bookOrder\) : visible/);
  assert.doesNotMatch(source, /api\.trashVault/);
  assert.doesNotMatch(source, /api\.trashVault/);
});
