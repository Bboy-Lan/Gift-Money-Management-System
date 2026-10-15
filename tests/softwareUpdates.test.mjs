import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import ts from "typescript";
import { JSDOM } from "jsdom";

async function load() {
  const source = await readFile(new URL("../src/lib/softwareUpdates.ts", import.meta.url), "utf8").catch(error => { if (error.code === "ENOENT") return "export {};"; throw error; });
  const js = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 } }).outputText;
  return import(`data:text/javascript;base64,${Buffer.from(js).toString("base64")}`);
}
const logic = await load();

test("check failures and unconfigured services never claim latest", () => {
  assert.equal(typeof logic.updateStatusMessage, "function");
  assert.match(logic.updateStatusMessage({ error: "连接失败", configured: true, candidate: null }), /连接失败/);
  assert.match(logic.updateStatusMessage({ error: null, configured: false, candidate: null }), /尚未配置/);
  assert.doesNotMatch(logic.updateStatusMessage(null), /最新/);
});

test("unsaved or saving forms block an update without discarding anything", () => {
  const dom = new JSDOM('<main><div data-modal-dirty="true"><input value="未提交" /></div></main>');
  assert.equal(typeof logic.canApplyUpdate, "function");
  assert.equal(logic.canApplyUpdate(dom.window.document), false);
  const form = dom.window.document.querySelector("div");
  form.dataset.modalDirty = "false"; form.dataset.modalSaving = "true";
  assert.equal(logic.canApplyUpdate(dom.window.document), false);
  form.dataset.modalSaving = "false";
  assert.equal(logic.canApplyUpdate(dom.window.document), true);
  assert.equal(form.querySelector("input").value, "未提交");
  dom.window.close();
});

test("download progress uses actual bytes and handles unknown totals", () => {
  assert.equal(typeof logic.downloadPercent, "function");
  assert.equal(logic.downloadPercent({ received: 25, total: 100 }), 25);
  assert.equal(logic.downloadPercent({ received: 100, total: null }), null);
  assert.equal(logic.downloadPercent({ received: 150, total: 100 }), 100);
});

test("installation locks the whole app synchronously and restores interaction on failure", () => {
  const dom = new JSDOM('<div id="root"><input value="保留" /></div>');
  assert.equal(typeof logic.lockUpdateInterface, "function");
  const unlock = logic.lockUpdateInterface(dom.window.document);
  assert.equal(dom.window.document.documentElement.hasAttribute("inert"), true);
  unlock();
  assert.equal(dom.window.document.documentElement.hasAttribute("inert"), false);
  assert.equal(dom.window.document.querySelector("input").value, "保留");
  dom.window.document.querySelector("input").setAttribute("data-modal-dirty", "true");
  assert.throws(() => logic.lockUpdateInterface(dom.window.document), /保存/);
  assert.equal(dom.window.document.documentElement.hasAttribute("inert"), false);
  dom.window.close();
});
