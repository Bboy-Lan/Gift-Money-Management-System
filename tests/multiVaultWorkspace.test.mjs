import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

test("workspace keeps multiple opened vault sessions and switches the Rust context before rendering", async () => {
  const source = await readFile(new URL("../src/App.tsx", import.meta.url), "utf8");

  assert.match(source, /const \[openedVaults, setOpenedVaults\]/);
  assert.match(source, /api\.openVault\(path\)/);
  assert.match(source, /className=\{`opened-vault-tab/);
  assert.match(source, /onSwitchVault=\{switchVault\}/);
  assert.match(source, /restoreOpenedVaultSessions\(savedSessions, preferredVault\?\.path\)/);
  assert.match(source, /const preferredKey = preferredPath \? vaultPathKey\(preferredPath\) : null/);
  assert.match(source, /activeBookId: string \| null; activeTab: Tab/);
  assert.match(source, /\}, \[workspaceOpen \|\| Boolean\(vault\)\]\);/);
});

test("workspace sidebar keeps vault and gift-book actions in their required order", async () => {
  const source = await readFile(new URL("../src/App.tsx", import.meta.url), "utf8");
  const styles = await readFile(new URL("../src/styles.css", import.meta.url), "utf8");
  const workspaceStart = source.indexOf("function VaultWorkspace");
  const sidebarStart = source.indexOf('<aside className="sidebar">', workspaceStart);
  const sidebarActions = source.slice(sidebarStart, source.indexOf('<div className="book-list">', sidebarStart));
  const createVaultAt = sidebarActions.indexOf("新建礼金库");
  const createBookAt = sidebarActions.indexOf("新建礼金簿");
  const openVaultAt = sidebarActions.indexOf("打开礼金库");
  const importAt = sidebarActions.indexOf("导入表格");

  assert.ok(createVaultAt >= 0);
  assert.ok(openVaultAt > createVaultAt);
  assert.ok(createBookAt > openVaultAt);
  assert.ok(importAt > openVaultAt);
  assert.match(styles, /\.sidebar-create \+ \.sidebar-create:not\(\.sidebar-open\) \{ margin-top: 12px; \}/);
  assert.match(styles, /\.sidebar-open, \.sidebar-book-create \{ margin-top: 12px; \}/);
});

test("new vaults preserve the current unlocked editing session and books use a file icon", async () => {
  const app = await readFile(new URL("../src/App.tsx", import.meta.url), "utf8");
  const rust = await readFile(new URL("../src-tauri/src/lib.rs", import.meta.url), "utf8");
  const createVault = rust.slice(rust.indexOf("fn create_vault("), rust.indexOf("fn edit_vault("));

  assert.match(app, /<span className="book-icon"><FileSpreadsheet size=\{15\} \/><\/span>/);
  assert.doesNotMatch(createVault, /edit_locked\s*=\s*true/);
  assert.match(createVault, /require_admin\(&state\)\?/);
});

test("workspace page is shared across opened vaults but restart returns to gift details", async () => {
  const app = await readFile(new URL("../src/App.tsx", import.meta.url), "utf8");

  assert.match(app, /const \[workspaceTab, setWorkspaceTab\] = useState<Tab>\("entries"\)/);
  assert.match(app, /setOpenedVaults\(\(current\) => current\.map\(\(item\) => \(\{ \.\.\.item, activeTab: tab \}\)\)\)/);
  assert.match(app, /initialTab=\{workspaceTab\}/);
  assert.match(app, /activeTab: "entries"/);
  assert.match(app, /setWorkspaceTab\("entries"\)/);
  assert.doesNotMatch(app, /setWorkspaceTab\(active\.saved\.activeTab\)/);
});

test("comparison defaults to the active vault and adds historical sources only when saved", async () => {
  const source = await readFile(new URL("../src/CompareView.tsx", import.meta.url), "utf8");

  assert.match(source, /readComparisonVaults\(\)/);
  assert.match(source, /uniqueVaultPaths\(\[vaultPath, \.\.\.externalVaultPaths\]\)/);
  assert.match(source, /if \(!selected\.length\) return/);
});

test("desktop product uses the 礼金簿管理 executable and installer names", async () => {
  const config = await readFile(new URL("../src-tauri/tauri.conf.json", import.meta.url), "utf8");
  const release = await readFile(new URL("../scripts/release-local.mjs", import.meta.url), "utf8");

  assert.match(config, /"productName": "礼金簿管理"/);
  assert.match(config, /"mainBinaryName": "礼金簿管理"/);
  assert.match(release, /const executableName = "礼金簿管理\.exe"/);
  assert.match(release, /礼金簿管理_\$\{version\}_x64-setup\.exe/);
});

test("gift-book editing is independent from vault editing and preserves source metadata", async () => {
  const app = await readFile(new URL("../src/App.tsx", import.meta.url), "utf8");
  const api = await readFile(new URL("../src/lib/tauri.ts", import.meta.url), "utf8");
  const rust = await readFile(new URL("../src-tauri/src/lib.rs", import.meta.url), "utf8");

  assert.match(app, /编辑礼金库/);
  assert.match(app, /编辑礼金簿/);
  assert.match(app, /<BookMetadata book=\{activeBook\} vaultPath=\{vault\.path\} \/>/);
  assert.match(api, /editBook: \(bookId: string, input:/);
  assert.match(api, /invoke<GiftBook>\("edit_book"/);
  assert.match(rust, /fn edit_book\(/);
  assert.match(rust, /"edit-book"/);
  assert.match(rust, /source_file_path: existing\.source_file_path/);
  assert.match(rust, /source_imported_at: existing\.source_imported_at/);
});

test("comparison file dialog starts at Desktop while ordinary file dialogs start at This PC", async () => {
  const rust = await readFile(new URL("../src-tauri/src/lib.rs", import.meta.url), "utf8");

  assert.match(rust, /const WINDOWS_THIS_PC_NAMESPACE: &str = "::\{20D04FE0-3AEA-1069-A2D8-08002B30309D\}"/);
  assert.match(rust, /fn default_file_dialog\(\) -> FileDialog/);
  const ordinaryDialogCommands = ["choose_vault_path", "choose_file_path", "choose_spreadsheet_path", "choose_spreadsheet_paths"];
  for (const command of ordinaryDialogCommands) {
    const start = rust.indexOf(`fn ${command}`);
    const end = rust.indexOf("#[tauri::command]", start + 1);
    assert.doesNotMatch(rust.slice(start, end), /FileDialog::new\(\)/);
  }
  assert.match(rust, /fn choose_comparison_vault_paths\(app: tauri::AppHandle\)[\s\S]*?desktop_directory\(&app\)[\s\S]*?FileDialog::new\(\)\.set_directory\(directory\)/);
});

test("batch spreadsheet import requires an explicit existing-book or new-book target", async () => {
  const source = await readFile(new URL("../src/App.tsx", import.meta.url), "utf8");
  const apiSource = await readFile(new URL("../src/lib/tauri.ts", import.meta.url), "utf8");
  const rustSource = await readFile(new URL("../src-tauri/src/lib.rs", import.meta.url), "utf8");
  const modelSource = await readFile(new URL("../src-tauri/src/models.rs", import.meta.url), "utf8");

  assert.match(source, /targetBookId/);
  assert.match(source, /明确新建礼金簿/);
  assert.match(source, /books=\{books\.data \?\? \[\]\}/);
  assert.match(apiSource, /targetBookId\?: string \| null/);
  assert.match(modelSource, /pub target_book_id: Option<String>/);
  assert.match(modelSource, /pub create_new_book: bool/);
  assert.match(rustSource, /validate_spreadsheet_target/);
  assert.match(rustSource, /目标礼金簿不存在或已被删除/);
});

test("vault metadata editing and complete export use vault-level commands", async () => {
  const app = await readFile(new URL("../src/App.tsx", import.meta.url), "utf8");
  const apiSource = await readFile(new URL("../src/lib/tauri.ts", import.meta.url), "utf8");
  const rust = await readFile(new URL("../src-tauri/src/lib.rs", import.meta.url), "utf8");
  const models = await readFile(new URL("../src-tauri/src/models.rs", import.meta.url), "utf8");

  assert.match(models, /pub notes: Option<String>/);
  assert.match(app, /编辑礼金库/);
  assert.match(app, /api\.editVault\(name, notes\)/);
  assert.match(app, /api\.exportVault\(\)/);
  assert.match(app, /<Archive size=\{15\} \/>导出库/);
  assert.doesNotMatch(app, /onClick=\{\(\) => entries\.refetch\(\)\}><RefreshCw/);
  assert.match(apiSource, /invoke<VaultInfo>\("edit_vault"/);
  assert.match(apiSource, /invoke<string>\("export_vault"/);
  assert.match(rust, /fn edit_vault\(/);
  assert.match(rust, /fn export_vault\(/);
  assert.match(rust, /VACUUM INTO/);
  assert.match(rust, /validate_vault_file\(&destination\)/);
  assert.match(rust, /\("vault", "update"\)/);
});

test("global search reports every opened vault and per-vault match counts", async () => {
  const app = await readFile(new URL("../src/App.tsx", import.meta.url), "utf8");
  const types = await readFile(new URL("../src/types.ts", import.meta.url), "utf8");
  const rust = await readFile(new URL("../src-tauri/src/lib.rs", import.meta.url), "utf8");

  assert.match(app, /const openedSearchPaths = useMemo\(\(\) => openedVaults\.map/);
  assert.match(app, /找到 \{result\.totalMatches\} 位人物记录/);
  assert.match(app, /搜索范围：/);
  assert.match(types, /interface SearchVaultSummary/);
  assert.match(types, /searchedVaults: SearchVaultSummary\[\]/);
  assert.match(types, /totalMatches: number/);
  assert.match(rust, /fn resolve_opened_search_paths\(/);
  assert.match(rust, /requested_paths\.is_empty\(\)/);
  assert.match(rust, /match_count: vault_hits/);
});

test("trash items retain their source vault and restore through that exact path", async () => {
  const app = await readFile(new URL("../src/App.tsx", import.meta.url), "utf8");
  const api = await readFile(new URL("../src/lib/tauri.ts", import.meta.url), "utf8");
  const model = await readFile(new URL("../src-tauri/src/models.rs", import.meta.url), "utf8");
  const rust = await readFile(new URL("../src-tauri/src/lib.rs", import.meta.url), "utf8");

  assert.match(model, /pub vault_path: Option<String>/);
  assert.match(api, /restoreTrashItem: \(kind: TrashItem\["kind"\], id: string, vaultPath: string \| null\)/);
  assert.match(app, /api\.restoreTrashItem\(item\.kind, item\.id, item\.vaultPath\)/);
  assert.match(rust, /fn list_trash_from_connection\(/);
  assert.match(rust, /fn admin_connection_for_path\(/);
  assert.match(rust, /vault_path\.as_deref\(\)/);
});

test("trash restores only selected items and has no legacy bulk restore command", async () => {
  const app = await readFile(new URL("../src/App.tsx", import.meta.url), "utf8");
  const api = await readFile(new URL("../src/lib/tauri.ts", import.meta.url), "utf8");
  const rust = await readFile(new URL("../src-tauri/src/lib.rs", import.meta.url), "utf8");
  const styles = await readFile(new URL("../src/styles.css", import.meta.url), "utf8");
  const trash = app.slice(app.indexOf("function TrashView"), app.indexOf("function EmptyBookState"));

  assert.match(trash, /const \[selectionMode, setSelectionMode\]/);
  assert.match(trash, /const \[selectedTrashKeys, setSelectedTrashKeys\]/);
  assert.match(trash, /for \(const item of items\) await api\.restoreTrashItem/);
  assert.match(trash, /选择回收站项目/);
  assert.match(trash, /退出多选/);
  assert.match(trash, />恢复<\/button>/);
  assert.doesNotMatch(trash, /恢复全部/);
  assert.doesNotMatch(trash, /RefreshCw/);
  assert.doesNotMatch(api, /restoreAllTrash/);
  assert.doesNotMatch(rust, /fn restore_all_trash/);
  assert.match(styles, /\.history-view \.toolbar-actions > \.compact, \.trash-view \.toolbar-actions > \.compact/);
});
