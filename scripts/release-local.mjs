import { createHash } from "node:crypto";
import { copyFile, mkdir, readdir, readFile, stat, unlink, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { execFile } from "node:child_process";

const run = promisify(execFile);
const root = fileURLToPath(new URL("..", import.meta.url));
const packageInfo = JSON.parse(await readFile(join(root, "package.json"), "utf8"));
const version = packageInfo.version;
const cargoManifest = await readFile(join(root, "src-tauri", "Cargo.toml"), "utf8");
const cargoVersion = cargoManifest.match(/^version\s*=\s*"([^"]+)"/m)?.[1];
const tauriConfig = JSON.parse(await readFile(join(root, "src-tauri", "tauri.conf.json"), "utf8"));
if (!cargoVersion || cargoVersion !== version || tauriConfig.version !== version) {
  throw new Error("Release versions must match in package.json, src-tauri/Cargo.toml, and src-tauri/tauri.conf.json.");
}

const executableName = "礼金簿管理.exe";
const installerName = `礼金簿管理_${version}_x64-setup.exe`;
const cargoBin = join(process.env.USERPROFILE || homedir(), ".cargo", "bin");
const existingPath = process.env.Path || process.env.PATH || "";
const releaseEnvironment = Object.fromEntries(
  Object.entries(process.env).filter(([name]) => name.toLowerCase() !== "path"),
);
releaseEnvironment.Path = `${cargoBin};${existingPath}`;

async function desktopDirectory() {
  const { stdout } = await run("powershell.exe", [
    "-NoProfile",
    "-NonInteractive",
    "-Command",
    "[Environment]::GetFolderPath('Desktop')",
  ]);
  const value = stdout.trim();
  if (!value) throw new Error("Unable to resolve the Windows Desktop directory.");
  return value;
}

async function sha256(path) {
  const bytes = await readFile(path);
  return createHash("sha256").update(bytes).digest("hex").toUpperCase();
}

async function closeRunningApp() {
  if (process.platform !== "win32") return;
  for (const processName of [executableName, "lijin-book.exe"]) {
    try {
      await run("taskkill.exe", ["/F", "/T", "/IM", processName]);
    } catch (error) {
      // taskkill returns 128 when the process is not running; other failures are actionable.
      if (error?.code !== 128) throw error;
    }
  }
}

const releaseDirectory = join(await desktopDirectory(), "礼金簿管理系统");
await mkdir(releaseDirectory, { recursive: true });
await closeRunningApp();
const releaseInstaller = join(releaseDirectory, installerName);
try {
  await stat(releaseInstaller);
  throw new Error(`Refusing to overwrite an existing release installer: ${releaseInstaller}. Increment the release version first.`);
} catch (error) {
  if (error?.code !== "ENOENT") throw error;
}

await run(process.env.ComSpec || "cmd.exe", ["/d", "/s", "/c", "npm.cmd run tauri -- build"], {
  cwd: root,
  env: releaseEnvironment,
});

const builtExecutable = join(root, "src-tauri", "target", "release", executableName);
const builtInstaller = join(root, "src-tauri", "target", "release", "bundle", "nsis", installerName);
await stat(builtExecutable);
await stat(builtInstaller);

const runtimeTarget = join(releaseDirectory, "webview2-fixed");
await stat(join(runtimeTarget, "msedgewebview2.exe"));

await copyFile(builtExecutable, join(releaseDirectory, executableName));
await copyFile(builtInstaller, releaseInstaller);

const installerPattern = /^(礼金簿|礼金管理|礼金簿管理)_\d+\.\d+\.\d+_x64-setup\.exe$/;
const obsoletePortableNames = new Set(["lijin-book.exe", "礼金管理.exe"]);
for (const entry of await readdir(releaseDirectory, { withFileTypes: true })) {
  if (entry.isFile() && installerPattern.test(entry.name) && entry.name !== installerName) {
    await unlink(join(releaseDirectory, entry.name));
  }
  if (entry.isFile() && obsoletePortableNames.has(entry.name)) {
    await unlink(join(releaseDirectory, entry.name));
  }
}

const changelog = await readFile(join(root, "CHANGELOG.md"), "utf8");
const escapedVersion = version.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
const releaseNotesMatch = changelog.match(new RegExp(`^##\\s+v?${escapedVersion}\\s+-.*?(?=^##\\s+|(?![\\s\\S]))`, "ms"));
if (!releaseNotesMatch) throw new Error(`CHANGELOG.md is missing release notes for ${version}.`);
const releaseNotes = `${releaseNotesMatch[0].trim()}\n`;
const readme = `# 礼金簿管理 ${version}

Windows 本地离线礼金记录工具。数据始终保存在用户选择的礼金库文件中，不依赖本发布目录。

## 快速开始

1. 双击\`礼金簿管理_${version}_x64-setup.exe\`安装，或直接运行\`礼金簿管理.exe\`。
2. 首次使用设置 6 至 12 位数字的管理员 PIN，并妥善保存一次性恢复码。
3. 在工作台新建礼金库，或打开已有的\`.giftvault\`文件；导入 Excel 前先明确当前礼金库和目标礼金簿。
4. 设置页可指定新建或打开礼金库、选择导入表格时的默认文件夹；已有礼金库文件不会被自动移动。
5. 本机模式默认开启“持续登记”；每条礼金保存成功后会自动打开下一条登记表单，点击按钮关闭或取消登记即可退出。

## 概念与日常操作

- **礼金库**：一个独立的活动或家庭数据文件，可包含多本礼金簿。
- **礼金簿**：礼金库中的具体表格，例如婚礼、春节或一次活动；人物和礼金记录归属于该礼金簿。
- **礼金明细**：登记、编辑、导入和导出 Excel 的位置。导出的表格包含礼金、回礼金额、回礼时间和备注等固定列。
- **人物与标签**：用于查询和维护人物标签；对具体人物的标签修改会写入历史改动。
- **跨簿比较**：默认仅显示当前礼金库内的礼金簿；通过“添加其他礼金库”加入过的来源会保留为历史使用记录。删除选中只会从比较范围移除，不删除原始文件。
- **回收站与历史改动**：删除的数据可恢复；高风险删除和批量操作需要管理员解锁编辑。关闭软件后再次打开默认进入礼金明细。

## 数据与权限

- 管理员 PIN 仅保存在本机；进入管理员模式后可修改 PIN。
- 请将\`.giftvault\`和导出的完整礼金库文件保存在可靠位置，并定期使用“导出库”备份。
- Excel 用于交换数据；完整迁移请使用“导出库”生成的软件专属礼金库文件。
- 在线更新需要网络连接和 GitHub 上已发布的安装包；没有线上版本时仍可使用桌面发布目录中的本地更新包。

## 发布内容

- \`礼金簿管理.exe\`：便携版程序。
- \`礼金簿管理_${version}_x64-setup.exe\`：Windows 安装包。
- \`webview2-fixed\`：随程序自动使用的固定 WebView2 运行时，无需额外安装。
- \`SHA256SUMS.txt\`：程序和安装包校验值。

“设置 → 关于”中的“检查更新”会优先检查本目录中版本更高的安装包；本地没有候选版本时，再检查 GitHub Releases。发现新版本后，程序会先展示更新明细，用户确认后才下载；安装包通过 SHA-256 清单校验后，使用正式安装程序覆盖更新并重启。
`;
await writeFile(join(releaseDirectory, "README.md"), readme, "utf8");
await writeFile(join(releaseDirectory, "CHANGELOG.md"), changelog, "utf8");
await writeFile(join(releaseDirectory, "RELEASE_NOTES.md"), releaseNotes, "utf8");

const executableHash = await sha256(join(releaseDirectory, executableName));
const installerHash = await sha256(releaseInstaller);
await writeFile(
  join(releaseDirectory, "SHA256SUMS.txt"),
  `${executableHash}  ${executableName}\n${installerHash}  ${installerName}\n`,
  "utf8",
);

console.log(`Release published: ${releaseDirectory}`);
console.log(`Version: ${version}`);
console.log(`Portable executable: ${join(releaseDirectory, executableName)}`);
console.log(`Installer: ${releaseInstaller}`);
console.log(`Fixed WebView2 runtime: ${runtimeTarget}`);
