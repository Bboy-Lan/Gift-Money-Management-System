import assert from "node:assert/strict";
import { writeFile, unlink } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import test, { after } from "node:test";
import React, { act } from "react";
import { JSDOM } from "jsdom";
import { build } from "esbuild";

const dom = new JSDOM("<!doctype html><html><body></body></html>", { url: "https://local.test/" });
Object.assign(globalThis, { window: dom.window, document: dom.window.document, HTMLElement: dom.window.HTMLElement, IS_REACT_ACT_ENVIRONMENT: true });
const { createRoot } = await import("react-dom/client");
const result = await build({
  entryPoints: [fileURLToPath(new URL("../src/components/FeedbackAdminLogin.tsx", import.meta.url))],
  bundle: true, write: false, platform: "node", format: "esm", jsx: "automatic",
  plugins: [{ name: "feedback-network-boundary", setup(builder) {
    builder.onResolve({ filter: /^[^./]/ }, args => args.kind === "entry-point" ? undefined : ({ path: import.meta.resolve(args.path), external: true }));
    builder.onLoad({ filter: /[\\/]lib[\\/]cloudFeedback\.ts$/ }, () => ({
      contents: "export const requestFeedbackAdminCode = (email) => globalThis.__requestAdminCode(email);", loader: "ts",
    }));
  } }],
});
const bundle = new URL(`./.feedback-login-${process.pid}.mjs`, import.meta.url);
await writeFile(bundle, result.outputFiles[0].text);
let FeedbackAdminLogin;
try { ({ FeedbackAdminLogin } = await import(bundle.href)); } finally { await unlink(bundle); }
after(() => dom.window.close());

async function mount(onAuthenticated) {
  const container = document.createElement("div"); document.body.append(container);
  const root = createRoot(container);
  function Host() {
    const [busy, setBusy] = React.useState(false);
    return React.createElement(FeedbackAdminLogin, { busy, onBusyChange: setBusy, onAuthenticated });
  }
  await act(async () => root.render(React.createElement(Host)));
  return { container, async close() { await act(async () => root.unmount()); container.remove(); } };
}
async function input(element, value) {
  await act(async () => {
    Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, "value").set.call(element, value);
    element.dispatchEvent(new window.Event("input", { bubbles: true }));
    element.dispatchEvent(new window.Event("change", { bubbles: true }));
  });
}
function button(container, label) { return [...container.querySelectorAll("button")].find(x => x.textContent.includes(label)); }
async function click(element) { assert.ok(element); await act(async () => element.dispatchEvent(new window.MouseEvent("click", { bubbles: true }))); }

test("administrator login sends email OTP and verifies it without a password form", async () => {
  const calls = []; let authenticated = 0;
  globalThis.__requestAdminCode = async email => { calls.push(email); return { verify: async code => calls.push(code) }; };
  const view = await mount(async () => { authenticated++; });
  try {
    assert.equal(view.container.querySelector('input[type="password"]'), null);
    await input(view.container.querySelector('input[type="email"]'), "admin@example.test");
    await click(button(view.container, "获取验证码"));
    assert.deepEqual(calls, ["admin@example.test"]);
    assert.equal(button(view.container, "重发").disabled, true);
    await input(view.container.querySelector('input[autocomplete="one-time-code"]'), "123456");
    await click(button(view.container, "验证并登录"));
    assert.deepEqual(calls, ["admin@example.test", "123456"]);
    assert.equal(authenticated, 1);
  } finally { await view.close(); }
});

test("changing the email invalidates the old OTP challenge", async () => {
  let verified = false;
  globalThis.__requestAdminCode = async () => ({ verify: async () => { verified = true; } });
  const view = await mount(async () => {});
  try {
    await input(view.container.querySelector('input[type="email"]'), "first@example.test");
    await click(button(view.container, "获取验证码"));
    await input(view.container.querySelector('input[type="email"]'), "second@example.test");
    assert.equal(view.container.querySelector('input[autocomplete="one-time-code"]'), null);
    assert.equal(verified, false);
  } finally { await view.close(); }
});

test("authorization failure remains visible and does not enter administrator mode", async () => {
  let authenticated = false;
  globalThis.__requestAdminCode = async () => ({ verify: async () => { throw new Error("该邮箱未获管理员授权"); } });
  const view = await mount(async () => { authenticated = true; });
  try {
    await input(view.container.querySelector('input[type="email"]'), "member@example.test");
    await click(button(view.container, "获取验证码"));
    await input(view.container.querySelector('input[autocomplete="one-time-code"]'), "123456");
    await click(button(view.container, "验证并登录"));
    assert.match(view.container.querySelector('[role="alert"]').textContent, /未获管理员授权/);
    assert.equal(authenticated, false);
  } finally { await view.close(); }
});
