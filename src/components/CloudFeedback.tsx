import { useCallback, useEffect, useRef, useState } from "react";
import { Check, MessageSquare, RefreshCw, ShieldCheck } from "lucide-react";
import { FeedbackAdminLogin } from "./FeedbackAdminLogin";
import {
  ensureFeedbackUserSession,
  deleteFeedback,
  restoreFeedback,
  listRecycledFeedback,
  feedbackCategoryLabel,
  feedbackStatusLabel,
  listFeedback,
  listFeedbackReplies,
  replyToFeedback,
  submitFeedback,
  switchToAnonymousFeedback,
  updateFeedbackStatus,
  type CloudFeedback,
  type CloudFeedbackReply,
  type FeedbackCategory,
  type FeedbackStatus,
  type RecycledFeedback,
} from "../lib/cloudFeedback";

function displayTime(value: string) {
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? value : date.toLocaleString("zh-CN", { hour12: false });
}

export function CloudFeedbackPanel({ appVersion }: { appVersion: string }) {
  const [open, setOpen] = useState(false);
  return <section className="settings-panel feedback-settings-panel"><div><strong>意见反馈</strong><p>无需注册，发送反馈或查看回复时联网。仅发送你填写的反馈内容、软件版本和处理状态。不会上传礼金库文件、人物、金额、地址或本机路径。</p></div><button className="secondary-button compact" type="button" onClick={() => setOpen(true)}><MessageSquare size={14} />提交或查看反馈</button>{open && <CloudFeedbackModal appVersion={appVersion} onClose={() => setOpen(false)} />}</section>;
}

export function CloudFeedbackModal({ appVersion, onClose, onSessionChanged, onReplyRead, isReplyUnread, onStatusRead, isStatusUnread, focusFeedbackId, focusFeedbackKind = "reply", refreshKey, initialAdminLogin = false, inline = false }: {
  appVersion: string; onClose: () => void; onSessionChanged?: () => void;
  onReplyRead?: (id: string, timestamp: string) => void; isReplyUnread?: (id: string, timestamp: string | null) => boolean;
  onStatusRead?: (id: string, timestamp: string) => void; isStatusUnread?: (id: string, timestamp: string | null) => boolean;
  focusFeedbackId?: string; focusFeedbackKind?: "reply" | "status"; refreshKey?: string;
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
  const [replyStatus, setReplyStatus] = useState<FeedbackStatus | null>(null);
  const [statusOnly, setStatusOnly] = useState(false);
  const [collapsed, setCollapsed] = useState<Set<string>>(new Set());
  const [deleteConfirmId, setDeleteConfirmId] = useState<string | null>(null);
  const [recycleOpen, setRecycleOpen] = useState(false);
  const [recycled, setRecycled] = useState<RecycledFeedback[]>([]);
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
  const readStatusCallback = useRef(onStatusRead); readStatusCallback.current = onStatusRead;
  useEffect(() => {
    if (!focusFeedbackId) return;
    const row = Array.from(dialogRoot.current?.querySelectorAll<HTMLElement>("[data-feedback-id]") ?? []).find(item => item.dataset.feedbackId === focusFeedbackId);
    if (focusFeedbackKind === "status" && row) { const key = `status:${focusFeedbackId}`; if (positionedReply.current !== key) { row.scrollIntoView?.({ block: "start", inline: "nearest" }); positionedReply.current = key; } return; }
    const target = row?.querySelectorAll<HTMLElement>(".feedback-reply");
    const latest = replies[focusFeedbackId]?.at(-1)?.created_at;
    const key = `${focusFeedbackId}:${latest}`;
    if (latest && target?.length && positionedReply.current !== key) {
      target[target.length - 1].scrollIntoView?.({ block: "start", inline: "nearest" });
      positionedReply.current = key;
    }
  }, [focusFeedbackId, focusFeedbackKind, replies, items]);
  useEffect(() => {
    if (adminSession || typeof IntersectionObserver === "undefined") return;
    const observer = new IntersectionObserver(entries => {
      if (document.visibilityState === "hidden") return;
      for (const entry of entries) {
        const element = entry.target as HTMLElement;
        if (entry.isIntersecting && element.dataset.feedbackId && element.dataset.replyTime)
          readCallback.current?.(element.dataset.feedbackId, element.dataset.replyTime);
        if (entry.isIntersecting && element.dataset.feedbackId && element.dataset.statusTime)
          readStatusCallback.current?.(element.dataset.feedbackId, element.dataset.statusTime);
      }
    }, { threshold: 0.01 });
    const targets = Array.from(dialogRoot.current?.querySelectorAll<HTMLElement>(".feedback-reply[data-reply-time], .feedback-status[data-status-time]") ?? []);
    const observeVisible = () => { if (document.visibilityState !== "hidden") { observer.disconnect(); targets.forEach(item => observer.observe(item)); } };
    observeVisible();
    document.addEventListener("visibilitychange", observeVisible);
    return () => { document.removeEventListener("visibilitychange", observeVisible); observer.disconnect(); };
  }, [replies, items, adminSession, collapsed]);

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
    if (!replyStatus) return;
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
  const saveStatus = async (feedbackId: string) => {
    if (!replyStatus) return;
    setSubmitting(true); setError(null); setNotice(null);
    try { await updateFeedbackStatus(feedbackId, replyStatus); setReplyingId(null); setNotice("处理状态已更新。"); await load(); onSessionChanged?.(); }
    catch (reason) { setError(String(reason).replace(/^Error:\s*/, "")); } finally { setSubmitting(false); }
  };
  const recycle = async (id: string) => {
    setSubmitting(true); setError(null); setNotice(null);
    try { await deleteFeedback(id); setDeleteConfirmId(null); setNotice("反馈已移入回收站，可随时恢复。"); await load(); onSessionChanged?.(); }
    catch (reason) { setError(String(reason).replace(/^Error:\s*/, "")); } finally { setSubmitting(false); }
  };
  const showRecycle = async () => {
    if (recycleOpen) { setRecycleOpen(false); return; }
    setSubmitting(true); setError(null);
    try { setRecycled(await listRecycledFeedback()); setRecycleOpen(true); }
    catch (reason) { setError(String(reason).replace(/^Error:\s*/, "")); } finally { setSubmitting(false); }
  };
  const restore = async (id: string) => {
    setSubmitting(true); setError(null);
    try { await restoreFeedback(id); setRecycled(await listRecycledFeedback()); setNotice("反馈已恢复。"); await load(); }
    catch (reason) { setError(String(reason).replace(/^Error:\s*/, "")); } finally { setSubmitting(false); }
  };

  return <div className={inline ? "feedback-workbench" : "modal-backdrop"}><section ref={dialogRoot} className={inline ? "feedback-workbench-content" : "modal feedback-modal"} role={inline ? undefined : "dialog"} aria-modal={inline ? undefined : "true"} aria-label="问题反馈">
    <div className="modal-heading"><h3>问题反馈</h3><button className="icon-button" type="button" aria-label="关闭问题反馈" onClick={onClose}>×</button></div>
    <p className="field-hint">无需注册即可提交和查看自己的反馈。反馈服务与礼金库严格分离；网络不可用不影响本地礼金簿。</p>
    {error && <p className="form-error" role="alert">{error}</p>}{notice && <p className="feedback-notice" role="status"><Check size={14} />{notice}</p>}
    <div className="feedback-toolbar"><span className={`feedback-session ${adminSession ? "admin" : ""}`}>{adminSession ? <><ShieldCheck size={14} />云端管理员</> : "普通反馈 · 无需注册"}</span><button className="secondary-button compact" disabled={loading || submitting} type="button" onClick={() => void load()}><RefreshCw size={14} />刷新</button>{adminSession ? <button className="secondary-button compact" disabled={loading || submitting} type="button" onClick={async () => { await load(true); onSessionChanged?.(); }}>退出管理员登录</button> : <button className="secondary-button compact" disabled={submitting} type="button" onClick={() => setAdminLoginOpen(value => !value)}>管理员登录</button>}</div>
    {adminLoginOpen && !adminSession && <FeedbackAdminLogin busy={submitting || loading} onBusyChange={setSubmitting} onAuthenticated={async () => { setAdminLoginOpen(false); setNotice("已验证管理员邮箱，登录有效期内将自动识别。"); await load(); onSessionChanged?.(); }} />}
    {!adminSession && <section className="feedback-compose"><strong>提交反馈</strong><label>类型<select value={category} onChange={event => setCategory(event.target.value as FeedbackCategory)}><option value="suggestion">功能建议</option><option value="problem">问题反馈</option><option value="other">其他</option></select></label><label>内容<textarea value={content} onChange={event => setContent(event.target.value)} maxLength={4000} placeholder="请描述你的建议或遇到的问题；请勿填写礼金明细、姓名、金额、地址或礼金库路径。" /></label><div className="feedback-compose-footer"><span>{content.length}/4000</span><button className="primary-button compact" type="button" disabled={!content.trim() || submitting || loading} onClick={() => void submit()}>提交反馈</button></div></section>}
    {adminSession && <section className="feedback-overview" aria-label="反馈总览"><div className="feedback-overview-heading"><strong>反馈总览</strong><button className="secondary-button compact" type="button" disabled={submitting || loading} onClick={() => void showRecycle()}>{recycleOpen ? "关闭回收站" : "反馈回收站"}</button></div><div className="feedback-overview-grid">{[["全部反馈", items.length], ["已回复", items.filter(item => (replies[item.id]?.length ?? 0) > 0).length], ["待处理", items.filter(item => item.status === "open").length], ["处理中", items.filter(item => item.status === "in_progress").length], ["已处理", items.filter(item => item.status === "resolved").length]].map(([label, count]) => <div key={label}><span>{label}</span><strong>{count}</strong></div>)}</div><small>按反馈条数统计；回复情况与处理状态分别计算。</small>{recycleOpen && <div className="feedback-recycle"><strong>反馈回收站</strong>{recycled.length === 0 ? <p>回收站为空。</p> : recycled.map(item => <div key={item.id}><p>{item.content}</p><span>{displayTime(item.deleted_at)}</span><button className="secondary-button compact" type="button" disabled={submitting} onClick={() => void restore(item.id)}>恢复反馈</button></div>)}</div>}</section>}
    <section className="feedback-list" aria-live="polite"><div className="feedback-list-heading"><strong>{adminSession ? "全部反馈" : "我的反馈"}</strong><span>{loading ? "正在读取…" : `${items.length} 条`}</span></div>
      {!loading && items.length === 0 && <p className="field-hint">还没有反馈记录。</p>}
      {items.map(item => {
        const unread = !adminSession && isReplyUnread?.(item.id, item.last_replied_at);
        const statusIsUnread = !adminSession && isStatusUnread?.(item.id, item.status_changed_at);
        const isCollapsed = collapsed.has(item.id);
        return <article className={`feedback-item ${unread || statusIsUnread ? "has-unread-reply" : ""}`} key={item.id} data-feedback-id={item.id} data-unread={unread || statusIsUnread ? "true" : undefined}>
          <div className="feedback-item-heading"><div className="feedback-badges"><span className={`feedback-category ${item.category}`}>{feedbackCategoryLabel(item.category)}</span>{(replies[item.id]?.length ?? 0) > 0 && <span className="feedback-status replied">已回复</span>}<span className={`feedback-status ${item.status}`} data-feedback-id={item.id} data-status-time={item.status_changed_at ?? undefined}>{feedbackStatusLabel(item.status)}</span>{statusIsUnread && <span className="message-unread-label">状态有更新</span>}{unread && <span className="message-unread-label">新回复</span>}</div></div>
          <div className="feedback-row-controls"><button className="secondary-button compact" type="button" aria-expanded={!isCollapsed} onClick={() => setCollapsed(previous => { const next = new Set(previous); if (next.has(item.id)) next.delete(item.id); else next.add(item.id); return next; })}>{isCollapsed ? "展开反馈" : "收起反馈"}</button>{adminSession && <button className="secondary-button compact feedback-delete" type="button" disabled={submitting} onClick={() => setDeleteConfirmId(item.id)}>删除反馈</button>}</div>
          {deleteConfirmId === item.id && adminSession && <div className="feedback-delete-confirm" role="alert">删除后用户暂时无法查看，管理员可在回收站恢复。<div><button className="secondary-button compact" type="button" onClick={() => setDeleteConfirmId(null)}>取消删除</button><button className="secondary-button compact feedback-delete" type="button" disabled={submitting} onClick={() => void recycle(item.id)}>确认删除</button></div></div>}
          {!isCollapsed && <><p className={`feedback-user-content ${adminSession ? "admin-highlight" : ""}`}>{adminSession && <strong>用户反馈<br /></strong>}{item.content}</p><p className="feedback-version">{item.app_version && <span>版本 {item.app_version}</span>}<span>{displayTime(item.created_at)}</span></p>
          {(replies[item.id] ?? []).map((replyItem, index, all) => <div className={`feedback-reply ${adminSession ? "admin-reply-muted" : ""}`} key={replyItem.id} data-feedback-id={item.id} data-reply-time={index === all.length - 1 ? replyItem.created_at : undefined}><strong>管理员回复</strong><p>{replyItem.content}</p><span>{displayTime(replyItem.created_at)}</span></div>)}
          {adminSession && <div className="feedback-reply-actions">{replyingId === item.id ? <><div className="feedback-status-picker" role="group" aria-label="处理状态"><span>处理状态</span><div>{([["open", "待处理"], ["in_progress", "处理中"], ["resolved", "已处理"]] as const).map(([value, label]) => <button key={value} type="button" aria-pressed={replyStatus === value} disabled={submitting || (replyStatus !== null && replyStatus !== value)} onClick={() => setReplyStatus(replyStatus === value ? null : value)}>{label}</button>)}</div><small>先取消当前选择，再选择其他状态。</small></div>{!statusOnly && <textarea value={replyContent} onChange={event => setReplyContent(event.target.value)} maxLength={4000} placeholder="填写管理员回复" />}<div><button className="secondary-button compact" type="button" onClick={() => { setReplyingId(null); setReplyContent(""); }}>取消</button><button className="primary-button compact" type="button" disabled={!replyStatus || submitting || (!statusOnly && !replyContent.trim())} onClick={() => void (statusOnly ? saveStatus(item.id) : reply(item.id))}>{statusOnly ? "保存状态" : "发送回复"}</button></div></> : <div><button className="secondary-button compact" type="button" disabled={submitting} onClick={() => { setReplyingId(item.id); setStatusOnly(false); setReplyStatus(item.status); }}>回复并更新状态</button><button className="secondary-button compact" type="button" disabled={submitting} onClick={() => { setReplyingId(item.id); setStatusOnly(true); setReplyStatus(item.status); }}>修改状态</button></div>}</div>}
          </>}
        </article>;
      })}
    </section>
  </section></div>;
}
