-- CloudBase PG 客户端使用结构化结果读取当前会话的管理员资格。
-- 不接受 UID 或邮箱参数；资格始终来自服务端验证过的 JWT 与既有白名单。
BEGIN;

CREATE OR REPLACE FUNCTION public.feedback_admin_status()
RETURNS TABLE (is_admin boolean)
LANGUAGE sql
STABLE
SECURITY INVOKER
SET search_path = public, pg_temp
AS $$
  SELECT public.is_feedback_admin();
$$;

REVOKE ALL ON FUNCTION public.feedback_admin_status() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.feedback_admin_status() TO anon, authenticated;

COMMIT;
