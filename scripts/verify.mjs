import { spawnSync } from "node:child_process";
import { mkdtemp, rm, mkdir } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { join } from "node:path";
import { releasePaths, assertBoundDirectory, isolatedBuildEnv } from "./release-preparation.mjs";
const root = fileURLToPath(new URL("..", import.meta.url));
const { target } = releasePaths(root);
await mkdir(target, { recursive: true });
await assertBoundDirectory(root, target);
const profile = await mkdtemp(join(target, "verify-profile-"));
const env = { ...isolatedBuildEnv(), CARGO_TARGET_DIR: target, CARGO_NET_OFFLINE: "true", LOCALAPPDATA: profile };
function run(command, args) {
  const result = spawnSync(command, args, { cwd: root, env, stdio: "inherit", shell: false });
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error(command + " failed (" + result.status + ")");
}
try {
  run(process.execPath, ["--test", "tests/*.test.mjs"]);
  run("cargo", ["fmt", "--manifest-path", "src-tauri/Cargo.toml", "--", "--check"]);
  run("cargo", ["test", "--locked", "--offline", "--manifest-path", "src-tauri/Cargo.toml"]);
  run("cargo", ["clippy", "--locked", "--offline", "--manifest-path", "src-tauri/Cargo.toml", "--all-targets", "--", "-D", "warnings"]);
  run(process.env.ComSpec || "cmd.exe", ["/d", "/s", "/c", "npm.cmd run build"]);
} finally {
  await assertBoundDirectory(target, profile);
  await rm(profile, { recursive: true, force: true });
}
