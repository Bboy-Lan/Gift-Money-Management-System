import cloudbase from "@cloudbase/js-sdk";

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

type CloudDatabase = { from: (table: string) => CloudQuery };

type CloudApp = ReturnType<typeof cloudbase.init>;
let feedbackClient: { app: CloudApp; auth: ReturnType<CloudApp["auth"]> } | undefined;

function client() {
  if (!feedbackClient) {
    const app = cloudbase.init({ env: CLOUDBASE_ENV_ID, region: "ap-shanghai" });
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

export async function ensureFeedbackUserSession() {
  const { auth } = client();
  const current = await auth.getSession();
  if (current.error) throw new Error(current.error.message || "无法读取反馈登录状态");
  if (current.data?.session) return { isAdminSession: !sessionIsAnonymous(current.data.session) };
  const signedIn = await auth.signInAnonymously();
  if (signedIn.error) throw new Error(signedIn.error.message || "无法建立匿名反馈会话");
  return { isAdminSession: false };
}

export async function signInFeedbackAdmin(username: string, password: string) {
  const { auth } = client();
  const result = await auth.signInWithPassword({ username: username.trim(), password });
  if (result.error) throw new Error(result.error.message || "管理员登录失败");
  if (!result.data?.session) throw new Error("管理员登录未建立有效会话");
  return true;
}

export async function switchToAnonymousFeedback() {
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
