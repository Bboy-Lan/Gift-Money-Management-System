import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile, readFile, rm, readdir, symlink } from "node:fs/promises";
import { resolve, join } from "node:path";
import { createHash } from "node:crypto";
import { assertBoundDirectory, isolatedBuildEnv, prepareRelease, releasePaths } from "../scripts/release-preparation.mjs";
const root = resolve(import.meta.dirname, "..");

test("isolated delivery versions, identity, offline policy and CSP", async () => {
  const pkg = JSON.parse(await readFile(join(root, "package.json"), "utf8"));
  const config = JSON.parse(await readFile(join(root, "src-tauri/tauri.conf.json"), "utf8"));
  const cargo = await readFile(join(root, "src-tauri/Cargo.toml"), "utf8");
  assert.equal(pkg.version, "0.4.27");
  assert.equal(config.version, pkg.version);
  assert.match(cargo, /version = "0.4.27"/);
  assert.equal(pkg.devDependencies.jsdom, "26.1.0");
  assert.equal(config.productName, "礼金簿—改动");
  assert.equal(config.mainBinaryName, "礼金簿—改动");
  assert.equal(config.identifier, "com.codex.lijinbook.remediation");
  assert.equal(config.bundle.windows.nsis.installMode, "currentUser");
  assert.deepEqual(config.bundle.fileAssociations ?? [], []);
  assert.equal(config.bundle.windows.webviewInstallMode.type, "fixedRuntime");
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

test("safe preparation copies complete runtime and hashes files, refuses repeated version", async () => {
  const fixture = await mkdtemp(join(root, "src-tauri/target/delivery-test-"));
  try {
    const built = join(fixture, "src-tauri/target/release");
    await mkdir(join(built, "bundle/nsis"), { recursive: true });
    await mkdir(join(fixture, "src-tauri/webview2-fixed"), { recursive: true });
    await writeFile(join(built, "礼金簿—改动.exe"), "exe");
    await writeFile(join(built, "bundle/nsis/礼金簿—改动_0.4.27_x64-setup.exe"), "installer");
    await writeFile(join(fixture, "src-tauri/webview2-fixed/msedgewebview2.exe"), "runtime");
    await writeFile(join(fixture, "src-tauri/webview2-fixed/icudtl.dat"), "runtime dependency");
    const result = await prepareRelease(fixture, "0.4.27", "notes");
    assert.equal(await readFile(join(result, "webview2-fixed/icudtl.dat"), "utf8"), "runtime dependency");
    const hashes = await readFile(join(result, "SHA256SUMS.txt"), "utf8");
    assert.ok(hashes.includes(createHash("sha256").update("installer").digest("hex").toUpperCase()));
    await assert.rejects(prepareRelease(fixture, "0.4.27", "replacement"), /existing|overwrite/);
    assert.equal(await readFile(join(result, "RELEASE_NOTES.md"), "utf8"), "notes");
    assert.deepEqual((await readdir(fixture)).sort(), ["release", "src-tauri"]);
  } finally { await rm(fixture, { recursive: true, force: true }); }
});

test("missing fixed runtime fails without creating final artifacts", async () => {
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
    assert.deepEqual(await readdir(outside), []);
  } finally {
    await rm(fixture, { recursive: true, force: true });
    await rm(outside, { recursive: true, force: true });
  }
});
