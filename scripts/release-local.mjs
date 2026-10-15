import { spawnSync } from "node:child_process";
import { readFile, lstat, rm } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { releasePaths, assertBoundDirectory, isolatedBuildEnv, prepareRelease } from "./release-preparation.mjs";
import { buildInstallers } from "./build-installers.mjs";
const root = fileURLToPath(new URL("..", import.meta.url));
const pkg = JSON.parse(await readFile(join(root, "package.json"), "utf8"));
const config = JSON.parse(await readFile(join(root, "src-tauri/tauri.conf.json"), "utf8"));
const cargo = await readFile(join(root, "src-tauri/Cargo.toml"), "utf8"), version = pkg.version;
const paths = releasePaths(root, version);
if (config.version !== version || !cargo.includes('version = "' + version + '"')) throw new Error("Versions must match.");
if (config.productName !== "礼金簿" || config.identifier !== "com.codex.lijinbook.remediation"
  || config.mainBinaryName !== "礼金簿" || config.bundle.windows.webviewInstallMode.type !== "embedBootstrapper") throw new Error("Isolated standard configuration required.");
await assertBoundDirectory(root, paths.target);
await assertBoundDirectory(root, paths.destination);
try { await lstat(paths.destination); throw new Error("Refusing existing release directory; no overwrite."); }
catch (error) { if (error.code !== "ENOENT") throw error; }
await assertBoundDirectory(root, join(root, "src-tauri/webview2-fixed/msedgewebview2.exe"));
await lstat(join(root, "src-tauri/webview2-fixed/msedgewebview2.exe"));
const changelog = await readFile(join(root, "CHANGELOG.md"), "utf8");
const marker = "## " + version + " -", position = changelog.indexOf(marker);
if (position < 0) throw new Error("Release notes missing.");
const next = changelog.indexOf("\n## ", position + marker.length), notes = changelog.slice(position, next < 0 ? undefined : next).trim() + "\n";
const env = { ...isolatedBuildEnv(), CARGO_TARGET_DIR: paths.target, CARGO_NET_OFFLINE: "true" };
const channels = JSON.parse(await readFile(join(root, "update-channels.json"), "utf8"));
if (config.plugins.updater.pubkey !== channels.publicKey) throw new Error("Bundler and runtime updater public keys must match.");
const keyPath = join(root, ".local-signing/lijinbook.key");
if ((await readFile(keyPath + ".pub", "utf8")).trim() !== channels.publicKey) throw new Error("Signing public key does not match the application.");
Object.assign(env, { TAURI_SIGNING_PRIVATE_KEY: keyPath, TAURI_SIGNING_PRIVATE_KEY_PASSWORD: "", CI: "true" });
function run(command, args) {
  const result = spawnSync(command, args, { cwd: root, env, stdio: "inherit", shell: false });
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error(command + " failed (" + result.status + ")");
}
run(process.execPath, [join(root, "scripts/verify.mjs")]);
const staging = await buildInstallers(root, version, args => run(process.execPath, [join(root, "node_modules/@tauri-apps/cli/tauri.js"), ...args]));
let destination;
try { destination = await prepareRelease(root, version, notes, staging); }
finally {
  await assertBoundDirectory(root, staging);
  await rm(staging, { recursive: true, force: true });
}
const shortcutArgs = ["-NoProfile", "-ExecutionPolicy", "Bypass", "-File", join(root, "scripts/create-shortcut.ps1"), "-Root", root, "-Executable", join(destination, "礼金簿.exe")];
try { run("powershell.exe", shortcutArgs); }
catch (error) {
  const quote = value => "'" + value.replaceAll("'", "''") + "'";
  console.error("Signed artifacts retained at " + destination + ". Do not rebuild or remove this version; resolve the shortcut error and rerun only:\n& powershell.exe " + shortcutArgs.map(quote).join(" "));
  throw error;
}
console.log("Prepared standard and offline release: " + destination);
