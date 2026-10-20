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

test("settings has a general/about split and only installs a verified local variant package", async () => {
  const [app, api, rust, updateSecurity, releaseNotes] = await Promise.all([
    readFile(new URL("../src/App.tsx", import.meta.url), "utf8"),
    readFile(new URL("../src/lib/tauri.ts", import.meta.url), "utf8"),
    readFile(new URL("../src-tauri/src/lib.rs", import.meta.url), "utf8"),
    readFile(new URL("../src-tauri/src/update_security.rs", import.meta.url), "utf8"),
    readFile(new URL("../src/releaseNotes.ts", import.meta.url), "utf8"),
  ]);

  assert.match(app, /设置分类/);
  assert.match(app, /通用/);
  assert.match(app, /关于/);
  assert.match(app, /useSoftwareUpdates/);
  assert.match(app, /<AboutSettings/);
  const about = await readFile(new URL("../src/components/AboutSettings.tsx", import.meta.url), "utf8");
  assert.match(about, /candidate\.releaseNotes/);
  assert.match(about, /暂未配置/);
  assert.match(api, /prepareSoftwareUpdate/);
  assert.match(api, /applySoftwareUpdate/);
  assert.match(api, /licenseText: \(\) => invoke<string>\("license_text"\)/);
  assert.match(api, /officialReleaseStatus: \(\) => invoke<LocalUpdateStatus>\("official_release_status"\)/);
  assert.match(rust, /Gift-Money-Management-System\/releases\/latest/);
  assert.match(updateSecurity, /只允许安装目录中更高版本的改动版安装包/);
  assert.match(rust, /release_notes: release\.body\.clone\(\)/);
  assert.match(releaseNotes, /## 0\.4\.27/);
  assert.doesNotMatch(rust, /browser_download_url/);
});

test("settings navigation is horizontal and local-mode popover keeps only mode and continuous registration", async () => {
  const source = await readFile(new URL("../src/App.tsx", import.meta.url), "utf8");
  const styles = await readFile(new URL("../src/styles.css", import.meta.url), "utf8");

  assert.match(styles, /\.settings-layout \{ display: block; \}/);
  assert.match(styles, /\.settings-nav \{ display: inline-flex/);
  const popover = source.slice(source.indexOf('className="file-info-popover"'), source.indexOf('className="file-info-popover"') + 2200);
  assert.match(popover, /持续登记/);
  assert.doesNotMatch(popover, /软件更新|修改 PIN/);
  assert.match(source, /continuousRegistration, setContinuousRegistration\] = useState\(true\)/);
  assert.match(source, /管理员模式.*用户模式/);
});

test("opened vault tabs can close one session without deleting its source file", async () => {
  const [app, styles, sessions] = await Promise.all([
    readFile(new URL("../src/App.tsx", import.meta.url), "utf8"),
    readFile(new URL("../src/styles.css", import.meta.url), "utf8"),
    readFile(new URL("../src/lib/openedVaultSessions.ts", import.meta.url), "utf8"),
  ]);
  assert.match(app, /closeOpenedVault/);
  assert.match(app, /onCloseVault/);
  assert.match(app, /不会删除原始文件/);
  assert.match(app, /setOpenedVaults\(remaining/);
  assert.match(styles, /\.opened-vault-tab-close/);
  assert.match(sessions, /rememberOpenedVaultSessions/);
  assert.match(app, /setTimeout\(\(\) => setShowClose\(true\), 700\)/);
  assert.match(app, /onMouseLeave={endHover}/);
});

test("arrow keys scroll the active page without hijacking form controls", async () => {
  const source = await readFile(new URL("../src/App.tsx", import.meta.url), "utf8");
  assert.match(source, /ArrowUp.*ArrowDown.*ArrowLeft.*ArrowRight/);
  assert.match(source, /closest\("input, textarea, select, button/);
  assert.match(source, /scrollBy\(\{ left:/);
  assert.match(source, /behavior: "auto"/);
});

test("first-time users can start creating a vault without finding the settings unlock action", async () => {
  const source = await readFile(new URL("../src/App.tsx", import.meta.url), "utf8");
  assert.match(source, /首次使用：新建礼金库/);
  assert.match(source, /解锁管理并新建礼金库/);
  assert.match(source, /onUnlock=\{\(\) => \{ setEnterWorkspaceAfterAdmin\(false\); setPendingWorkspaceVault\(null\); setAdminPrompt\(session.securityConfigured \? "unlock" : "setup"\); \}\}/);
  assert.match(source, /尚未打开礼金库/);
  assert.match(source, /设置管理员 PIN 后即可创建礼金库并开始登记/);
  assert.match(source, /className="vault-onboarding"/);
  assert.match(source, /礼金库包含礼金簿/);
  assert.match(source, /王家礼金库/);
  assert.match(source, /王伟婚礼礼金、搬新房礼金/);
  assert.match(source, /一个家庭或一份可移动的 \.giftvault 文件/);
  assert.match(source, /先新建礼金库，再在库内新建礼金簿/);
});

test("missing recent vaults are removed and enter the no-vault workspace without resetting the PIN", async () => {
  const [source, styles] = await Promise.all([
    readFile(new URL("../src/App.tsx", import.meta.url), "utf8"),
    readFile(new URL("../src/styles.css", import.meta.url), "utf8"),
  ]);
  assert.match(source, /forgetRecentVaultPath\(opened\.recent\.path\)/);
  assert.match(source, /setWorkspaceOpen\(true\)/);
  assert.match(source, /已移除失效记录；请打开已有礼金库或新建礼金库/);
  assert.match(source, /setAdminPrompt\(session\.securityConfigured \? "unlock" : "setup"\)/);
  assert.match(styles, /\.vault-onboarding-flow/);
  assert.match(styles, /\.vault-onboarding-step/);
});

test("the no-vault workspace keeps software update downloads reachable", async () => {
  const source = await readFile(new URL("../src/App.tsx", import.meta.url), "utf8");

  assert.match(source, /const \[softwareSettingsOpen, setSoftwareSettingsOpen\] = useState\(false\)/);
  assert.match(source, /软件设置/);
  assert.match(source, /onOpenSoftwareSettings/);
  assert.match(source, /<NoVaultSoftwareSettings/);
  assert.match(source, /查看下载方式/);
});

test("settings includes a donation page with bundled QR images", async () => {
  const [app, styles] = await Promise.all([
    readFile(new URL("../src/App.tsx", import.meta.url), "utf8"),
    readFile(new URL("../src/styles.css", import.meta.url), "utf8"),
  ]);
  assert.match(app, /打赏支持/);
  assert.match(app, /wechatDonateImage/);
  assert.match(app, /alipayDonateImage/);
  assert.match(app, /function DonationSettings/);
  assert.match(styles, /\.donation-grid/);
  assert.match(styles, /\.donation-image-frame img/);
});

test("continuous registration reopens a cleared entry form after a successful save", async () => {
  const source = await readFile(new URL("../src/App.tsx", import.meta.url), "utf8");
  assert.match(source, /continuousRegistration/);
  assert.match(source, /setEntryFormKey\(\(key\) => key \+ 1\)/);
  assert.match(source, /登记成功，请继续登记下一条礼金/);
  assert.match(source, /key=\{entryFormKey\}/);
  assert.match(source, /onStopContinuousRegistration/);
});

test("ledger visual spacing keeps the first metric accent visible and gives history actions room", async () => {
  const styles = await readFile(new URL("../src/styles.css", import.meta.url), "utf8");

  assert.match(styles, /\.metric-card:first-child \{ border-left: 4px solid #277a99; \}/);
  assert.match(styles, /\.audit-action \{ width: 180px; min-width: 180px; \}/);
});
