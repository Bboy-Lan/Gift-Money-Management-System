import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { transform } from "esbuild";

const feedbackSource = await readFile(new URL("../src/lib/cloudFeedback.ts", import.meta.url), "utf8");
const feedbackComponent = await readFile(new URL("../src/components/CloudFeedback.tsx", import.meta.url), "utf8");
const schema = await readFile(new URL("../cloudbase/feedback/001_feedback_schema.sql", import.meta.url), "utf8");
const compiledFeedback = (await transform(feedbackSource, { loader: "ts", format: "esm" })).code.replace('import { installFeedbackTransport } from "./feedbackTransport";', 'const installFeedbackTransport = () => {};');
const projectRoot = fileURLToPath(new URL("..", import.meta.url));

test("importing feedback and rejecting invalid text lets the real SDK process exit", () => {
  const result = spawnSync(process.execPath, ["--input-type=module", "-e", compiledFeedback + `
    import assert from "node:assert/strict";
    assert.equal(feedbackCategoryLabel("suggestion"), "功能建议");
    assert.equal(normalizeFeedbackContent("  hello\\r\\nworld  "), "hello\\nworld");
    await assert.rejects(submitFeedback({ category: "problem", content: " ", appVersion: "test" }), /请填写反馈内容/);
    await assert.rejects(replyToFeedback("test", " ", "open"), /请填写回复内容/);
    console.log("feedback-import-complete");
  `], { cwd: projectRoot, encoding: "utf8", timeout: 5000, windowsHide: true });
  assert.equal(result.error, undefined, `Feedback import kept the process alive: ${result.error?.code}`);
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /feedback-import-complete/);
});

test("feedback initializes once on first session use and reuses its authentication client", () => {
  // Replace only the SDK boundary so exercising session calls never reaches the cloud.
  const isolatedFeedback = compiledFeedback.replace('import cloudbase from "@cloudbase/js-sdk";', `
    const calls = [];
    const authClient = {
      async getSession() { calls.push("getSession"); return { data: { session: { user: { is_anonymous: true } } } }; },
      async signOut() { calls.push("signOut"); return {}; }
    };
    const cloudbase = { init(options) {
      calls.push(["init", options]);
      return { auth() { calls.push("auth"); return authClient; } };
    } };
  `);
  assert.notEqual(isolatedFeedback, compiledFeedback, "SDK test boundary must be replaced");
  const result = spawnSync(process.execPath, ["--input-type=module", "-e", isolatedFeedback + `
    import assert from "node:assert/strict";
    assert.deepEqual(calls, []);
    assert.deepEqual(await ensureFeedbackUserSession(), { isAdminSession: false });
    await ensureFeedbackUserSession();
    await switchToAnonymousFeedback();
    assert.deepEqual(calls, [
      ["init", { env: "cloud-ynnu-d6gs8ekf7dbcbe80e", region: "ap-shanghai", persistence: "local" }],
      "auth", "getSession", "getSession", "signOut", "getSession"
    ]);
  `], { cwd: projectRoot, encoding: "utf8", timeout: 5000, windowsHide: true });
  assert.equal(result.error, undefined);
  assert.equal(result.status, 0, result.stderr);
});

test("feedback client keeps local gift data out of the cloud payload", () => {
  assert.match(feedbackSource, /client_platform: "windows-desktop"/);
  assert.doesNotMatch(feedbackSource, /giftvault|vault_path|person_name|amount_cents|entry_id/i);
  assert.match(feedbackComponent, /请勿填写礼金明细、姓名、金额、地址或礼金库路径/);
});

test("packaged feedback permits the actual CloudBase authentication and database gateway", async () => {
  const config = JSON.parse(await readFile(new URL("../src-tauri/tauri.conf.json", import.meta.url), "utf8"));
  const connect = config.app.security.csp.split(";").find(value => value.trim().startsWith("connect-src ")).trim().split(/\s+/).slice(1);
  assert.ok(connect.includes("https://cloud-ynnu-d6gs8ekf7dbcbe80e.api.tcloudbasegateway.com"), "The packaged CSP must permit the gateway used by the real SDK");
  assert.ok(!connect.includes("https:") && !connect.includes("*"));
});

test("feedback schema binds ownership to CloudBase JWT claims and applies RLS", () => {
  assert.match(schema, /current_setting\('request\.jwt\.claims', true\)::json->>'sub'/);
  assert.match(schema, /ALTER TABLE public\.feedback ENABLE ROW LEVEL SECURITY/);
  assert.match(schema, /ALTER TABLE public\.feedback_replies ENABLE ROW LEVEL SECURITY/);
  assert.match(schema, /CREATE POLICY feedback_select_own/);
  assert.match(schema, /CREATE POLICY feedback_insert_own/);
  assert.match(schema, /CREATE POLICY feedback_admin_all/);
  assert.match(schema, /CREATE POLICY feedback_replies_select_own/);
  assert.match(schema, /CREATE POLICY feedback_replies_admin_all/);
});

test("feedback text validation stays bounded before network submission", () => {
  assert.match(feedbackSource, /if \(!content\) throw new Error\("请填写反馈内容"\)/);
  assert.match(feedbackSource, /content\.length > 4000/);
  assert.match(feedbackSource, /if \(!content\) throw new Error\("请填写回复内容"\)/);
});
