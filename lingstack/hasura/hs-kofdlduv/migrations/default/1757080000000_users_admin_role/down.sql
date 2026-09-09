UPDATE public.users SET role = 'user' WHERE role = 'admin';
ALTER TABLE public.users DROP CONSTRAINT IF EXISTS users_role_check;
ALTER TABLE public.users ADD CONSTRAINT users_role_check
  CHECK (role IN ('super_admin', 'user'));
COMMENT ON COLUMN public.users.role IS '账号身份：super_admin 管理员 / user 普通账号；网格任职在 site_members';
