import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

test("workspace provides a dedicated settings tab above return-gift details", async () => {
  const [app, types] = await Promise.all([
    readFile(new URL("../src/App.tsx", import.meta.url), "utf8"),
    readFile(new URL("../src/types.ts", import.meta.url), "utf8"),
  ]);
  const workspace = app.slice(app.indexOf("function VaultWorkspace"), app.indexOf("function EntriesView"));

  assert.match(types, /"settings"/);
  assert.match(workspace, /activeTab === "settings"/);
  assert.match(workspace, /<SettingsView/);
  assert.match(workspace, /activeTab === "settings"[\s\S]*回礼明细/);
});

test("settings remains a valid persisted workspace tab", async () => {
  const source = await readFile(new URL("../src/lib/openedVaultSessions.ts", import.meta.url), "utf8");

  assert.match(source, /const TABS:[\s\S]*"settings"/);
});

test("operation pre-hints use an independent channel and only marked operations opt in", async () => {
  const app = await readFile(new URL("../src/App.tsx", import.meta.url), "utf8");

  assert.match(app, /const \[operationHint, setOperationHint\]/);
  assert.match(app, /data-operation-hint/);
  assert.match(app, /OperationHintToast/);
  assert.match(app, /setNotice\(message\);\s*setOperationHint\(null\)/);
  assert.doesNotMatch(app, /button\s*\{[^}]*data-operation-hint/);
});

test("settings exposes a persisted default folder and the backend applies it to file dialogs", async () => {
  const [app, api, rust] = await Promise.all([
    readFile(new URL("../src/App.tsx", import.meta.url), "utf8"),
    readFile(new URL("../src/lib/tauri.ts", import.meta.url), "utf8"),
    readFile(new URL("../src-tauri/src/lib.rs", import.meta.url), "utf8"),
  ]);

  assert.match(app, /api\.settingsStorageInfo/);
  assert.match(app, /api\.chooseSettingsDirectory/);
  assert.match(app, /选择默认文件夹/);
  assert.match(app, /不会移动已有文件/);
  assert.match(api, /settingsStorageInfo: \(\) => invoke<SettingsStorageInfo>\("settings_storage_info"\)/);
  assert.match(api, /chooseSettingsDirectory: \(\) => invoke<SettingsStorageInfo \| null>\("choose_settings_directory"\)/);
  assert.match(rust, /fn file_dialog_for_app\(app: &tauri::AppHandle\)/);
  assert.match(rust, /configured_data_directory\(app\)/);
  assert.match(rust, /choose_vault_path\(mode: String, app: tauri::AppHandle\)/);
  assert.match(rust, /choose_spreadsheet_paths\(app: tauri::AppHandle\)/);
});

test("settings has a general/about split and a confirmed GitHub update flow", async () => {
  const [app, api, rust, releaseNotes] = await Promise.all([
    readFile(new URL("../src/App.tsx", import.meta.url), "utf8"),
    readFile(new URL("../src/lib/tauri.ts", import.meta.url), "utf8"),
    readFile(new URL("../src-tauri/src/lib.rs", import.meta.url), "utf8"),
    readFile(new URL("../src/releaseNotes.ts", import.meta.url), "utf8"),
  ]);

  assert.match(app, /设置分类/);
  assert.match(app, /通用/);
  assert.match(app, /关于/);
  assert.match(app, /确认下载并安装/);
  assert.match(app, /window\.confirm/);
  assert.match(app, /candidate\.releaseNotes/);
  assert.match(app, /Gift-Money-Management-System/);
  assert.match(api, /licenseText: \(\) => invoke<string>\("license_text"\)/);
  assert.match(rust, /Gift-Money-Management-System\/releases\/latest/);
  assert.match(rust, /SHA256SUMS\.txt/);
  assert.match(rust, /release_notes: release\.body\.clone\(\)/);
  assert.match(releaseNotes, /## 0\.3\.85/);
  assert.match(rust, /GITHUB_UPDATE_INSTALLER_PREFIX/);
});

test("ledger visual spacing keeps the first metric accent visible and gives history actions room", async () => {
  const styles = await readFile(new URL("../src/styles.css", import.meta.url), "utf8");

  assert.match(styles, /\.metric-card:first-child \{ border-left: 4px solid #277a99; \}/);
  assert.match(styles, /\.audit-action \{ width: 180px; min-width: 180px; \}/);
});
