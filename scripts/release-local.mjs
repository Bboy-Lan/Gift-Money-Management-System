import { spawnSync } from "node:child_process";
import { readFile, lstat } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { releasePaths, assertBoundDirectory, isolatedBuildEnv, prepareRelease } from "./release-preparation.mjs";
const root = fileURLToPath(new URL("..", import.meta.url));
const pkg = JSON.parse(await readFile(join(root, "package.json"), "utf8"));
const config = JSON.parse(await readFile(join(root, "src-tauri/tauri.conf.json"), "utf8"));
const cargo = await readFile(join(root, "src-tauri/Cargo.toml"), "utf8"), version = pkg.version;
const paths = releasePaths(root, version);
if (config.version !== version || !cargo.includes('version = "' + version + '"')) throw new Error("Versions must match.");
if (config.productName !== "礼金簿" || config.identifier !== "com.codex.lijinbook.remediation"
  || config.mainBinaryName !== "礼金簿" || config.bundle.windows.webviewInstallMode.type !== "fixedRuntime") throw new Error("Isolated offline configuration required.");
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
run(process.env.ComSpec || "cmd.exe", ["/d", "/s", "/c", "npm.cmd run tauri -- build"]);
console.log("Prepared offline release: " + await prepareRelease(root, version, notes));
