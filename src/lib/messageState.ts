export interface Announcement { id: string; title: string; body: string; revision: number; published_at: string }
export interface AnnouncementDraft { id: string; title: string; body: string; updated_at: string }
export interface FeedbackReplyStatus { id: string; last_replied_at: string | null; status?: string; status_changed_at?: string | null }
export interface MessageReadState { announcements: Record<string, number>; replies: Record<string, string>; statuses?: Record<string, string> }

const READ_KEY = "lijinbook.messages.read.v1";
const CACHE_KEY = "lijinbook.messages.announcements.v1";
export const BUILTIN_GUIDE: Announcement = {
  id: "software-guide", revision: 1, published_at: "2026-11-04T00:00:00Z", title: "欢迎使用礼金簿",
  body: "礼金库保存在你选择的本机文件中，登记、查询和备份均可离线使用。请妥善保存礼金库及备份。\n\n软件更新、公告和反馈消息检查会联网，但不会自动上传礼金库、人物、金额、地址、本机路径或日志。反馈内容由你主动填写，请避免包含隐私信息。\n\n本地管理员 PIN 用于保护礼金库编辑；反馈和公告管理员使用独立的邮箱验证身份。普通用户无需注册即可发送问题反馈、查看自己的反馈及管理员回复。\n\n新公告或新回复会在顶部信件入口提示。公告读完后点击“已读并收起”，以后仍可在此重读。",
};
export function emptyMessageState(): MessageReadState { return { announcements: {}, replies: {}, statuses: {} }; }
function storage(provided?: Pick<Storage, "getItem" | "setItem">) {
  try { return provided ?? window.localStorage; } catch { return undefined; }
}
export function readMessageState(provided?: Pick<Storage, "getItem" | "setItem">): MessageReadState {
  try {
    const value = JSON.parse(storage(provided)?.getItem(READ_KEY) || "null");
    return {
      announcements: Object.fromEntries(Object.entries(value?.announcements ?? {}).filter(([, v]) => Number.isSafeInteger(v) && Number(v) > 0)) as Record<string, number>,
      replies: Object.fromEntries(Object.entries(value?.replies ?? {}).filter(([, v]) => typeof v === "string" && Number.isFinite(Date.parse(v)))) as Record<string, string>,
      statuses: Object.fromEntries(Object.entries(value?.statuses ?? {}).filter(([, v]) => typeof v === "string" && Number.isFinite(Date.parse(v)))) as Record<string, string>,
    };
  } catch { return emptyMessageState(); }
}
export function saveMessageState(state: MessageReadState, provided?: Pick<Storage, "getItem" | "setItem">) {
  try { storage(provided)?.setItem(READ_KEY, JSON.stringify(state)); } catch { /* Keep this run's read state when storage is unavailable. */ }
}
export function announcementUnread(item: Announcement, state: MessageReadState) { return item.revision > (state.announcements[item.id] || 0); }
export function markAnnouncementRead(state: MessageReadState, item: Announcement): MessageReadState {
  return { ...state, announcements: { ...state.announcements, [item.id]: Math.max(item.revision, state.announcements[item.id] || 0) } };
}
export function replyUnread(item: FeedbackReplyStatus, state: MessageReadState) {
  return Boolean(item.last_replied_at && Date.parse(item.last_replied_at) > (Date.parse(state.replies[item.id] || "") || 0));
}
export function markReplyRead(state: MessageReadState, id: string, timestamp: string): MessageReadState {
  if (!Number.isFinite(Date.parse(timestamp)) || Date.parse(timestamp) <= (Date.parse(state.replies[id] || "") || 0)) return state;
  return { ...state, replies: { ...state.replies, [id]: timestamp } };
}
export function statusUnread(item: FeedbackReplyStatus, state: MessageReadState) {
  return Boolean(item.status_changed_at && Date.parse(item.status_changed_at) > (Date.parse(state.statuses?.[item.id] || "") || 0));
}
export function markStatusRead(state: MessageReadState, id: string, timestamp: string): MessageReadState {
  if (!Number.isFinite(Date.parse(timestamp)) || Date.parse(timestamp) <= (Date.parse(state.statuses?.[id] || "") || 0)) return state;
  return { ...state, statuses: { ...state.statuses, [id]: timestamp } };
}
export function readAnnouncementCache(): Announcement[] {
  try {
    const cached: unknown = JSON.parse(storage()?.getItem(CACHE_KEY) || "null");
    if (Array.isArray(cached)) {
      const items = cached.filter((item): item is Announcement => item && typeof item.id === "string" && typeof item.title === "string" && typeof item.body === "string" && Number.isSafeInteger(item.revision) && item.revision > 0 && typeof item.published_at === "string");
      if (items.length) return items;
    }
  } catch { /* The bundled guide remains available offline. */ }
  return [BUILTIN_GUIDE];
}
export function saveAnnouncementCache(items: Announcement[]) { try { storage()?.setItem(CACHE_KEY, JSON.stringify(items)); } catch { /* Nonessential cache. */ } }
