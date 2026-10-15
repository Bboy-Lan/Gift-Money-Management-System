import { createHash, randomUUID } from "node:crypto";
import { cp, lstat, mkdir, readFile, realpath, rename, rm, writeFile, readdir } from "node:fs/promises";
import { dirname, join, relative, resolve, isAbsolute } from "node:path";
import { createUpdateManifest, releaseInstallerName } from "./update-manifest.mjs";
export function releasePaths(root, version) {
  root = resolve(root);
  if (version !== undefined && !/^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/.test(version)) throw new Error("Invalid release version");
  return { root, target: join(root, "src-tauri/target"), destination: version ? join(root, "release", version) : join(root, "release") };
}

// A local release must be built from this checkout.  Do not let a caller's
// Tauri/Cargo redirection variables select another config, project, or cache.
export function isolatedBuildEnv(base = process.env) {
  const env = { ...base };
  for (const key of [
    "CARGO_TARGET_DIR",
    "CARGO_BUILD_BUILD_DIR",
    "TAURI_CONFIG",
    "TAURI_CONFIG_PATH",
    "TAURI_PROJECT_DIR",
  ]) delete env[key];
  return env;
}
export async function assertBoundDirectory(root, target) {
  root = resolve(root); target = resolve(target);
  const suffix = relative(root, target);
  if (suffix.startsWith("..") || isAbsolute(suffix)) throw new Error("Path escapes project boundary");
  let current = target;
  while (true) {
    try { if ((await lstat(current)).isSymbolicLink()) throw new Error("Linked paths are not allowed: " + current); }
    catch (error) { if (error.code !== "ENOENT") throw error; }
    if (current === root) break;
    current = dirname(current);
  }
  const canonicalRoot = await realpath(root);
  try {
    const actual = relative(canonicalRoot, await realpath(target));
    if (actual.startsWith("..") || isAbsolute(actual)) throw new Error("Resolved path escapes project boundary");
  } catch (error) { if (error.code !== "ENOENT") throw error; }
}
async function assertTree(root, path) {
  await assertBoundDirectory(root, path);
  if ((await lstat(path)).isDirectory()) {
    for (const name of await readdir(path)) await assertTree(root, join(path, name));
  }
}

async function publishStaging(staging, destination) {
  for (let attempt = 0; attempt < 8; attempt += 1) {
    try {
      await rename(staging, destination);
      return;
    } catch (error) {
      if (!["EPERM", "EBUSY", "EACCES"].includes(error.code) || attempt === 7) throw error;
      try {
        await lstat(destination);
        throw new Error("Release destination appeared while publishing; refusing to overwrite.");
      } catch (destinationError) {
        if (destinationError.code !== "ENOENT") throw destinationError;
      }
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
  }
}

export async function prepareRelease(root, version, notes) {
  if (!/^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/.test(version)) throw new Error("Invalid version");
  const paths = releasePaths(root, version), runtime = join(paths.root, "src-tauri/webview2-fixed");
  await assertTree(paths.root, runtime);
  await lstat(join(runtime, "msedgewebview2.exe"));
  await assertBoundDirectory(paths.root, paths.target);
  await assertBoundDirectory(paths.root, paths.destination);
  try { await lstat(paths.destination); throw new Error("Refusing existing release directory; archive explicitly before another release (no overwrite)."); }
  catch (error) { if (error.code !== "ENOENT") throw error; }
  const executable = "礼金簿.exe", installer = "礼金簿_" + version + "_x64-setup.exe";
  const sourceExe = join(paths.target, "release", executable), sourceInstaller = join(paths.target, "release/bundle/nsis", installer);
  await assertBoundDirectory(paths.root, sourceExe);
  await assertBoundDirectory(paths.root, sourceInstaller);
  await assertBoundDirectory(paths.root, sourceInstaller + ".sig");
  const [exeBytes, installerBytes] = await Promise.all([readFile(sourceExe), readFile(sourceInstaller)]);
  const signature = (await readFile(sourceInstaller + ".sig", "utf8")).trim();
  const manifest = createUpdateManifest(version, notes, signature);
  const staging = join(paths.root, ".release-" + randomUUID());
  await assertBoundDirectory(paths.root, staging);
  await mkdir(staging);
  try {
    await writeFile(join(staging, executable), exeBytes, { flag: "wx" });
    await writeFile(join(staging, installer), installerBytes, { flag: "wx" });
    await writeFile(join(staging, installer + ".sig"), signature + "\n", { flag: "wx" });
    await writeFile(join(staging, "latest.json"), JSON.stringify(manifest, null, 2) + "\n", { flag: "wx" });
    await cp(runtime, join(staging, "webview2-fixed"), { recursive: true, errorOnExist: true, force: false });
    await writeFile(join(staging, "RELEASE_NOTES.md"), notes, { flag: "wx" });
    await writeFile(join(staging, "README.md"), "# 礼金簿 " + version + "\n\n推荐运行安装包；便携使用须保留完整 webview2-fixed 文件夹。\n安装版可在关于页一键更新：下载、验签，保存并关闭表单后退出、原位置覆盖安装并重启。便携版请手动下载安装包。\n业务数据仍完全离线；设置/PIN使用独立目录，不迁移原版数据设置。首次升级旧版本需手动运行本安装包。\nGitHub已配置；腾讯云、蓝奏云和百度网盘未配置。latest.json与.sig用于客户端签名校验；SHA256仅检查意外损坏。安装包尚无Windows Authenticode证书，SmartScreen仍可能提示。\n", { flag: "wx" });
    const hash = bytes => createHash("sha256").update(bytes).digest("hex").toUpperCase();
    await writeFile(join(staging, "SHA256SUMS.txt"), hash(exeBytes) + "  " + executable + "\n" + hash(installerBytes) + "  " + installer + "\n" + hash(installerBytes) + "  " + releaseInstallerName(version) + "\n", { flag: "wx" });
    await assertBoundDirectory(paths.root, staging);
    await assertBoundDirectory(paths.root, paths.destination);
    await mkdir(dirname(paths.destination), { recursive: true });
    await publishStaging(staging, paths.destination);
    return paths.destination;
  } catch (error) {
    await assertBoundDirectory(paths.root, staging);
    await rm(staging, { recursive: true, force: true });
    throw error;
  }
}
