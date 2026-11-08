import cloudbase from "@cloudbase/js-sdk";
import { installFeedbackTransport } from "./feedbackTransport";
import type { Announcement, AnnouncementDraft, FeedbackReplyStatus } from "./messageState";

// The original backend remains intact for future historical-data migration.
const USE_CLASSIC_FEEDBACK = true;
const CLOUDBASE_ENV_ID = USE_CLASSIC_FEEDBACK ? "cloud-yunda-d5gxrar1s14b2ee0d" : "cloud-ynnu-d6gs8ekf7dbcbe80e";

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
  status_changed_at: string | null;
}

export interface CloudFeedbackReply {
  id: string;
  feedback_id: string;
  content: string;
  created_at: string;
}
export interface RecycledFeedback { id: string; category: FeedbackCategory; content: string; deleted_at: string }

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
  rpc: <T = unknown>(name: string, args?: Record<string, unknown>) => Promise<CloudResult<T>>;
};

export interface FeedbackAdminCodeChallenge {
  verify: (code: string) => Promise<void>;
}

type CloudApp = ReturnType<typeof cloudbase.init>;
let feedbackClient: { app: CloudApp; auth: ReturnType<CloudApp["auth"]> } | undefined;
let sessionRequest: Promise<{ isAdminSession: boolean }> | undefined;

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
async function classic() {
  const { createClassicFeedback } = await import("./classicFeedback");
  return createClassicFeedback(client().app as unknown as Parameters<typeof createClassicFeedback>[0]);
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

export function ensureFeedbackUserSession(): Promise<{ isAdminSession: boolean }> {
  if (!sessionRequest) sessionRequest = restoreFeedbackUserSession().finally(() => { sessionRequest = undefined; });
  return sessionRequest;
}

async function restoreFeedbackUserSession(): Promise<{ isAdminSession: boolean }> {
  const { auth } = client();
  const current = await auth.getSession();
  // The SDK reports a missing first-use credential as an auth error, not a null session.
  if (current.error && (current.error.code !== "unauthenticated" || current.data?.session)) {
    throw new Error(current.error.message || "无法读取反馈登录状态");
  }
  if (current.data?.session) {
    if (sessionIsAnonymous(current.data.session)) return { isAdminSession: false };
    if (await isFeedbackAdmin()) return { isAdminSession: true };
    const signedOut = await auth.signOut();
    if (signedOut && "error" in signedOut && signedOut.error) throw new Error((signedOut.error as { message?: string }).message || "无法切换普通反馈身份");
  }
  const signedIn = await auth.signInAnonymously();
  if (signedIn.error) throw new Error(signedIn.error.message || "无法建立匿名反馈会话");
  return { isAdminSession: false };
}

async function isFeedbackAdmin() {
  if (USE_CLASSIC_FEEDBACK) {
    const result = await (await classic()).adminStatus();
    if (typeof result?.is_admin !== "boolean") throw new Error("管理员权限响应无效，请稍后重试");
    return result.is_admin;
  }
  const rows = readResult(await database().rpc<{ is_admin: boolean }[]>("feedback_admin_status"));
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
  await sessionRequest?.catch(() => undefined);
  const { auth } = client();
  const signedOut = await auth.signOut();
  if (signedOut && "error" in signedOut && signedOut.error) throw new Error((signedOut.error as { message?: string }).message || "无法退出管理员反馈会话");
  return ensureFeedbackUserSession();
}

export async function listFeedback() {
  if (USE_CLASSIC_FEEDBACK) return (await classic()).list();
  const result = await database().from("feedback").select("id,category,content,app_version,status,created_at,updated_at,last_replied_at,status_changed_at").order("created_at", { ascending: false });
  return readResult(result as CloudResult<CloudFeedback[]>);
}

export async function listFeedbackReplies(feedbackId: string) {
  if (USE_CLASSIC_FEEDBACK) return (await classic()).replies(feedbackId);
  const result = await database().from("feedback_replies").select("id,feedback_id,content,created_at").eq("feedback_id", feedbackId).order("created_at", { ascending: true });
  return readResult(result as CloudResult<CloudFeedbackReply[]>);
}

export async function submitFeedback(input: { category: FeedbackCategory; content: string; appVersion: string }) {
  const content = normalizeFeedbackContent(input.content);
  if (!content) throw new Error("请填写反馈内容");
  if (content.length > 4000) throw new Error("反馈内容不能超过 4000 个字符");
  if (USE_CLASSIC_FEEDBACK) { await (await classic()).submit({...input, content}); return; }
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
  if (USE_CLASSIC_FEEDBACK) { await (await classic()).reply(feedbackId,content,status); return; }
  ensureSuccess(await database().from("feedback_replies").insert({ feedback_id: feedbackId, content }));
  ensureSuccess(await database().from("feedback").update({ status }).eq("id", feedbackId));
}

export async function updateFeedbackStatus(feedbackId: string, status: FeedbackStatus) {
  if (!["open", "in_progress", "resolved"].includes(status)) throw new Error("处理状态无效");
  if (USE_CLASSIC_FEEDBACK) { await (await classic()).status(feedbackId,status); return; }
  ensureSuccess(await database().from("feedback").update({ status }).eq("id", feedbackId));
}

export async function deleteFeedback(feedbackId: string) {
  if (USE_CLASSIC_FEEDBACK) { await (await classic()).recycle(feedbackId); return; }
  const rows = readResult(await database().rpc<{ success: boolean }[]>("feedback_recycle", { p_id: feedbackId, p_restore: false }));
  if (!rows[0]?.success) throw new Error("反馈不存在或已被删除，请刷新后重试");
}
export async function restoreFeedback(feedbackId: string) {
  if (USE_CLASSIC_FEEDBACK) { await (await classic()).restore(feedbackId); return; }
  const rows = readResult(await database().rpc<{ success: boolean }[]>("feedback_recycle", { p_id: feedbackId, p_restore: true }));
  if (!rows[0]?.success) throw new Error("反馈不存在或已恢复，请刷新后重试");
}
export async function listRecycledFeedback() {
  if (USE_CLASSIC_FEEDBACK) return (await classic()).recycled();
  return readResult(await database().rpc<RecycledFeedback[]>("feedback_recycled_list"));
}

export async function listAnnouncements() {
  if (USE_CLASSIC_FEEDBACK) return (await classic()).announcements();
  return readResult(await database().from("announcements").select("id,title,body,revision,published_at").order("published_at", { ascending: false }) as CloudResult<Announcement[]>);
}
export async function listAnnouncementDrafts() {
  if (USE_CLASSIC_FEEDBACK) return (await classic()).drafts();
  return readResult(await database().from("announcement_drafts").select("id,title,body,updated_at").order("updated_at", { ascending: false }) as CloudResult<AnnouncementDraft[]>);
}
export async function listFeedbackReplyStatus() {
  if (USE_CLASSIC_FEEDBACK) return (await classic()).replyStatus();
  return readResult(await database().from("feedback").select("id,last_replied_at,status,status_changed_at").order("last_replied_at", { ascending: false }) as CloudResult<FeedbackReplyStatus[]>);
}
export async function saveAnnouncementDraft(input: { id?: string; title: string; body: string }) {
  const title = input.title.trim(), body = input.body.trim();
  if (!title || title.length > 120) throw new Error("公告标题须为 1 至 120 个字符");
  if (!body || body.length > 8000) throw new Error("公告正文须为 1 至 8000 个字符");
  if (USE_CLASSIC_FEEDBACK) return (await classic()).saveDraft({...input,title,body});
  const rows = readResult(await database().rpc<AnnouncementDraft[]>("save_announcement_draft", { p_id: input.id ?? null, p_title: title, p_body: body }));
  if (!Array.isArray(rows) || rows.length !== 1) throw new Error("公告草稿保存结果无效");
  return rows[0];
}
export async function publishAnnouncement(id: string) {
  if (USE_CLASSIC_FEEDBACK) return (await classic()).publish(id);
  const rows = readResult(await database().rpc<Announcement[]>("publish_announcement", { p_id: id }));
  if (!Array.isArray(rows) || rows.length !== 1) throw new Error("公告发布结果无效");
  return rows[0];
}
