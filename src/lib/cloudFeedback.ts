import cloudbase from "@cloudbase/js-sdk";
import { installFeedbackTransport } from "./feedbackTransport";

const CLOUDBASE_ENV_ID = "cloud-ynnu-d6gs8ekf7dbcbe80e";

export type FeedbackCategory = "suggestion" | "problem" | "other";
export type FeedbackStatus = "open" | "in_progress" | "resolved";

export interface CloudFeedback {
  id: string;
  category: FeedbackCategory;
  content: string;
  app_version: string;
  status: FeedbackStatus;
  created_at: string;
  updated_at: string;
  last_replied_at: string | null;
}

export interface CloudFeedbackReply {
  id: string;
  feedback_id: string;
  content: string;
  created_at: string;
}

type CloudResult<T> = { data: T | null; error: { message?: string } | null };
type CloudQuery = {
  select: (columns?: string) => CloudQuery;
  insert: (value: Record<string, unknown>) => Promise<CloudResult<unknown>>;
  update: (value: Record<string, unknown>) => CloudQuery;
  eq: (column: string, value: string) => CloudQuery;
  order: (column: string, options?: { ascending?: boolean }) => Promise<CloudResult<unknown>>;
  then: <TResult1 = CloudResult<unknown>, TResult2 = never>(
    onfulfilled?: ((value: CloudResult<unknown>) => TResult1 | PromiseLike<TResult1>) | null,
    onrejected?: ((reason: unknown) => TResult2 | PromiseLike<TResult2>) | null,
  ) => Promise<TResult1 | TResult2>;
};

type CloudDatabase = {
  from: (table: string) => CloudQuery;
  rpc: (name: string) => Promise<CloudResult<{ is_admin: boolean }[]>>;
};

export interface FeedbackAdminCodeChallenge {
  verify: (code: string) => Promise<void>;
}

type CloudApp = ReturnType<typeof cloudbase.init>;
let feedbackClient: { app: CloudApp; auth: ReturnType<CloudApp["auth"]> } | undefined;

function client() {
  if (!feedbackClient) {
    installFeedbackTransport(cloudbase);
    const app = cloudbase.init({ env: CLOUDBASE_ENV_ID, region: "ap-shanghai", persistence: "local" });
    feedbackClient = { app, auth: app.auth() };
  }
  return feedbackClient;
}

function database(): CloudDatabase {
  return (client().app as unknown as { rdb: () => CloudDatabase }).rdb();
}

function ensureSuccess<T>(result: CloudResult<T>) {
  if (result.error) throw new Error(result.error.message || "云端反馈服务暂不可用");
}

function readResult<T>(result: CloudResult<T>): T {
  ensureSuccess(result);
  if (result.data === null) throw new Error("云端反馈服务没有返回结果");
  return result.data;
}

function sessionIsAnonymous(session: unknown) {
  return Boolean((session as { user?: { is_anonymous?: boolean } } | null)?.user?.is_anonymous);
}

export function feedbackCategoryLabel(category: FeedbackCategory) {
  if (category === "suggestion") return "功能建议";
  if (category === "problem") return "问题反馈";
  return "其他";
}

export function feedbackStatusLabel(status: FeedbackStatus) {
  if (status === "in_progress") return "处理中";
  if (status === "resolved") return "已处理";
  return "待处理";
}

export function normalizeFeedbackContent(value: string) {
  return value.trim().replace(/\r\n/g, "\n");
}

export async function ensureFeedbackUserSession(): Promise<{ isAdminSession: boolean }> {
  const { auth } = client();
  const current = await auth.getSession();
  // The SDK reports a missing first-use credential as an auth error, not a null session.
  if (current.error && (current.error.code !== "unauthenticated" || current.data?.session)) {
    throw new Error(current.error.message || "无法读取反馈登录状态");
  }
  if (current.data?.session) {
    if (sessionIsAnonymous(current.data.session)) return { isAdminSession: false };
    if (await isFeedbackAdmin()) return { isAdminSession: true };
    return switchToAnonymousFeedback();
  }
  const signedIn = await auth.signInAnonymously();
  if (signedIn.error) throw new Error(signedIn.error.message || "无法建立匿名反馈会话");
  return { isAdminSession: false };
}

async function isFeedbackAdmin() {
  const rows = readResult(await database().rpc("feedback_admin_status"));
  if (!Array.isArray(rows) || rows.length !== 1 || typeof rows[0]?.is_admin !== "boolean") {
    throw new Error("管理员权限响应无效，请稍后重试");
  }
  return rows[0].is_admin;
}

export async function requestFeedbackAdminCode(emailInput: string): Promise<FeedbackAdminCodeChallenge> {
  const email = emailInput.trim().toLowerCase();
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) || email.length > 254) throw new Error("请填写有效的管理员邮箱");
  const { auth } = client();
  const result = await auth.signInWithOtp({ email, options: { shouldCreateUser: false } });
  if (result.error) throw new Error(result.error.message || "管理员验证码发送失败");
  const verifyOtp = result.data?.verifyOtp;
  if (!verifyOtp) throw new Error("未能建立邮箱验证码验证，请重新获取验证码");
  return {
    verify: async (codeInput: string) => {
      const code = codeInput.trim();
      if (!/^\d{6}$/.test(code)) throw new Error("请填写 6 位数字验证码");
      const verified = await verifyOtp({ token: code });
      if (verified.error) throw new Error(verified.error.message || "验证码验证失败");
      if (!verified.data?.session) throw new Error("管理员登录未建立有效会话");
      if (!await isFeedbackAdmin()) {
        await switchToAnonymousFeedback();
        throw new Error("该邮箱未获管理员授权，已返回普通反馈模式");
      }
    },
  };
}

export async function switchToAnonymousFeedback(): Promise<{ isAdminSession: boolean }> {
  const { auth } = client();
  const signedOut = await auth.signOut();
  if (signedOut && "error" in signedOut && signedOut.error) throw new Error((signedOut.error as { message?: string }).message || "无法退出管理员反馈会话");
  return ensureFeedbackUserSession();
}

export async function listFeedback() {
  const result = await database().from("feedback").select("id,category,content,app_version,status,created_at,updated_at,last_replied_at").order("created_at", { ascending: false });
  return readResult(result as CloudResult<CloudFeedback[]>);
}

export async function listFeedbackReplies(feedbackId: string) {
  const result = await database().from("feedback_replies").select("id,feedback_id,content,created_at").eq("feedback_id", feedbackId).order("created_at", { ascending: true });
  return readResult(result as CloudResult<CloudFeedbackReply[]>);
}

export async function submitFeedback(input: { category: FeedbackCategory; content: string; appVersion: string }) {
  const content = normalizeFeedbackContent(input.content);
  if (!content) throw new Error("请填写反馈内容");
  if (content.length > 4000) throw new Error("反馈内容不能超过 4000 个字符");
  const result = await database().from("feedback").insert({
    category: input.category,
    content,
    app_version: input.appVersion,
    client_platform: "windows-desktop",
  });
  ensureSuccess(result);
}

export async function replyToFeedback(feedbackId: string, contentInput: string, status: FeedbackStatus) {
  const content = normalizeFeedbackContent(contentInput);
  if (!content) throw new Error("请填写回复内容");
  if (content.length > 4000) throw new Error("回复内容不能超过 4000 个字符");
  ensureSuccess(await database().from("feedback_replies").insert({ feedback_id: feedbackId, content }));
  ensureSuccess(await database().from("feedback").update({ status, last_replied_at: new Date().toISOString() }).eq("id", feedbackId));
}
