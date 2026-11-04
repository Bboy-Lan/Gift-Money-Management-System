import { useCallback, useEffect, useState } from "react";
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

function CloudFeedbackModal({ appVersion, onClose }: { appVersion: string; onClose: () => void }) {
  const [items, setItems] = useState<CloudFeedback[]>([]);
  const [replies, setReplies] = useState<Record<string, CloudFeedbackReply[]>>({});
  const [loading, setLoading] = useState(true);
  const [submitting, setSubmitting] = useState(false);
  const [adminSession, setAdminSession] = useState(false);
  const [adminLoginOpen, setAdminLoginOpen] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [category, setCategory] = useState<FeedbackCategory>("suggestion");
  const [content, setContent] = useState("");
  const [replyingId, setReplyingId] = useState<string | null>(null);
  const [replyContent, setReplyContent] = useState("");
  const [replyStatus, setReplyStatus] = useState<FeedbackStatus>("in_progress");

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
      setItems([]);
      setReplies({});
      setError(String(reason).replace(/^Error:\s*/, ""));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { void load(); }, [load]);

  const submit = async () => {
    setSubmitting(true);
    setError(null);
    setNotice(null);
    try {
      await submitFeedback({ category, content, appVersion });
      setContent("");
      setNotice("反馈已提交。管理员回复后会显示在这里。");
      await load();
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
    } catch (reason) { setError(String(reason).replace(/^Error:\s*/, "")); } finally { setSubmitting(false); }
  };

  return <div className="modal-backdrop"><section className="modal feedback-modal" role="dialog" aria-modal="true" aria-label="意见反馈"><div className="modal-heading"><h3>意见反馈</h3><button className="icon-button" type="button" aria-label="关闭" onClick={onClose}>×</button></div><p className="field-hint">反馈服务与礼金库严格分离；网络不可用时不会影响本地礼金簿。</p>{error && <p className="form-error" role="alert">{error}</p>}{notice && <p className="feedback-notice" role="status"><Check size={14} />{notice}</p>}<div className="feedback-toolbar"><span className={`feedback-session ${adminSession ? "admin" : ""}`}>{adminSession ? <><ShieldCheck size={14} />云端管理员</> : "普通反馈 · 无需注册"}</span><button className="secondary-button compact" disabled={loading || submitting} type="button" onClick={() => void load()}><RefreshCw size={14} />刷新</button>{adminSession ? <button className="secondary-button compact" disabled={submitting} type="button" onClick={() => void load(true)}>退出管理员登录</button> : <button className="secondary-button compact" disabled={submitting} type="button" onClick={() => setAdminLoginOpen((value) => !value)}>管理员登录</button>}</div>{adminLoginOpen && !adminSession && <FeedbackAdminLogin busy={submitting || loading} onBusyChange={setSubmitting} onAuthenticated={async () => { setAdminLoginOpen(false); setNotice("已验证管理员邮箱，登录有效期内将自动识别。"); await load(); }} />}{!adminSession && <section className="feedback-compose"><strong>提交反馈</strong><label>类型<select value={category} onChange={(event) => setCategory(event.target.value as FeedbackCategory)}><option value="suggestion">功能建议</option><option value="problem">问题反馈</option><option value="other">其他</option></select></label><label>内容<textarea value={content} onChange={(event) => setContent(event.target.value)} maxLength={4000} placeholder="请描述你的建议或遇到的问题；请勿填写礼金明细、姓名、金额、地址或礼金库路径。" /></label><div className="feedback-compose-footer"><span>{content.length}/4000</span><button className="primary-button compact" type="button" disabled={!content.trim() || submitting} onClick={() => void submit()}>提交反馈</button></div></section>}<section className="feedback-list" aria-live="polite"><div className="feedback-list-heading"><strong>{adminSession ? "全部反馈" : "我的反馈"}</strong><span>{loading ? "正在读取…" : `${items.length} 条`}</span></div>{!loading && items.length === 0 && <p className="field-hint">还没有反馈记录。</p>}{items.map((item) => <article className="feedback-item" key={item.id}><div className="feedback-item-heading"><strong>{feedbackCategoryLabel(item.category)}</strong><span className={`feedback-status ${item.status}`}>{feedbackStatusLabel(item.status)}</span></div>{adminSession && <p className="feedback-version">{item.app_version} · {displayTime(item.created_at)}</p>}<p>{item.content}</p>{(replies[item.id] ?? []).map((replyItem) => <div className="feedback-reply" key={replyItem.id}><strong>管理员回复</strong><p>{replyItem.content}</p><span>{displayTime(replyItem.created_at)}</span></div>)}{adminSession && <div className="feedback-reply-actions">{replyingId === item.id ? <><select value={replyStatus} onChange={(event) => setReplyStatus(event.target.value as FeedbackStatus)}><option value="in_progress">处理中</option><option value="resolved">已处理</option><option value="open">待处理</option></select><textarea value={replyContent} onChange={(event) => setReplyContent(event.target.value)} maxLength={4000} placeholder="填写管理员回复" /><div><button className="secondary-button compact" type="button" onClick={() => { setReplyingId(null); setReplyContent(""); }}>取消</button><button className="primary-button compact" type="button" disabled={!replyContent.trim() || submitting} onClick={() => void reply(item.id)}>发送回复</button></div></> : <button className="secondary-button compact" type="button" disabled={submitting} onClick={() => { setReplyingId(item.id); setReplyStatus(item.status); }}>回复并更新状态</button>}</div>}</article>)}</section></section></div>;
}
