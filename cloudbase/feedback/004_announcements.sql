-- Each section is one statement for consoles that confirm role names before execution.
CREATE TABLE IF NOT EXISTS public.announcements (
  id text PRIMARY KEY,
  title text NOT NULL CHECK (char_length(trim(title)) BETWEEN 1 AND 120),
  body text NOT NULL CHECK (char_length(trim(body)) BETWEEN 1 AND 8000),
  revision integer NOT NULL DEFAULT 1 CHECK (revision > 0),
  published_at timestamptz NOT NULL DEFAULT now()
);
-- next --
CREATE TABLE IF NOT EXISTS public.announcement_drafts (
  id text PRIMARY KEY,
  title text NOT NULL CHECK (char_length(trim(title)) BETWEEN 1 AND 120),
  body text NOT NULL CHECK (char_length(trim(body)) BETWEEN 1 AND 8000),
  updated_at timestamptz NOT NULL DEFAULT now()
);
-- next --
REVOKE ALL ON public.announcements, public.announcement_drafts FROM PUBLIC, anon, authenticated;
-- next --
GRANT SELECT ON public.announcements TO anon, authenticated;
-- next --
GRANT SELECT ON public.announcement_drafts TO authenticated;
-- next --
ALTER TABLE public.announcements ENABLE ROW LEVEL SECURITY;
-- next --
ALTER TABLE public.announcement_drafts ENABLE ROW LEVEL SECURITY;
-- next --
DROP POLICY IF EXISTS announcements_read ON public.announcements;
-- next --
CREATE POLICY announcements_read ON public.announcements FOR SELECT TO anon, authenticated USING (true);
-- next --
DROP POLICY IF EXISTS announcement_drafts_admin ON public.announcement_drafts;
-- next --
CREATE POLICY announcement_drafts_admin ON public.announcement_drafts FOR SELECT TO authenticated USING (public.is_feedback_admin());
-- next --
CREATE OR REPLACE FUNCTION public.save_announcement_draft(p_id text, p_title text, p_body text)
RETURNS TABLE (id text, title text, body text, updated_at timestamptz)
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE draft_key text := COALESCE(NULLIF(p_id, ''), gen_random_uuid()::text);
BEGIN
  IF NOT public.is_feedback_admin() THEN
    RAISE EXCEPTION '需要反馈管理员权限' USING ERRCODE = '42501';
  END IF;
  IF draft_key !~ '^[a-zA-Z0-9-]{1,80}$' OR p_title IS NULL OR p_body IS NULL
     OR char_length(trim(p_title)) NOT BETWEEN 1 AND 120
     OR char_length(trim(p_body)) NOT BETWEEN 1 AND 8000 THEN
    RAISE EXCEPTION '公告标题或正文无效' USING ERRCODE = '22023';
  END IF;
  RETURN QUERY INSERT INTO public.announcement_drafts AS draft (id, title, body, updated_at)
  VALUES (draft_key, trim(p_title), trim(p_body), clock_timestamp())
  ON CONFLICT ON CONSTRAINT announcement_drafts_pkey DO UPDATE
    SET title = EXCLUDED.title, body = EXCLUDED.body, updated_at = EXCLUDED.updated_at
  RETURNING draft.id, draft.title, draft.body, draft.updated_at;
END;
$$;
-- next --
REVOKE ALL ON FUNCTION public.save_announcement_draft(text, text, text) FROM PUBLIC;
-- next --
GRANT EXECUTE ON FUNCTION public.save_announcement_draft(text, text, text) TO authenticated;
-- next --
CREATE OR REPLACE FUNCTION public.publish_announcement(p_id text)
RETURNS TABLE (id text, title text, body text, revision integer, published_at timestamptz)
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
BEGIN
  IF NOT public.is_feedback_admin() THEN
    RAISE EXCEPTION '需要反馈管理员权限' USING ERRCODE = '42501';
  END IF;
  RETURN QUERY INSERT INTO public.announcements AS published (id, title, body, revision, published_at)
  SELECT draft.id, draft.title, draft.body, 1, clock_timestamp()
  FROM public.announcement_drafts AS draft WHERE draft.id = p_id
  ON CONFLICT ON CONSTRAINT announcements_pkey DO UPDATE
    SET title = EXCLUDED.title, body = EXCLUDED.body,
        revision = published.revision + 1, published_at = EXCLUDED.published_at
  RETURNING published.id, published.title, published.body, published.revision, published.published_at;
  IF NOT FOUND THEN RAISE EXCEPTION '公告草稿不存在' USING ERRCODE = '22023'; END IF;
END;
$$;
-- next --
REVOKE ALL ON FUNCTION public.publish_announcement(text) FROM PUBLIC;
-- next --
GRANT EXECUTE ON FUNCTION public.publish_announcement(text) TO authenticated;
-- next --
CREATE OR REPLACE FUNCTION public.feedback_reply_timestamp()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
BEGIN
  UPDATE public.feedback SET last_replied_at = GREATEST(last_replied_at, NEW.created_at)
  WHERE id = NEW.feedback_id;
  RETURN NEW;
END;
$$;
-- next --
REVOKE ALL ON FUNCTION public.feedback_reply_timestamp() FROM PUBLIC;
-- next --
DROP TRIGGER IF EXISTS feedback_reply_timestamp ON public.feedback_replies;
-- next --
CREATE TRIGGER feedback_reply_timestamp AFTER INSERT ON public.feedback_replies
FOR EACH ROW EXECUTE FUNCTION public.feedback_reply_timestamp();
-- next --
INSERT INTO public.announcements (id, title, body, revision, published_at)
VALUES ('software-guide', '欢迎使用礼金簿', E'礼金库保存在你选择的本机文件中，登记、查询和备份均可离线使用。请妥善保存礼金库及备份。\n\n软件更新、公告和反馈消息检查会联网，但不会自动上传礼金库、人物、金额、地址、本机路径或日志。反馈内容由你主动填写，请避免包含隐私信息。\n\n本地管理员 PIN 用于保护礼金库编辑；反馈和公告管理员使用独立的邮箱验证身份。普通用户无需注册即可发送问题反馈、查看自己的反馈及管理员回复。\n\n新公告或新回复会在顶部信件入口提示。公告读完后点击“已读并收起”，以后仍可在此重读。', 1, '2026-11-04T00:00:00Z')
ON CONFLICT (id) DO NOTHING;
-- next --
INSERT INTO public.announcement_drafts (id, title, body)
SELECT id, title, body FROM public.announcements WHERE id = 'software-guide'
ON CONFLICT (id) DO NOTHING;
