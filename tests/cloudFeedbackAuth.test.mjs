import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { transform } from "esbuild";

const source = await readFile(new URL("../src/lib/cloudFeedback.ts", import.meta.url), "utf8");
const compiled = (await transform(source, { loader: "ts", format: "esm" })).code.replace('import { installFeedbackTransport } from "./feedbackTransport";', 'const installFeedbackTransport = () => {};').replace('import("./classicFeedback")', 'Promise.resolve({createClassicFeedback: () => ({adminStatus: async () => { rpcCalls.push("feedback_admin_status"); if (roleError) throw new Error(roleError.message); const rows=rolePayload ?? [{is_admin:authorized}]; return Array.isArray(rows) && rows.length === 1 ? rows[0] : {}; }})})');
const root = fileURLToPath(new URL("..", import.meta.url));

function run(assertions, setup = "") {
  const boundary = `
    let session = { user: { is_anonymous: true } };
    let authorized = true;
    let roleError = null;
    let rolePayload;
    let sessionError = null;
    let sent = null;
    let signOuts = 0;
    let anonymousSignIns = 0;
    const rpcCalls = [];
    const authClient = {
      async getSession() { return { data: { session }, error: sessionError }; },
      async signInAnonymously() { anonymousSignIns++; session = { user: { is_anonymous: true } }; return { data: { session } }; },
      async signOut() { signOuts++; session = null; return {}; },
      async signInWithOtp(input) {
        sent = input;
        return { data: { verifyOtp: async ({token}) => {
          if (token !== "123456") return { error: {message: "验证码无效"} };
          session = { user: { is_anonymous: false } };
          return { data: { session } };
        } } };
      }
    };
    const cloudbase = { init() { return { auth() {return authClient;}, rdb() { return {
      async rpc(name) { rpcCalls.push(name); return {data:rolePayload ?? [{is_admin:authorized}],error:roleError}; }
    };} }; } };
    ${setup}
  `;
  const isolated = compiled.replace('import cloudbase from "@cloudbase/js-sdk";', boundary);
  assert.notEqual(isolated, compiled);
  const result = spawnSync(process.execPath, ["--input-type=module", "-e", isolated + `
    import assert from "node:assert/strict";
    ${assertions}
  `], { cwd: root, encoding: "utf8", timeout: 5000, windowsHide: true });
  assert.equal(result.error?.code, undefined);
  assert.equal(result.status, 0, result.stderr);
}

test("email OTP is bound to a normalized email and requires the server administrator allow-list", () => {
  run(`
    const challenge = await requestFeedbackAdminCode(" Admin@Example.test ");
    assert.deepEqual(sent, {email:"admin@example.test",options:{shouldCreateUser:false}});
    assert.deepEqual(rpcCalls, []);
    await challenge.verify("123456");
    assert.deepEqual(rpcCalls, ["feedback_admin_status"]);
    assert.equal((await ensureFeedbackUserSession()).isAdminSession, true);
    assert.equal(signOuts, 0);
  `);
});

test("verified email without administrator permission is signed out and returns to anonymous feedback", () => {
  run(`
    const challenge = await requestFeedbackAdminCode("member@example.test");
    await assert.rejects(challenge.verify("123456"), /未获管理员授权/);
    assert.equal(signOuts, 1);
    assert.equal(anonymousSignIns, 1);
    assert.deepEqual(await ensureFeedbackUserSession(), {isAdminSession:false});
  `, "authorized = false;");
});

test("a remembered non-anonymous session is checked against the allow-list", () => {
  run(`
    assert.deepEqual(await ensureFeedbackUserSession(), {isAdminSession:false});
    assert.deepEqual(rpcCalls, ["feedback_admin_status"]);
    assert.equal(signOuts, 1);
  `, "session = {user:{is_anonymous:false}}; authorized = false;");
});

test("a first launch with the SDK unauthenticated result creates anonymous feedback", () => {
  run(`
    assert.deepEqual(await ensureFeedbackUserSession(), {isAdminSession:false});
    assert.equal(anonymousSignIns, 1);
    assert.equal(signOuts, 0);
  `, "session = null; sessionError = {code:'unauthenticated',message:'credentials not found'};");
});

test("a session transport failure does not replace the remembered identity", () => {
  run(`
    await assert.rejects(ensureFeedbackUserSession(), /网络不可用/);
    assert.equal(anonymousSignIns, 0);
    assert.equal(signOuts, 0);
  `, "session = null; sessionError = {code:'network_error',message:'网络不可用'};");
});

test("simultaneous first-use requests share one anonymous sign-in", () => {
  run(`
    await Promise.all([ensureFeedbackUserSession(),ensureFeedbackUserSession()]);
    assert.equal(anonymousSignIns,1);
  `, "session = null; sessionError = {code:'unauthenticated',message:'credentials not found'};");
});

test("administrator role lookup errors never grant administrator access", () => {
  run(`
    const challenge = await requestFeedbackAdminCode("admin@example.test");
    await assert.rejects(challenge.verify("123456"), /权限服务不可用/);
  `, "roleError = {message:'权限服务不可用'};");
});

test("malformed role responses never grant administrator access", () => {
  run(`
    const challenge = await requestFeedbackAdminCode("admin@example.test");
    await assert.rejects(challenge.verify("123456"), /权限响应/);
  `, "rolePayload = {is_admin:true};");
});

test("invalid email and OTP are rejected before sending or exchanging them", () => {
  run(`
    await assert.rejects(requestFeedbackAdminCode("not-an-email"), /邮箱/);
    assert.equal(sent, null);
    const challenge = await requestFeedbackAdminCode("admin@example.test");
    await assert.rejects(challenge.verify("12abc6"), /6 位数字/);
    assert.deepEqual(rpcCalls, []);
    await assert.rejects(challenge.verify("654321"), /验证码无效/);
    assert.deepEqual(rpcCalls, []);
  `);
});
