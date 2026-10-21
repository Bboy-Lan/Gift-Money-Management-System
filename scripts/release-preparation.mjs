import { createHash, randomUUID } from "node:crypto";
import { lstat, mkdir, readFile, realpath, rename, rm, writeFile } from "node:fs/promises";
import { dirname, join, relative, resolve, isAbsolute } from "node:path";
import { createUpdateManifest, releaseInstallerName, localInstallerName, verifyUpdateSignature } from "./update-manifest.mjs";
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

export async function prepareRelease(root, version, notes, installerDirectory, includeOffline = false) {
  if (!/^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/.test(version)) throw new Error("Invalid version");
  const paths = releasePaths(root, version);
  await assertBoundDirectory(paths.root, paths.target);
  await assertBoundDirectory(paths.root, paths.destination);
  try { await lstat(paths.destination); throw new Error("Refusing existing release directory; archive explicitly before another release (no overwrite)."); }
  catch (error) { if (error.code !== "ENOENT") throw error; }
  const executable = "礼金簿.exe", installer = localInstallerName(version);
  const sourceDirectory = installerDirectory ?? join(paths.target, "release/bundle/nsis");
  await assertBoundDirectory(paths.root, sourceDirectory);
  const sourceExe = join(paths.target, "release", executable), sourceInstaller = join(sourceDirectory, installer);
  await assertBoundDirectory(paths.root, sourceExe);
  await assertBoundDirectory(paths.root, sourceInstaller);
  await assertBoundDirectory(paths.root, sourceInstaller + ".sig");
  const [exeBytes, installerBytes] = await Promise.all([readFile(sourceExe), readFile(sourceInstaller)]);
  const signature = (await readFile(sourceInstaller + ".sig", "utf8")).trim();
  const offline = localInstallerName(version, true), offlinePath = join(sourceDirectory, offline);
  let offlineBytes = null, offlineSignature = null;
  if (includeOffline) {
    await assertBoundDirectory(paths.root, offlinePath);
    await assertBoundDirectory(paths.root, offlinePath + ".sig");
    offlineBytes = await readFile(offlinePath);
    offlineSignature = (await readFile(offlinePath + ".sig", "utf8")).trim();
  }
  const channelsPath = join(paths.root, "update-channels.json");
  await assertBoundDirectory(paths.root, channelsPath);
  const { publicKey } = JSON.parse(await readFile(channelsPath, "utf8"));
  verifyUpdateSignature(installerBytes, signature, publicKey, version);
  if (offlineBytes && offlineSignature) verifyUpdateSignature(offlineBytes, offlineSignature, publicKey, version);
  const manifest = createUpdateManifest(version, notes, signature);
  const staging = join(paths.root, ".release-" + randomUUID());
  await assertBoundDirectory(paths.root, staging);
  await mkdir(staging);
  try {
    await writeFile(join(staging, executable), exeBytes, { flag: "wx" });
    await writeFile(join(staging, installer), installerBytes, { flag: "wx" });
    await writeFile(join(staging, installer + ".sig"), signature + "\n", { flag: "wx" });
    await writeFile(join(staging, "latest.json"), JSON.stringify(manifest, null, 2) + "\n", { flag: "wx" });
    if (offlineBytes && offlineSignature) {
      await writeFile(join(staging, offline), offlineBytes, { flag: "wx" });
      await writeFile(join(staging, offline + ".sig"), offlineSignature + "\n", { flag: "wx" });
    }
    await writeFile(join(staging, "RELEASE_NOTES.md"), notes, { flag: "wx" });
    await writeFile(join(staging, "README.md"), "# 礼金簿 " + version + "\n\n标准安装包优先使用系统 WebView2；缺少时需联网安装。\n业务数据仍完全离线。安装版支持验签更新；SHA256仅检查意外损坏。安装包无 Windows Authenticode 证书。\n", { flag: "wx" });
    const hash = bytes => createHash("sha256").update(bytes).digest("hex").toUpperCase();
    const installers = [[installer, installerBytes, false], ...(offlineBytes ? [[offline, offlineBytes, true]] : [])];
    await writeFile(join(staging, "SHA256SUMS.txt"), hash(exeBytes) + "  " + executable + "\n" + installers.map(([name, bytes, mode]) => hash(bytes) + "  " + name + "\n" + hash(bytes) + "  " + releaseInstallerName(version, mode) + "\n").join(""), { flag: "wx" });
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
