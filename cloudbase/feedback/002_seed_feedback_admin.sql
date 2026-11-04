-- 仅在 001 已成功执行后运行一次。
-- 在 CloudBase SQL 编辑器先查询：SELECT id FROM auth.users WHERE ...;
-- 将下方占位符替换为该环境中已存在的管理员 ID 后执行。
-- 不要把实际 ID 提交到 Git、写入配置文件或客户端代码。

INSERT INTO public.feedback_admins (user_id)
VALUES ('REPLACE_WITH_CLOUDBASE_ADMIN_USER_ID')
ON CONFLICT (user_id) DO NOTHING;
