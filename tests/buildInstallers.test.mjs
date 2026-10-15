import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile, readFile, rm, readdir } from "node:fs/promises";
import { join, resolve } from "node:path";
import * as delivery from "../scripts/build-installers.mjs";
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
