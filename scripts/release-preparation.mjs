import { createHash, randomUUID } from "node:crypto";
import { cp, lstat, mkdir, readFile, realpath, rename, rm, writeFile, readdir } from "node:fs/promises";
import { dirname, join, relative, resolve, isAbsolute } from "node:path";
export function releasePaths(root) {
  root = resolve(root);
  return { root, target: join(root, "src-tauri/target"), destination: join(root, "release") };
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
  const paths = releasePaths(root), runtime = join(paths.root, "src-tauri/webview2-fixed");
  await assertTree(paths.root, runtime);
  await lstat(join(runtime, "msedgewebview2.exe"));
  await assertBoundDirectory(paths.root, paths.target);
  await assertBoundDirectory(paths.root, paths.destination);
  try { await lstat(paths.destination); throw new Error("Refusing existing release directory; archive explicitly before another release (no overwrite)."); }
  catch (error) { if (error.code !== "ENOENT") throw error; }
  const executable = "礼金簿—改动.exe", installer = "礼金簿—改动_" + version + "_x64-setup.exe";
  const sourceExe = join(paths.target, "release", executable), sourceInstaller = join(paths.target, "release/bundle/nsis", installer);
  await assertBoundDirectory(paths.root, sourceExe);
  await assertBoundDirectory(paths.root, sourceInstaller);
  const [exeBytes, installerBytes] = await Promise.all([readFile(sourceExe), readFile(sourceInstaller)]);
  const staging = join(paths.root, ".release-" + randomUUID());
  await assertBoundDirectory(paths.root, staging);
  await mkdir(staging);
  try {
    await writeFile(join(staging, executable), exeBytes, { flag: "wx" });
    await writeFile(join(staging, installer), installerBytes, { flag: "wx" });
    await cp(runtime, join(staging, "webview2-fixed"), { recursive: true, errorOnExist: true, force: false });
    await writeFile(join(staging, "RELEASE_NOTES.md"), notes, { flag: "wx" });
    await writeFile(join(staging, "README.md"), "# 礼金簿—改动 " + version + "\n\n用户使用完整便携文件夹或离线安装包，target/node_modules 是开发缓存。固定 WebView2 必须一并保留。\n独立产品、PIN/设置、每用户安装目录。不会注册 .giftvault 默认关联；从程序内打开文件。\n启动仅检查本目录；关于页可手动查看原版发布信息，不能安装原版。\nSHA256 检查意外损坏，同目录清单和未签名 PE 元数据不证明发布者身份。\n", { flag: "wx" });
    const hash = bytes => createHash("sha256").update(bytes).digest("hex").toUpperCase();
    await writeFile(join(staging, "SHA256SUMS.txt"), hash(exeBytes) + "  " + executable + "\n" + hash(installerBytes) + "  " + installer + "\n", { flag: "wx" });
    await assertBoundDirectory(paths.root, staging);
    await assertBoundDirectory(paths.root, paths.destination);
    await publishStaging(staging, paths.destination);
    return paths.destination;
  } catch (error) {
    await assertBoundDirectory(paths.root, staging);
    await rm(staging, { recursive: true, force: true });
    throw error;
  }
}
