-- 礼金簿意见反馈：CloudBase PostgreSQL（cloud-ynnu）
--
-- 数据边界：本 schema 仅保存用户主动提交的意见、软件版本、处理状态与管理员回复。
-- 禁止保存 .giftvault 路径、礼金簿/人物姓名、金额、地址、礼金明细或诊断日志。
--
-- 执行方式：在 CloudBase "cloud-ynnu" 的 PostgreSQL SQL 编辑器以管理角色执行。
-- 执行后必须再执行 002_seed_feedback_admin.sql，把已存在的 CloudBase 管理员账号
-- 的 auth.users.id 写入 feedback_admins。不要把该 ID 写入客户端代码或 Git 历史。

BEGIN;

CREATE TABLE IF NOT EXISTS public.feedback_admins (
  user_id text PRIMARY KEY,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS public.feedback (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  owner_id text NOT NULL DEFAULT (current_setting('request.jwt.claims', true)::json->>'sub'),
  category text NOT NULL CHECK (category IN ('suggestion', 'problem', 'other')),
  content text NOT NULL CHECK (char_length(trim(content)) BETWEEN 1 AND 4000),
  app_version varchar(32) NOT NULL CHECK (char_length(trim(app_version)) BETWEEN 1 AND 32),
  client_platform varchar(32) NOT NULL DEFAULT 'windows-desktop',
  status text NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'in_progress', 'resolved')),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  last_replied_at timestamptz
);

CREATE TABLE IF NOT EXISTS public.feedback_replies (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  feedback_id uuid NOT NULL REFERENCES public.feedback(id) ON DELETE CASCADE,
  content text NOT NULL CHECK (char_length(trim(content)) BETWEEN 1 AND 4000),
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS feedback_owner_created_at_idx
  ON public.feedback(owner_id, created_at DESC);
CREATE INDEX IF NOT EXISTS feedback_status_created_at_idx
  ON public.feedback(status, created_at DESC);
CREATE INDEX IF NOT EXISTS feedback_replies_feedback_created_at_idx
  ON public.feedback_replies(feedback_id, created_at ASC);

CREATE OR REPLACE FUNCTION public.feedback_touch_updated_at()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = public, pg_temp
AS $$
BEGIN
  NEW.updated_at = now();
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS feedback_touch_updated_at ON public.feedback;
CREATE TRIGGER feedback_touch_updated_at
  BEFORE UPDATE ON public.feedback
  FOR EACH ROW EXECUTE FUNCTION public.feedback_touch_updated_at();

-- This function deliberately reads only the internal allow-list. The function owner
-- bypasses feedback_admins RLS; the caller never receives the allow-list values.
CREATE OR REPLACE FUNCTION public.is_feedback_admin()
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
  SELECT EXISTS (
    SELECT 1
    FROM public.feedback_admins
    WHERE user_id = (current_setting('request.jwt.claims', true)::json->>'sub')
  );
$$;

REVOKE ALL ON FUNCTION public.is_feedback_admin() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.is_feedback_admin() TO anon, authenticated;

REVOKE ALL ON public.feedback_admins FROM PUBLIC, anon, authenticated;
REVOKE ALL ON public.feedback FROM PUBLIC, anon, authenticated;
REVOKE ALL ON public.feedback_replies FROM PUBLIC, anon, authenticated;

GRANT SELECT, INSERT ON public.feedback TO anon;
GRANT SELECT ON public.feedback_replies TO anon;
GRANT SELECT, INSERT, UPDATE ON public.feedback TO authenticated;
GRANT SELECT, INSERT ON public.feedback_replies TO authenticated;

ALTER TABLE public.feedback_admins ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.feedback ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.feedback_replies ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS feedback_admins_no_client_access ON public.feedback_admins;
CREATE POLICY feedback_admins_no_client_access ON public.feedback_admins
  FOR ALL TO anon, authenticated
  USING (false)
  WITH CHECK (false);

DROP POLICY IF EXISTS feedback_select_own ON public.feedback;
CREATE POLICY feedback_select_own ON public.feedback
  FOR SELECT TO anon
  USING (owner_id = (current_setting('request.jwt.claims', true)::json->>'sub'));

DROP POLICY IF EXISTS feedback_insert_own ON public.feedback;
CREATE POLICY feedback_insert_own ON public.feedback
  FOR INSERT TO anon
  WITH CHECK (owner_id = (current_setting('request.jwt.claims', true)::json->>'sub'));

DROP POLICY IF EXISTS feedback_admin_all ON public.feedback;
CREATE POLICY feedback_admin_all ON public.feedback
  FOR ALL TO authenticated
  USING (public.is_feedback_admin())
  WITH CHECK (public.is_feedback_admin());

DROP POLICY IF EXISTS feedback_replies_select_own ON public.feedback_replies;
CREATE POLICY feedback_replies_select_own ON public.feedback_replies
  FOR SELECT TO anon
  USING (
    EXISTS (
      SELECT 1 FROM public.feedback AS item
      WHERE item.id = feedback_replies.feedback_id
        AND item.owner_id = (current_setting('request.jwt.claims', true)::json->>'sub')
    )
  );

DROP POLICY IF EXISTS feedback_replies_admin_all ON public.feedback_replies;
CREATE POLICY feedback_replies_admin_all ON public.feedback_replies
  FOR ALL TO authenticated
  USING (public.is_feedback_admin())
  WITH CHECK (public.is_feedback_admin());

COMMIT;
