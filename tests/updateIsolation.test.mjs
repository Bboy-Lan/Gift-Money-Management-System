import assert from "node:assert/strict";
import { readFile, writeFile, unlink } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import test from "node:test";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { build } from "esbuild";
globalThis.__APP_VERSION__ = "0.4.27";
const source = await readFile(new URL("../src/App.tsx", import.meta.url), "utf8");
const compiled = await build({
  stdin: { contents: source.replace("export default App;", "export { AboutSettings };"), resolveDir: fileURLToPath(new URL("../src", import.meta.url)), loader: "tsx" },
  bundle: true, write: false, platform: "node", format: "esm", jsx: "automatic", loader: { ".png": "dataurl" },
  plugins: [{ name: "external", setup(builder) { builder.onResolve({ filter: /^[^./]/ }, args => ({ path: import.meta.resolve(args.path), external: true })); } }],
});
const bundle = new URL("./.update-isolation-" + process.pid + ".mjs", import.meta.url);
await writeFile(bundle, compiled.outputFiles[0].text);
const { AboutSettings } = await import(bundle.href); await unlink(bundle);
const candidate = { version: "0.4.28", releaseNotes: "notes", releaseUrl: null, publishedAt: null };
const props = { updatePhase: "idle", checkedAt: "", updateMessage: "", onCheckUpdate() {}, onInstallUpdate() {}, onShowLicense() {}, licenseOpen: false, licenseText: null };
test("official original release is informational and cannot be installed from variant", () => {
  const html = renderToStaticMarkup(React.createElement(AboutSettings, { ...props, updateStatus: { source: "github", candidate } }));
  assert.match(html, /原版.*仅供查看/);
  assert.match(html, /disabled=""[^>]*>[^<]*原版不适用于改动版/);
});
test("compatible local variant candidate retains explicit install control", () => {
  const html = renderToStaticMarkup(React.createElement(AboutSettings, { ...props, updateStatus: { source: "local", candidate } }));
  assert.match(html, /确认安装本地改动版/);
  assert.doesNotMatch(html, /disabled=""[^>]*>确认安装本地改动版/);
});
