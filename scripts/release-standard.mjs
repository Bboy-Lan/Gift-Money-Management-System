import { spawnSync } from "node:child_process";
import { lstat, readFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { buildStandardInstaller } from "./build-installers.mjs";
import { assertBoundDirectory, isolatedBuildEnv, prepareRelease, releasePaths } from "./release-preparation.mjs";

const root = fileURLToPath(new URL("..", import.meta.url));
const pkg = JSON.parse(await readFile(join(root, "package.json"), "utf8"));
const config = JSON.parse(await readFile(join(root, "src-tauri/tauri.conf.json"), "utf8"));
const cargo = await readFile(join(root, "src-tauri/Cargo.toml"), "utf8");
const version = pkg.version;
const paths = releasePaths(root, version);
if (config.version !== version || !cargo.includes(`version = "${version}"`)) throw new Error("Versions must match.");
if (config.bundle.windows.webviewInstallMode.type !== "embedBootstrapper") throw new Error("Standard installer configuration required.");
await assertBoundDirectory(root, paths.target);
await assertBoundDirectory(root, paths.destination);
try { await lstat(paths.destination); throw new Error("Refusing existing release directory; no overwrite."); }
catch (error) { if (error.code !== "ENOENT") throw error; }
const changelog = await readFile(join(root, "CHANGELOG.md"), "utf8");
const marker = `## ${version} -`;
const start = changelog.indexOf(marker);
if (start < 0) throw new Error("Release notes missing.");
const end = changelog.indexOf("\n## ", start + marker.length);
const notes = changelog.slice(start, end < 0 ? undefined : end).trim() + "\n";
const channels = JSON.parse(await readFile(join(root, "update-channels.json"), "utf8"));
if (config.plugins.updater.pubkey !== channels.publicKey) throw new Error("Bundler and runtime updater public keys must match.");
const keyPath = join(root, ".local-signing/lijinbook.key");
if ((await readFile(keyPath + ".pub", "utf8")).trim() !== channels.publicKey) throw new Error("Signing public key does not match the application.");
const env = { ...isolatedBuildEnv(), CARGO_TARGET_DIR: paths.target, CARGO_NET_OFFLINE: "true", TAURI_SIGNING_PRIVATE_KEY: keyPath, TAURI_SIGNING_PRIVATE_KEY_PASSWORD: "", CI: "true" };
function run(command, args) {
  const result = spawnSync(command, args, { cwd: root, env, stdio: "inherit", shell: false });
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error(`${command} failed (${result.status})`);
}
function assertWindowsExecutableVersion(executable, expectedVersion) {
  const literal = `'${executable.replace(/'/g, "''")}'`;
  const script = `$version = (Get-Item -LiteralPath ${literal}).VersionInfo.ProductVersion; [Console]::OutputEncoding = [System.Text.UTF8Encoding]::new(); Write-Output $version`;
  const result = spawnSync("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", script], { cwd: root, encoding: "utf8", shell: false });
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error(`Unable to read built executable version (${result.status})`);
  const actualVersion = result.stdout.trim();
  if (actualVersion !== expectedVersion) throw new Error(`Built executable version ${actualVersion || "missing"} does not match ${expectedVersion}`);
}
const executable = await buildStandardInstaller(root, version, args => run(process.execPath, [join(root, "node_modules/@tauri-apps/cli/tauri.js"), ...args]));
assertWindowsExecutableVersion(executable, version);
const destination = await prepareRelease(root, version, notes, undefined, false);
console.log("Prepared standard release: " + destination);
