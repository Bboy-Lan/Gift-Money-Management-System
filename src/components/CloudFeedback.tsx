import { useCallback, useEffect, useRef, useState } from "react";
import { Check, MessageSquare, RefreshCw, ShieldCheck } from "lucide-react";
import { FeedbackAdminLogin } from "./FeedbackAdminLogin";
import {
  ensureFeedbackUserSession,
  feedbackCategoryLabel,
  feedbackStatusLabel,
  listFeedback,
  listFeedbackReplies,
  replyToFeedback,
  submitFeedback,
  switchToAnonymousFeedback,
  type CloudFeedback,
  type CloudFeedbackReply,
  type FeedbackCategory,
  type FeedbackStatus,
} from "../lib/cloudFeedback";

function displayTime(value: string) {
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? value : date.toLocaleString("zh-CN", { hour12: false });
}

export function CloudFeedbackPanel({ appVersion }: { appVersion: string }) {
  const [open, setOpen] = useState(false);
  return <section className="settings-panel feedback-settings-panel"><div><strong>意见反馈</strong><p>无需注册，发送反馈或查看回复时联网。仅发送你填写的反馈内容、软件版本和处理状态。不会上传礼金库文件、人物、金额、地址或本机路径。</p></div><button className="secondary-button compact" type="button" onClick={() => setOpen(true)}><MessageSquare size={14} />提交或查看反馈</button>{open && <CloudFeedbackModal appVersion={appVersion} onClose={() => setOpen(false)} />}</section>;
}

export function CloudFeedbackModal({ appVersion, onClose, onSessionChanged, onReplyRead, isReplyUnread, focusFeedbackId, refreshKey, initialAdminLogin = false, inline = false }: {
  appVersion: string; onClose: () => void; onSessionChanged?: () => void;
  onReplyRead?: (id: string, timestamp: string) => void; isReplyUnread?: (id: string, timestamp: string | null) => boolean;
  focusFeedbackId?: string; refreshKey?: string;
  initialAdminLogin?: boolean; inline?: boolean;
}) {
  const [items, setItems] = useState<CloudFeedback[]>([]);
  const [replies, setReplies] = useState<Record<string, CloudFeedbackReply[]>>({});
  const [loading, setLoading] = useState(true);
  const [submitting, setSubmitting] = useState(false);
  const [adminSession, setAdminSession] = useState(false);
  const [adminLoginOpen, setAdminLoginOpen] = useState(initialAdminLogin);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [category, setCategory] = useState<FeedbackCategory>("suggestion");
  const [content, setContent] = useState("");
  const [replyingId, setReplyingId] = useState<string | null>(null);
  const [replyContent, setReplyContent] = useState("");
  const [replyStatus, setReplyStatus] = useState<FeedbackStatus>("in_progress");
  const dialogRoot = useRef<HTMLElement>(null);
  const positionedReply = useRef<string | null>(null);

  const load = useCallback(async (forceAnonymous = false) => {
    setLoading(true);
    setError(null);
    try {
      const session = forceAnonymous ? await switchToAnonymousFeedback() : await ensureFeedbackUserSession();
      setAdminSession(session.isAdminSession);
      const feedback = await listFeedback();
      const replyEntries = await Promise.all(feedback.map(async (item) => [item.id, await listFeedbackReplies(item.id)] as const));
      setItems(feedback);
      setReplies(Object.fromEntries(replyEntries));
    } catch (reason) {
      setAdminSession(false);
      setItems([]);
      setReplies({});
      setError(String(reason).replace(/^Error:\s*/, ""));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { void load(); }, [load, refreshKey]);
  const readCallback = useRef(onReplyRead); readCallback.current = onReplyRead;
  useEffect(() => {
    if (!focusFeedbackId) return;
    const row = Array.from(dialogRoot.current?.querySelectorAll<HTMLElement>("[data-feedback-id]") ?? []).find(item => item.dataset.feedbackId === focusFeedbackId);
    const target = row?.querySelectorAll<HTMLElement>(".feedback-reply");
    const latest = replies[focusFeedbackId]?.at(-1)?.created_at;
    const key = `${focusFeedbackId}:${latest}`;
    if (latest && target?.length && positionedReply.current !== key) {
      target[target.length - 1].scrollIntoView?.({ block: "start", inline: "nearest" });
      positionedReply.current = key;
    }
  }, [focusFeedbackId, replies]);
  useEffect(() => {
    if (adminSession || typeof IntersectionObserver === "undefined") return;
    const observer = new IntersectionObserver(entries => {
      if (document.visibilityState === "hidden") return;
      for (const entry of entries) {
        const element = entry.target as HTMLElement;
        if (entry.isIntersecting && element.dataset.feedbackId && element.dataset.replyTime)
          readCallback.current?.(element.dataset.feedbackId, element.dataset.replyTime);
      }
    }, { threshold: 0.01 });
    const targets = Array.from(dialogRoot.current?.querySelectorAll<HTMLElement>(".feedback-reply[data-reply-time]") ?? []);
    const observeVisible = () => { if (document.visibilityState !== "hidden") { observer.disconnect(); targets.forEach(item => observer.observe(item)); } };
    observeVisible();
    document.addEventListener("visibilitychange", observeVisible);
    return () => { document.removeEventListener("visibilitychange", observeVisible); observer.disconnect(); };
  }, [replies, adminSession]);

  const submit = async () => {
    setSubmitting(true);
    setError(null);
    setNotice(null);
    try {
      await submitFeedback({ category, content, appVersion });
      setContent("");
      setNotice("反馈已提交。管理员回复后会显示在这里。");
      await load();
      onSessionChanged?.();
    } catch (reason) { setError(String(reason).replace(/^Error:\s*/, "")); } finally { setSubmitting(false); }
  };
  const reply = async (feedbackId: string) => {
    setSubmitting(true);
    setError(null);
    try {
      await replyToFeedback(feedbackId, replyContent, replyStatus);
      setReplyContent("");
      setReplyingId(null);
      setNotice("管理员回复已发送。");
      await load();
      onSessionChanged?.();
    } catch (reason) { setError(String(reason).replace(/^Error:\s*/, "")); } finally { setSubmitting(false); }
  };

  return <div className={inline ? "feedback-workbench" : "modal-backdrop"}><section ref={dialogRoot} className={inline ? "feedback-workbench-content" : "modal feedback-modal"} role={inline ? undefined : "dialog"} aria-modal={inline ? undefined : "true"} aria-label="问题反馈">
    <div className="modal-heading"><h3>问题反馈</h3><button className="icon-button" type="button" aria-label="关闭问题反馈" onClick={onClose}>×</button></div>
    <p className="field-hint">无需注册即可提交和查看自己的反馈。反馈服务与礼金库严格分离；网络不可用不影响本地礼金簿。</p>
    {error && <p className="form-error" role="alert">{error}</p>}{notice && <p className="feedback-notice" role="status"><Check size={14} />{notice}</p>}
    <div className="feedback-toolbar"><span className={`feedback-session ${adminSession ? "admin" : ""}`}>{adminSession ? <><ShieldCheck size={14} />云端管理员</> : "普通反馈 · 无需注册"}</span><button className="secondary-button compact" disabled={loading || submitting} type="button" onClick={() => void load()}><RefreshCw size={14} />刷新</button>{adminSession ? <button className="secondary-button compact" disabled={loading || submitting} type="button" onClick={async () => { await load(true); onSessionChanged?.(); }}>退出管理员登录</button> : <button className="secondary-button compact" disabled={submitting} type="button" onClick={() => setAdminLoginOpen(value => !value)}>管理员登录</button>}</div>
    {adminLoginOpen && !adminSession && <FeedbackAdminLogin busy={submitting || loading} onBusyChange={setSubmitting} onAuthenticated={async () => { setAdminLoginOpen(false); setNotice("已验证管理员邮箱，登录有效期内将自动识别。"); await load(); onSessionChanged?.(); }} />}
    {!adminSession && <section className="feedback-compose"><strong>提交反馈</strong><label>类型<select value={category} onChange={event => setCategory(event.target.value as FeedbackCategory)}><option value="suggestion">功能建议</option><option value="problem">问题反馈</option><option value="other">其他</option></select></label><label>内容<textarea value={content} onChange={event => setContent(event.target.value)} maxLength={4000} placeholder="请描述你的建议或遇到的问题；请勿填写礼金明细、姓名、金额、地址或礼金库路径。" /></label><div className="feedback-compose-footer"><span>{content.length}/4000</span><button className="primary-button compact" type="button" disabled={!content.trim() || submitting || loading} onClick={() => void submit()}>提交反馈</button></div></section>}
    <section className="feedback-list" aria-live="polite"><div className="feedback-list-heading"><strong>{adminSession ? "全部反馈" : "我的反馈"}</strong><span>{loading ? "正在读取…" : `${items.length} 条`}</span></div>
      {!loading && items.length === 0 && <p className="field-hint">还没有反馈记录。</p>}
      {items.map(item => {
        const unread = !adminSession && isReplyUnread?.(item.id, item.last_replied_at);
        return <article className={`feedback-item ${unread ? "has-unread-reply" : ""}`} key={item.id} data-feedback-id={item.id} data-unread={unread ? "true" : undefined}>
          <div className="feedback-item-heading"><strong>{feedbackCategoryLabel(item.category)}</strong><div className="feedback-badges">{(replies[item.id]?.length ?? 0) > 0 && <span className="feedback-status replied">已回复</span>}<span className={`feedback-status ${item.status}`}>{feedbackStatusLabel(item.status)}</span>{unread && <span className="message-unread-label">新回复</span>}</div></div>
          <p className="feedback-user-content">{item.content}</p><p className="feedback-version">{item.app_version && <span>版本 {item.app_version}</span>}<span>{displayTime(item.created_at)}</span></p>
          {(replies[item.id] ?? []).map((replyItem, index, all) => <div className="feedback-reply" key={replyItem.id} data-feedback-id={item.id} data-reply-time={index === all.length - 1 ? replyItem.created_at : undefined}><strong>管理员回复</strong><p>{replyItem.content}</p><span>{displayTime(replyItem.created_at)}</span></div>)}
          {adminSession && <div className="feedback-reply-actions">{replyingId === item.id ? <><label>回复后状态<select value={replyStatus} onChange={event => setReplyStatus(event.target.value as FeedbackStatus)}><option value="in_progress">处理中</option><option value="resolved">已处理</option><option value="open">待处理</option></select></label><textarea value={replyContent} onChange={event => setReplyContent(event.target.value)} maxLength={4000} placeholder="填写管理员回复" /><div><button className="secondary-button compact" type="button" onClick={() => { setReplyingId(null); setReplyContent(""); }}>取消</button><button className="primary-button compact" type="button" disabled={!replyContent.trim() || submitting} onClick={() => void reply(item.id)}>发送回复</button></div></> : <button className="secondary-button compact" type="button" disabled={submitting} onClick={() => { setReplyingId(item.id); setReplyStatus(item.status); }}>回复并更新状态</button>}</div>}
        </article>;
      })}
    </section>
  </section></div>;
}
