import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile, readFile, rm, readdir, symlink } from "node:fs/promises";
import { resolve, join } from "node:path";
import { createHash, generateKeyPairSync, sign } from "node:crypto";
import { assertBoundDirectory, isolatedBuildEnv, prepareRelease, releasePaths } from "../scripts/release-preparation.mjs";
const root = resolve(import.meta.dirname, "..");
await mkdir(join(root, "src-tauri/target"), { recursive: true });

test("isolated delivery versions, identity, offline policy and CSP", async () => {
  const pkg = JSON.parse(await readFile(join(root, "package.json"), "utf8"));
  const config = JSON.parse(await readFile(join(root, "src-tauri/tauri.conf.json"), "utf8"));
  const cargo = await readFile(join(root, "src-tauri/Cargo.toml"), "utf8");
  assert.equal(pkg.version, "0.4.37");
  assert.equal(config.version, pkg.version);
  assert.ok(cargo.includes(`version = "${pkg.version}"`));
  assert.equal(pkg.devDependencies.jsdom, "26.1.0");
  assert.equal(config.productName, "礼金簿");
  assert.equal(config.mainBinaryName, "礼金簿");
  assert.equal(config.identifier, "com.codex.lijinbook.remediation");
  assert.equal(config.bundle.windows.nsis.installMode, "currentUser");
  assert.deepEqual(config.bundle.fileAssociations ?? [], []);
  assert.equal(config.bundle.windows.webviewInstallMode.type, "embedBootstrapper");
  const overlay = JSON.parse(await readFile(join(root, "src-tauri/tauri.offline.conf.json"), "utf8"));
  assert.deepEqual(overlay.bundle.windows.webviewInstallMode, { type: "fixedRuntime", path: "webview2-fixed" });
  const channels = JSON.parse(await readFile(join(root, "update-channels.json"), "utf8"));
  assert.equal(config.plugins.updater.pubkey, channels.publicKey);
  assert.equal(config.plugins.updater.requireSignedVersion, true);
  assert.ok(Buffer.from(channels.publicKey, "base64").toString("utf8").startsWith("untrusted comment:"));
  assert.ok(!config.app.security.csp.includes("unsafe-eval"));
  assert.ok(pkg.scripts.test && pkg.scripts.verify);
});

test("release paths and build environment ignore inherited redirection", () => {
  const oldTarget = process.env.CARGO_TARGET_DIR;
  const oldDestination = process.env.RELEASE_DIRECTORY;
  const oldConfig = process.env.TAURI_CONFIG;
  const oldProject = process.env.TAURI_PROJECT_DIR;
  const oldBuild = process.env.CARGO_BUILD_BUILD_DIR;
  try {
    process.env.CARGO_TARGET_DIR = "C:/outside";
    process.env.RELEASE_DIRECTORY = "C:/outside";
    process.env.TAURI_CONFIG = "C:/outside/tauri.conf.json";
    process.env.TAURI_PROJECT_DIR = "C:/outside";
    process.env.CARGO_BUILD_BUILD_DIR = "C:/outside";
    assert.equal(releasePaths(root).target, join(root, "src-tauri/target"));
    assert.equal(releasePaths(root).destination, join(root, "release"));
    const env = isolatedBuildEnv();
    for (const key of ["CARGO_TARGET_DIR", "CARGO_BUILD_BUILD_DIR", "TAURI_CONFIG", "TAURI_PROJECT_DIR"]) assert.equal(env[key], undefined);
  } finally {
    if (oldTarget === undefined) delete process.env.CARGO_TARGET_DIR; else process.env.CARGO_TARGET_DIR = oldTarget;
    if (oldDestination === undefined) delete process.env.RELEASE_DIRECTORY; else process.env.RELEASE_DIRECTORY = oldDestination;
    if (oldConfig === undefined) delete process.env.TAURI_CONFIG; else process.env.TAURI_CONFIG = oldConfig;
    if (oldProject === undefined) delete process.env.TAURI_PROJECT_DIR; else process.env.TAURI_PROJECT_DIR = oldProject;
    if (oldBuild === undefined) delete process.env.CARGO_BUILD_BUILD_DIR; else process.env.CARGO_BUILD_BUILD_DIR = oldBuild;
  }
});

test("safe preparation preserves both signed installers without loose runtime, refuses repeated version", async () => {
  const fixture = await mkdtemp(join(root, "src-tauri/target/delivery-test-"));
  try {
    const built = join(fixture, "src-tauri/target/release");
    await mkdir(join(built, "bundle/nsis"), { recursive: true });
    await writeFile(join(built, "礼金簿.exe"), "exe");
    await writeFile(join(built, "bundle/nsis/礼金簿_0.4.27_x64-setup.exe"), "installer");
    const { publicKey, privateKey } = generateKeyPairSync("ed25519");
    const id = Buffer.from("12345678"), comment = "version:0.4.27";
    const signing = bytes => {
      const sig = sign(null, Buffer.from(bytes), privateKey);
      return Buffer.from(`untrusted comment: fixture\n${Buffer.concat([Buffer.from("Ed"), id, sig]).toString("base64")}\ntrusted comment: ${comment}\n${sign(null, Buffer.concat([sig, Buffer.from(comment)]), privateKey).toString("base64")}\n`).toString("base64");
    };
    const key = Buffer.from(`untrusted comment: fixture\n${Buffer.concat([Buffer.from("Ed"), id, publicKey.export({type:"spki",format:"der"}).subarray(-32)]).toString("base64")}\n`).toString("base64");
    await writeFile(join(fixture, "update-channels.json"), JSON.stringify({ publicKey: key }));
    const signature = signing("installer");
    await writeFile(join(built, "bundle/nsis/礼金簿_0.4.27_x64-setup.exe.sig"), signature);
    await writeFile(join(built, "bundle/nsis/礼金簿_0.4.27_x64-offline-setup.exe"), "offline installer");
    await writeFile(join(built, "bundle/nsis/礼金簿_0.4.27_x64-offline-setup.exe.sig"), signing("offline installer"));
    const offlinePath = join(built, "bundle/nsis/礼金簿_0.4.27_x64-offline-setup.exe");
    await rm(offlinePath);
    await assert.rejects(prepareRelease(fixture, "0.4.27", "notes"), /ENOENT/);
    await writeFile(offlinePath, "corrupted");
    await assert.rejects(prepareRelease(fixture, "0.4.27", "notes"), /signature/i);
    assert.ok(!(await readdir(fixture)).includes("release"));
    await writeFile(offlinePath, "offline installer");
    const result = await prepareRelease(fixture, "0.4.27", "notes");
    assert.ok(!(await readdir(result)).includes("webview2-fixed"));
    assert.equal(await readFile(join(result, "礼金簿_0.4.27_x64-offline-setup.exe"), "utf8"), "offline installer");
    const hashes = await readFile(join(result, "SHA256SUMS.txt"), "utf8");
    assert.ok(hashes.includes(createHash("sha256").update("installer").digest("hex").toUpperCase()));
    assert.ok(hashes.includes(createHash("sha256").update("offline installer").digest("hex").toUpperCase() + "  Gift-Money-Management-System_0.4.27_x64-offline-setup.exe"));
    const manifest = JSON.parse(await readFile(join(result, "latest.json"), "utf8"));
    assert.equal(manifest.platforms["lijinbook-remediation-windows-x86_64"].signature, signature);
    assert.equal(manifest.platforms["lijinbook-remediation-windows-x86_64"].url, "https://github.com/Bboy-Lan/Gift-Money-Management-System/releases/download/v0.4.27/Gift-Money-Management-System_0.4.27_x64-setup.exe");
    await assert.rejects(prepareRelease(fixture, "0.4.27", "replacement"), /existing|overwrite/);
    assert.equal(await readFile(join(result, "RELEASE_NOTES.md"), "utf8"), "notes");
    assert.deepEqual((await readdir(fixture)).sort(), ["release", "src-tauri", "update-channels.json"]);
  } finally { await rm(fixture, { recursive: true, force: true }); }
});

test("missing build inputs fail without creating final artifacts", async () => {
  const fixture = await mkdtemp(join(root, "src-tauri/target/delivery-test-"));
  try {
    await assert.rejects(prepareRelease(fixture, "0.4.27", "notes"), /runtime|ENOENT/);
    assert.deepEqual(await readdir(fixture), []);
  } finally { await rm(fixture, { recursive: true, force: true }); }
});

test("linked release destination is rejected before writing final artifacts", async (t) => {
  const fixture = await mkdtemp(join(root, "src-tauri/target/delivery-test-"));
  const outside = await mkdtemp(join(root, "src-tauri/target/delivery-outside-"));
  try {
    const linked = join(fixture, "release");
    try { await symlink(outside, linked, "junction"); }
    catch (error) { t.skip(`junction unavailable: ${error.code ?? error.message}`); return; }
    await assert.rejects(assertBoundDirectory(fixture, linked), /Linked paths|escapes project boundary/);
    await assert.rejects(prepareRelease(fixture, "0.4.29", "notes"), /Linked paths|escapes project boundary/);
    assert.deepEqual(await readdir(outside), []);
  } finally {
    await rm(fixture, { recursive: true, force: true });
    await rm(outside, { recursive: true, force: true });
  }
});
