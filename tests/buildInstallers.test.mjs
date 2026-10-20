import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile, readFile, rm, readdir } from "node:fs/promises";
import { join, resolve } from "node:path";
import * as delivery from "../scripts/build-installers.mjs";
await mkdir(resolve(import.meta.dirname, "../src-tauri/target"), { recursive: true });
test("two bundle modes preserve distinct installer signatures before NSIS overwrites its output", async () => {
  const root = await mkdtemp(join(resolve(import.meta.dirname, "../src-tauri/target"), "bundles-test-"));
  try {
    const nsis = join(root, "src-tauri/target/release/bundle/nsis");
    await mkdir(nsis, { recursive: true });
    let step = 0;
    const result = await delivery.buildInstallers(root, "0.4.29", async args => {
      if (step++ === 0) { assert.deepEqual(args, ["build", "--no-bundle"]); return; }
      assert.equal(args[0], "bundle");
      assert.deepEqual(args, step === 2 ? ["bundle", "--bundles", "nsis"] : ["bundle", "--bundles", "nsis", "--config", "src-tauri/tauri.offline.conf.json"]);
      const bytes = step === 2 ? "standard" : "offline";
      await writeFile(join(nsis, "礼金簿_0.4.29_x64-setup.exe"), bytes);
      await writeFile(join(nsis, "礼金簿_0.4.29_x64-setup.exe.sig"), bytes + " signature");
    });
    try {
      assert.equal(step, 3);
      assert.equal(await readFile(join(result, "礼金簿_0.4.29_x64-setup.exe"), "utf8"), "standard");
      assert.equal(await readFile(join(result, "礼金簿_0.4.29_x64-offline-setup.exe.sig"), "utf8"), "offline signature");
    } finally { await rm(result, { recursive: true, force: true }); }
    await assert.rejects(delivery.buildInstallers(root, "0.4.29", async () => { throw new Error("bundle failed"); }), /bundle failed/);
    assert.ok(!(await readdir(join(root, "src-tauri/target"))).some(name => name.startsWith("installers-")));
  } finally { await rm(root, {recursive:true,force:true}); }
});

test("standard release rebuilds and verifies the versioned executable before bundling", async () => {
  const source = await readFile(new URL("../scripts/release-standard.mjs", import.meta.url), "utf8");

  assert.match(source, /buildStandardInstaller/);
  assert.match(source, /assertWindowsExecutableVersion/);
});

test("NSIS installs outside the desktop and refreshes one fixed desktop shortcut", async () => {
  const source = await readFile(new URL("../src-tauri/nsis/installer.nsi", import.meta.url), "utf8");

  assert.doesNotMatch(source, /!insertmacro MUI_PAGE_DIRECTORY/);
  assert.match(source, /Var LegacyDesktopInstallDir/);
  assert.match(source, /Call MigrateLegacyDesktopInstallLocation/);
  assert.match(source, /Call RestorePreviousInstallLocation\r?\n\s*\$\{EndIf\}\r?\n\s*\r?\n\s*; \/UPDATE may supply[\s\S]*?Call MigrateLegacyDesktopInstallLocation/);
  assert.match(source, /Function MigrateLegacyDesktopInstallLocation/);
  assert.match(source, /StrCpy \$INSTDIR "\$LOCALAPPDATA\\\$\{PRODUCTNAME\}"/);
  assert.match(source, /Call RemoveLegacyDesktopInstall/);
  assert.match(source, /Function RemoveLegacyDesktopInstall/);
  assert.match(source, /Delete "\$DESKTOP\\\$\{PRODUCTNAME\}\.lnk"/);
  assert.match(source, /CreateShortcut "\$DESKTOP\\\$\{PRODUCTNAME\}\.lnk" "\$INSTDIR\\\$\{MAINBINARYNAME\}\.exe"/);
});
