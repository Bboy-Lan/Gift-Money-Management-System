import assert from "node:assert/strict";
import { writeFile, unlink, readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import test from "node:test";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { build } from "esbuild";
import { JSDOM } from "jsdom";
import { createRoot } from "react-dom/client";
import { act } from "react";
import { mockIPC, clearMocks } from "@tauri-apps/api/mocks";
globalThis.__APP_VERSION__ = "0.4.28";
const compiled = await build({
  entryPoints: [fileURLToPath(new URL("../src/components/AboutSettings.tsx", import.meta.url))],
  bundle: true, write: false, platform: "node", format: "esm", jsx: "automatic",
  plugins: [{ name: "external", setup(builder) { builder.onResolve({ filter: /^[^./]/ }, args => args.kind === "entry-point" ? undefined : ({ path: import.meta.resolve(args.path), external: true })); } }],
});
const bundle = new URL("./.update-isolation-" + process.pid + ".mjs", import.meta.url);
await writeFile(bundle, compiled.outputFiles[0].text);
const { AboutSettings } = await import(bundle.href); await unlink(bundle);
const props = { updatePhase: "idle", checkedAt: "尚未检查", onCheckUpdate() {}, onInstallUpdate() {}, onShowLicense() {}, licenseOpen: false, licenseText: null };
const channels = [
  { id: "github", label: "GitHub 下载", url: "https://github.com/Bboy-Lan/Gift-Money-Management-System" },
  { id: "lanzou", label: "蓝奏云", url: "https://wwaxt.lanzouu.com/b01i5xguqb", extractionCode: "Niko" },
  { id: "baidu", label: "百度网盘", url: "https://pan.baidu.com/s/1aTT_M2aBvope8K-fhYB0Tg?pwd=Niko", extractionCode: "Niko" },
];
test("three download card titles open the configured share pages and show public extraction codes", () => {
  const html = renderToStaticMarkup(React.createElement(AboutSettings, { ...props, updateStatus: { configured: false, installed: true, candidate: null, channels } }));
  for (const label of ["GitHub", "蓝奏云", "百度网盘", "提取码", "Niko"]) assert.ok(html.includes(label), label);
  const downloadHtml = html.slice(html.indexOf('class="download-channel-grid"'), html.indexOf('class="release-notes-details"'));
  assert.doesNotMatch(downloadHtml, /腾讯云|同一个版本/);
  assert.match(html, /先保存.*退出/);
  assert.doesNotMatch(downloadHtml, /标准包.*离线包/);
  assert.doesNotMatch(html, /href="(?:#|javascript:)/);
  assert.match(html, /尚未配置/);
  const configuredDom = new JSDOM(html);
  assert.equal(configuredDom.window.document.querySelectorAll('.download-channel-title').length, 3);
  configuredDom.window.close();
  const missing = renderToStaticMarkup(React.createElement(AboutSettings, { ...props, updateStatus: { configured: false, installed: true, candidate: null, channels: channels.map(channel => ({ ...channel, url: null })) } }));
  const missingDom = new JSDOM(missing);
  assert.ok([...missingDom.window.document.querySelectorAll('.download-channel-title')].every(button => button.disabled));
  missingDom.window.close();
});

test("public channel configuration exposes the approved manual shares", async () => {
  const config = JSON.parse(await readFile(new URL("../update-channels.json", import.meta.url), "utf8"));
  assert.equal(config.cloud, undefined);
  assert.equal(config.github.downloadUrl, channels[0].url);
  assert.equal(config.github.manifestUrl, "https://github.com/Bboy-Lan/Gift-Money-Management-System/releases/latest/download/latest.json");
  assert.equal(config.lanzouUrl, channels[1].url);
  assert.equal(config.baiduUrl, channels[2].url);
  assert.equal(config.lanzouExtractionCode, "Niko");
  assert.equal(config.baiduExtractionCode, "Niko");
});

test("available version notes are collapsible and show the candidate, not current notes", () => {
  const status = { configured: true, installed: true, candidate: { id: 'next', version: '0.4.36', source: 'github', releaseNotes: '新功能详情' }, channels };
  const html = renderToStaticMarkup(React.createElement(AboutSettings, { ...props, updateStatus: status }));
  const dom = new JSDOM(html);
  const details = [...dom.window.document.querySelectorAll('details')].find((item) => item.textContent.includes('新版本 v0.4.36'));
  assert.ok(details);
  assert.equal(details.open, false);
  assert.match(details.textContent, /新功能详情/);
  dom.window.close();
  const fallback = renderToStaticMarkup(React.createElement(AboutSettings, { ...props, updateStatus: { ...status, candidate: { ...status.candidate, releaseNotes: null } } }));
  assert.match(fallback, /该版本暂未提供更新说明/);
});

test("real update hook routes buttons and shows manual fallback after check and download failures", async () => {
  const compiled = await build({ stdin: { contents: 'export {useSoftwareUpdates, SoftwareUpdateContext} from "./src/hooks/useSoftwareUpdates"; export {AboutSettings} from "./src/components/AboutSettings";', resolveDir: fileURLToPath(new URL("..", import.meta.url)) }, jsx: "automatic", bundle: true, write: false, platform: "node", format: "esm",
    plugins: [{ name: "external", setup(builder) { builder.onResolve({ filter: /^[^./]/ }, args => args.kind === "entry-point" ? undefined : ({ path: import.meta.resolve(args.path), external: true })); } }] });
  const path = new URL(`./.update-hook-${process.pid}.mjs`, import.meta.url);
  await writeFile(path, compiled.outputFiles[0].text);
  const { useSoftwareUpdates, SoftwareUpdateContext, AboutSettings: About } = await import(path.href); await unlink(path);
  const dom = new JSDOM('<div id="root"></div>', { url: "https://app.test" });
  const prior = { window: globalThis.window, document: globalThis.document, IS_REACT_ACT_ENVIRONMENT: globalThis.IS_REACT_ACT_ENVIRONMENT };
  Object.assign(globalThis, { window: dom.window, document: dom.window.document, IS_REACT_ACT_ENVIRONMENT: true });
  let controller;
  let failure = "throw";
  let prepareFails = true, prepares = 0, applies = 0;
  const opened = [], notices = [];
  const status = { currentVersion: "0.4.30", configured: true, installed: true, checkedAt: "2026-10-16", candidate: null, channels, error: null };
  mockIPC((command, args) => {
    if (command === "software_update_options") return status;
    if (command === "acknowledge_software_update") return null;
    if (command === "software_update_status") {
      if (failure === "throw") throw new Error("GitHub unavailable");
      if (failure === "status") return { ...status, error: "GitHub检查失败" };
      return { ...status, candidate: { id: "next", version: "0.4.34", source: "github", releaseNotes: null } };
    }
    if (command === "open_download_channel") { opened.push(args.channelId); return null; }
    if (command === "prepare_software_update") { prepares++; if (prepareFails) throw new Error("下载失败"); return null; }
    if (command === "apply_software_update") { applies++; assert.equal(dom.window.document.documentElement.hasAttribute("inert"), true); throw new Error("安装未启动"); }
    throw new Error(`Unexpected ${command}`);
  });
  function Harness() {
    controller = useSoftwareUpdates({ beforeInstall() {}, onNotice: message => notices.push(message) });
    return React.createElement(SoftwareUpdateContext.Provider, { value: controller }, React.createElement(About, { ...props, updatePhase: controller.phase, updateStatus: controller.status }));
  }
  const root = createRoot(dom.window.document.getElementById("root"));
  try {
    await act(async () => root.render(React.createElement(Harness)));
    const buttons = dom.window.document.querySelectorAll('.download-channel-title');
    assert.equal(buttons.length, 3);
    for (const button of buttons) { assert.equal(button.disabled, false); await act(async () => button.click()); }
    assert.deepEqual(opened, ["github", "lanzou", "baidu"]);
    await act(async () => controller.check(false));
    assert.match(controller.status.error, /GitHub unavailable/);
    assert.match(controller.error, /蓝奏云.*百度网盘/);
    assert.doesNotMatch(dom.window.document.querySelector('.about-update-result').textContent, /已是最新/);
    assert.deepEqual(notices, []);
    failure = "status";
    await act(async () => controller.check(true));
    assert.match(controller.error, /蓝奏云.*百度网盘/);
    failure = "candidate";
    await act(async () => controller.check(true));
    await act(async () => controller.install());
    assert.match(controller.error, /下载失败.*蓝奏云.*百度网盘/);
    assert.equal(controller.phase, "idle");
    prepareFails = false;
    const dirty = dom.window.document.createElement("input"); dirty.dataset.modalDirty = "true"; dirty.value = "未保存"; dom.window.document.body.append(dirty);
    await act(async () => controller.install());
    assert.equal(controller.phase, "ready");
    assert.equal(prepares, 2);
    assert.equal(applies, 0);
    assert.equal(dirty.value, "未保存");
    dirty.dataset.modalDirty = "false";
    await act(async () => controller.install());
    assert.equal(prepares, 2, "prepared candidate is reused");
    assert.equal(applies, 1);
    assert.equal(controller.phase, "ready");
    assert.equal(dom.window.document.documentElement.hasAttribute("inert"), false);
  } finally { await act(async () => root.unmount()); clearMocks(); dom.window.close(); Object.assign(globalThis, prior); }
});
test("only a backend-bound installable candidate offers one-click installation", () => {
  const candidate = { id: "checked-id", version: "0.4.29", source: "github", releaseNotes: "新增更新提示" };
  const html = renderToStaticMarkup(React.createElement(AboutSettings, { ...props, updateStatus: { configured: true, installed: true, candidate, channels } }));
  assert.match(html, /立即更新/);
  assert.doesNotMatch(html, /disabled=""[^>]*>[^<]*立即更新/);
  assert.match(html, /新增更新提示/);
  const portable = renderToStaticMarkup(React.createElement(AboutSettings, { ...props, updateStatus: { configured: true, installed: false, candidate, channels } }));
  assert.match(portable, /安装版支持一键更新/);
});
