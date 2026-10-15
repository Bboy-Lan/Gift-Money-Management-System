import assert from "node:assert/strict";
import { writeFile, unlink } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import test from "node:test";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { build } from "esbuild";
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
  { id: "cloud", label: "腾讯云下载", url: null },
  { id: "github", label: "GitHub 下载", url: "https://github.com/Bboy-Lan/Gift-Money-Management-System/releases" },
  { id: "lanzou", label: "蓝奏云", url: null },
  { id: "baidu", label: "百度网盘", url: null },
];
test("all download categories are visible and missing links are disabled", () => {
  const html = renderToStaticMarkup(React.createElement(AboutSettings, { ...props, updateStatus: { configured: false, installed: true, candidate: null, channels } }));
  for (const label of ["腾讯云", "GitHub", "网盘", "蓝奏云", "百度网盘"]) assert.ok(html.includes(label));
  assert.match(html, /disabled=""[^>]*aria-label="腾讯云下载"/);
  assert.doesNotMatch(html, /href="(?:#|javascript:)/);
  assert.match(html, /尚未配置/);
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
