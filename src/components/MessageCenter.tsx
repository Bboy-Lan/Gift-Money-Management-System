import { useState } from "react";
import { ChevronDown, Mail, MessageSquare, RefreshCw, X } from "lucide-react";
import { useMessages } from "../hooks/useMessages";
import { announcementUnread, replyUnread, statusUnread, type Announcement } from "../lib/messageState";
import { AnnouncementEditor } from "./AnnouncementEditor";
import { CloudFeedbackModal } from "./CloudFeedback";

export function MessageCenterButton() {
  const messages = useMessages(); if (!messages) return null;
  const count = messages.unreadAnnouncements + messages.unreadReplies + messages.unreadStatuses;
  return <button type="button" className={`message-center-button ${count ? "has-unread" : ""}`} data-unread={count ? "true" : undefined} aria-label={`打开消息中心${count ? `，${count} 条未读` : ""}`} title={count ? `${count} 条未读公告或回复` : "公告与反馈回复"} onClick={messages.openInbox}><Mail size={20} />{count > 0 && <span className="message-unread-dot" aria-hidden="true" />}</button>;
}
export function FeedbackButton() {
  const messages = useMessages(); if (!messages) return null;
  const count = messages.unreadReplies + messages.unreadStatuses;
  return <button type="button" className={`feedback-entry-button ${count ? "has-unread" : ""}`} data-unread={count ? "true" : undefined} onClick={() => messages.openFeedback()}><MessageSquare size={15} />问题反馈{count > 0 && <span className="message-unread-count">{count} 条新消息</span>}</button>;
}
export function MessageOverlays() {
  const messages = useMessages(); if (!messages) return null;
  return <>{messages.inboxOpen && <MessageCenterPanel />}{!messages.inboxOpen && !messages.feedbackOpen && messages.replyAlert && replyUnread(messages.replyAlert, messages.readState) && <aside className="feedback-reply-nudge" role="status"><MessageSquare size={20} /><div><strong>收到管理员新回复</strong><span>你的问题反馈有了新进展。</span><button className="primary-button compact" type="button" onClick={() => messages.openFeedback(messages.replyAlert!.id)}>查看新回复</button></div><button className="icon-button" type="button" aria-label="关闭回复提醒" onClick={messages.dismissReplyAlert}><X size={14} /></button></aside>}{!messages.inboxOpen && !messages.feedbackOpen && (!messages.replyAlert || !replyUnread(messages.replyAlert, messages.readState)) && messages.statusAlert && statusUnread(messages.statusAlert, messages.readState) && <aside className="feedback-reply-nudge" role="status"><MessageSquare size={20} /><div><strong>反馈处理状态已更新</strong><span>你的问题反馈有了新进展。</span><button className="primary-button compact" type="button" onClick={() => messages.openFeedback(messages.statusAlert!.id, "status")}>查看状态</button></div><button className="icon-button" type="button" aria-label="关闭状态提醒" onClick={messages.dismissStatusAlert}><X size={14} /></button></aside>}</>;
}
export function FeedbackWorkbench() {
  const messages = useMessages(); if (!messages || !messages.feedbackOpen) return null;
  const refreshKey = messages.replyStatus.map(item => `${item.id}:${item.last_replied_at ?? ""}:${item.status_changed_at ?? ""}`).sort().join("|");
  return <CloudFeedbackModal inline appVersion={typeof __APP_VERSION__ === "string" ? __APP_VERSION__ : "preview"} onClose={messages.closeFeedback} onSessionChanged={() => void messages.refreshAfterSessionChange()} initialAdminLogin={messages.adminLoginRequested} onReplyRead={messages.readReply} isReplyUnread={(id, timestamp) => replyUnread({ id, last_replied_at: timestamp }, messages.readState)} onStatusRead={messages.readStatus} isStatusUnread={(id, timestamp) => statusUnread({ id, last_replied_at: null, status_changed_at: timestamp }, messages.readState)} focusFeedbackId={messages.focusFeedbackId} focusFeedbackKind={messages.focusFeedbackKind} refreshKey={refreshKey} />;
}
function MessageCenterPanel() {
  const messages = useMessages()!;
  const first = messages.announcements.find(item => announcementUnread(item, messages.readState)) ?? messages.announcements[0];
  const [selectedId, setSelectedId] = useState(first?.id);
  const [editing, setEditing] = useState(false), [initial, setInitial] = useState<Announcement>();
  const selected = messages.announcements.find(item => item.id === selectedId) ?? first;
  return <section className="message-center-panel" role="dialog" aria-label="消息中心" onKeyDown={event => { if (event.key === "Escape") { event.stopPropagation(); messages.closeInbox(); } }}>
    <header className="message-panel-heading"><div><Mail size={18} /><h3>消息中心</h3></div><button className="icon-button" type="button" aria-label="关闭消息中心" onClick={messages.closeInbox}><X size={17} /></button></header>
    <div className="message-panel-toolbar"><nav aria-label="消息分类"><button type="button" className={messages.inboxTab === "announcements" ? "active" : ""} onClick={() => { messages.setInboxTab("announcements"); setEditing(false); }}>通知公告{messages.unreadAnnouncements > 0 && <span className="message-unread-count">{messages.unreadAnnouncements}</span>}</button><button type="button" className={messages.inboxTab === "replies" ? "active" : ""} onClick={() => { messages.setInboxTab("replies"); setEditing(false); }}>反馈消息{(messages.unreadReplies + messages.unreadStatuses) > 0 && <span className="message-unread-count">{messages.unreadReplies + messages.unreadStatuses}</span>}</button></nav><button className="icon-button" type="button" aria-label="刷新消息" disabled={messages.refreshing} onClick={() => void messages.refresh()}><RefreshCw size={15} /></button></div>
    <div className="message-panel-content">{messages.error && <p className="field-hint message-sync-error" role="status">{messages.error}</p>}
      {editing && messages.isAdmin ? <AnnouncementEditor initial={initial} onClose={() => setEditing(false)} onPublished={async item => { messages.markPublishedRead(item); await messages.refresh(); setEditing(false); }} /> : messages.inboxTab === "announcements" ? <>
        <div className="message-section-heading"><span>软件说明与最新通知</span>{messages.isAdmin ? <button type="button" className="secondary-button compact" onClick={() => { setInitial(undefined); setEditing(true); }}>管理公告</button> : <button type="button" className="secondary-button compact" onClick={messages.openAdminLogin}>管理员登录</button>}</div>
        <div className="announcement-list">{messages.announcements.map(item => <button type="button" key={item.id} className={`announcement-subject ${selected?.id === item.id ? "selected" : ""}`} onClick={() => setSelectedId(item.id)}><span>{item.title}</span>{announcementUnread(item, messages.readState) ? <small className="message-unread-label">未读</small> : <small>已读</small>}</button>)}</div>
        {selected && <article className="announcement-reading"><div className="announcement-reading-heading"><h4>{selected.title}</h4><time>{new Date(selected.published_at).toLocaleDateString("zh-CN")}</time></div><p>{selected.body}</p><div className="announcement-reading-actions">{messages.isAdmin && <button type="button" className="secondary-button compact" onClick={() => { setInitial(selected); setEditing(true); }}>编辑此公告</button>}<button type="button" className="primary-button compact" onClick={() => messages.readAnnouncement(selected)}><ChevronDown size={15} />已读并收起</button></div></article>}
      </> : <><div className="message-section-heading"><span>{messages.unreadReplies + messages.unreadStatuses ? `${messages.unreadReplies + messages.unreadStatuses} 条未读反馈消息` : "没有未读反馈消息"}</span><button className="secondary-button compact" type="button" onClick={() => messages.openFeedback()}>查看我的反馈</button></div>{messages.replyStatus.filter(item => replyUnread(item, messages.readState)).map(item => <div key={item.id} className="feedback-reply-alert"><div><strong>管理员回复了你的反馈</strong><span>{new Date(item.last_replied_at!).toLocaleString("zh-CN")}</span></div><button className="primary-button compact" type="button" onClick={() => messages.openFeedback(item.id)}>查看回复</button></div>)}{messages.replyStatus.filter(item => statusUnread(item, messages.readState)).map(item => <div key={`status-${item.id}`} className="feedback-reply-alert"><div><strong>反馈处理状态已更新</strong><span>{new Date(item.status_changed_at!).toLocaleString("zh-CN")}</span></div><button className="primary-button compact" type="button" onClick={() => messages.openFeedback(item.id, "status")}>查看状态</button></div>)}</>}
    </div>
  </section>;
}
