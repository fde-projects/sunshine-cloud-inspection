-- 平台管理员：与超管同等业务权限，账号层单独记 admin。
ALTER TABLE public.users DROP CONSTRAINT IF EXISTS users_role_check;
ALTER TABLE public.users ADD CONSTRAINT users_role_check
  CHECK (role IN ('super_admin', 'admin', 'user'));
COMMENT ON COLUMN public.users.role IS '账号身份：super_admin 超级管理员 / admin 管理员 / user 普通账号；网格任职在 site_members';
