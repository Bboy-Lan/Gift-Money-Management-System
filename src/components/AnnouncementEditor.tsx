import { useEffect, useState } from "react";
import { listAnnouncementDrafts, publishAnnouncement, saveAnnouncementDraft } from "../lib/cloudFeedback";
import type { Announcement, AnnouncementDraft } from "../lib/messageState";

export function AnnouncementEditor({ initial, onPublished, onClose }: { initial?: Announcement; onPublished: () => Promise<void>; onClose: () => void }) {
  const [id, setId] = useState<string | undefined>(initial?.id);
  const [title, setTitle] = useState(initial?.title ?? ""), [body, setBody] = useState(initial?.body ?? "");
  const [drafts, setDrafts] = useState<AnnouncementDraft[]>([]);
  const [loading, setLoading] = useState(true), [busy, setBusy] = useState(false), [preview, setPreview] = useState(false);
  const [error, setError] = useState<string | null>(null), [notice, setNotice] = useState<string | null>(null);
  useEffect(() => {
    let active = true;
    listAnnouncementDrafts().then(items => {
      if (!active) return; setDrafts(items);
      const saved = items.find(item => item.id === initial?.id);
      if (saved) { setId(saved.id); setTitle(saved.title); setBody(saved.body); }
    }).catch(reason => { if (active) setError(String(reason).replace(/^Error:\s*/, "")); }).finally(() => { if (active) setLoading(false); });
    return () => { active = false; };
  }, [initial?.id]);
  const save = async (publish = false) => {
    setBusy(true); setError(null); setNotice(null);
    try {
      const draft = await saveAnnouncementDraft({ id, title, body });
      setId(draft.id); setDrafts(items => [draft, ...items.filter(item => item.id !== draft.id)]);
      if (publish) { await publishAnnouncement(draft.id); await onPublished(); }
      else setNotice("草稿已保存，用户不会收到通知。发布后才会推送新公告。");
    } catch (reason) { setError(String(reason).replace(/^Error:\s*/, "")); } finally { setBusy(false); }
  };
  const select = (draft?: AnnouncementDraft) => { setId(draft?.id); setTitle(draft?.title ?? ""); setBody(draft?.body ?? ""); setNotice(null); setError(null); setPreview(false); };
  return <section className="announcement-editor">
    <div className="message-section-heading"><h4>管理公告</h4><button type="button" className="secondary-button compact" disabled={busy} onClick={onClose}>返回公告</button></div>
    <p className="field-hint">保存草稿不会影响正在展示的公告。发布后，用户下次启动会收到新公告；使用期间会显示未读提示。</p>
    {error && <p className="form-error" role="alert">{error}</p>}{notice && <p className="feedback-notice" role="status">{notice}</p>}
    <div className="announcement-draft-picker"><button type="button" className="secondary-button compact" disabled={busy || loading} onClick={() => select()}>新建公告</button>{drafts.map(draft => <button key={draft.id} type="button" className={`announcement-draft-choice ${id === draft.id ? "active" : ""}`} disabled={busy || loading} onClick={() => select(draft)}>{draft.title}</button>)}</div>
    <label>公告标题<input name="announcement-title" value={title} maxLength={120} disabled={busy || loading} onChange={event => setTitle(event.target.value)} /></label>
    <label>公告正文<textarea name="announcement-body" value={body} maxLength={8000} disabled={busy || loading} onChange={event => setBody(event.target.value)} placeholder="支持分段文字，请填写软件说明或需要告知用户的事项。" /></label>
    <div className="announcement-editor-actions"><span>{body.length}/8000</span><button type="button" className="secondary-button compact" aria-expanded={preview} onClick={() => setPreview(value => !value)}>预览</button><button type="button" className="secondary-button compact" disabled={busy || loading || !title.trim() || !body.trim()} onClick={() => void save()}>保存草稿</button><button type="button" className="primary-button compact" disabled={busy || loading || !title.trim() || !body.trim()} onClick={() => void save(true)}>{busy ? "处理中…" : "发布公告"}</button></div>
    {preview && <article className="announcement-preview"><strong>{title || "公告标题"}</strong><p>{body || "公告正文"}</p></article>}
  </section>;
}
