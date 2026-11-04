import { createContext, useCallback, useContext, useEffect, useRef, useState, type ReactNode } from "react";
import { ensureFeedbackUserSession, listAnnouncements, listFeedbackReplyStatus } from "../lib/cloudFeedback";
import { announcementUnread, BUILTIN_GUIDE, markAnnouncementRead, markReplyRead, readAnnouncementCache, readMessageState, replyUnread, saveAnnouncementCache, saveMessageState, type Announcement, type FeedbackReplyStatus, type MessageReadState } from "../lib/messageState";

interface Messages {
  announcements: Announcement[]; readState: MessageReadState; replyStatus: FeedbackReplyStatus[];
  isAdmin: boolean; refreshing: boolean; error: string | null;
  replyAlert: FeedbackReplyStatus | null; dismissReplyAlert: () => void;
  unreadAnnouncements: number; unreadReplies: number;
  inboxOpen: boolean; inboxTab: "announcements" | "replies"; feedbackOpen: boolean; focusFeedbackId?: string;
  adminLoginRequested: boolean; openAdminLogin: () => void;
  openInbox: () => void; closeInbox: () => void; setInboxTab: (tab: "announcements" | "replies") => void;
  openFeedback: (id?: string) => void; closeFeedback: () => void;
  readAnnouncement: (item: Announcement) => void; readReply: (id: string, timestamp: string) => void;
  refresh: (startup?: boolean) => Promise<void>;
  refreshAfterSessionChange: () => Promise<void>;
}
const MessageContext = createContext<Messages | null>(null);
export function useMessages() { return useContext(MessageContext); }

export function MessageCenterProvider({ children }: { children: ReactNode }) {
  const [announcements, setAnnouncements] = useState(readAnnouncementCache);
  const [readState, setReadState] = useState(readMessageState);
  const [replyStatus, setReplyStatus] = useState<FeedbackReplyStatus[]>([]);
  const [replyAlert, setReplyAlert] = useState<FeedbackReplyStatus | null>(null);
  const alertedReplies = useRef(new Set<string>());
  const [isAdmin, setAdmin] = useState(false);
  const [refreshing, setRefreshing] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [inboxOpen, setInboxOpen] = useState(() => readAnnouncementCache().some(item => announcementUnread(item, readMessageState())));
  const [inboxTab, setInboxTab] = useState<"announcements" | "replies">("announcements");
  const [feedbackOpen, setFeedbackOpen] = useState(false);
  const [adminLoginRequested, setAdminLoginRequested] = useState(false);
  const [focusFeedbackId, setFocusFeedbackId] = useState<string>();
  const readRef = useRef(readState); readRef.current = readState;
  const dismissed = useRef(false), alive = useRef(true);
  const pending = useRef<Promise<void> | null>(null);
  useEffect(() => saveMessageState(readState), [readState]);
  const refresh = useCallback((startup = false): Promise<void> => {
    if (pending.current) return pending.current;
    setRefreshing(true);
    pending.current = (async () => {
      try {
        const session = await ensureFeedbackUserSession();
        const [notices, replies] = await Promise.allSettled([listAnnouncements(), session.isAdminSession ? Promise.resolve([]) : listFeedbackReplyStatus()]);
        if (!alive.current) return;
        setAdmin(session.isAdminSession);
        if (notices.status === "fulfilled") {
          const items = notices.value.some(item => item.id === BUILTIN_GUIDE.id) ? notices.value : [...notices.value, BUILTIN_GUIDE];
          setAnnouncements(items); saveAnnouncementCache(items);
          if (startup && !dismissed.current && items.some(item => announcementUnread(item, readRef.current))) { setInboxTab("announcements"); setInboxOpen(true); }
        }
        if (replies.status === "fulfilled") {
          setReplyStatus(replies.value);
          const unread = replies.value.filter(item => replyUnread(item, readRef.current));
          const fresh = unread.find(item => !alertedReplies.current.has(`${item.id}:${item.last_replied_at}`));
          for (const item of unread) alertedReplies.current.add(`${item.id}:${item.last_replied_at}`);
          if (fresh) setReplyAlert(fresh);
        }
        setError(notices.status === "rejected" || replies.status === "rejected" ? "部分消息暂未同步，已保留本机缓存。请检查网络后重试。" : null);
      } catch {
        if (alive.current) setError("消息暂时无法同步，已保留本机缓存；不影响本地礼金簿。");
      } finally { pending.current = null; if (alive.current) setRefreshing(false); }
    })();
    return pending.current;
  }, []);
  useEffect(() => {
    alive.current = true;
    void refresh(true);
    const check = () => { if (document.visibilityState !== "hidden") void refresh(); };
    const timer = window.setInterval(check, 60_000);
    window.addEventListener("focus", check); document.addEventListener("visibilitychange", check);
    return () => { alive.current = false; window.clearInterval(timer); window.removeEventListener("focus", check); document.removeEventListener("visibilitychange", check); };
  }, [refresh]);
  const unreadAnnouncements = announcements.filter(item => announcementUnread(item, readState)).length;
  const unreadReplies = replyStatus.filter(item => replyUnread(item, readState)).length;
  const closeInbox = () => { dismissed.current = true; setInboxOpen(false); };
  return <MessageContext.Provider value={{ announcements, readState, replyStatus, replyAlert, dismissReplyAlert: () => setReplyAlert(null), isAdmin, refreshing, error, unreadAnnouncements, unreadReplies,
    inboxOpen, inboxTab, setInboxTab, feedbackOpen, focusFeedbackId, adminLoginRequested,
    openInbox: () => { setInboxTab(unreadAnnouncements || !unreadReplies ? "announcements" : "replies"); setInboxOpen(true); }, closeInbox,
    openFeedback: id => { closeInbox(); setAdminLoginRequested(false); setFocusFeedbackId(id); setFeedbackOpen(true); }, closeFeedback: () => setFeedbackOpen(false),
    openAdminLogin: () => { closeInbox(); setAdminLoginRequested(true); setFocusFeedbackId(undefined); setFeedbackOpen(true); },
    readAnnouncement: item => { setReadState(previous => markAnnouncementRead(previous, item)); closeInbox(); },
    readReply: (id, timestamp) => setReadState(previous => markReplyRead(previous, id, timestamp)), refresh,
    refreshAfterSessionChange: async () => { await pending.current; if (alive.current) await refresh(); },
  }}>{children}</MessageContext.Provider>;
}
