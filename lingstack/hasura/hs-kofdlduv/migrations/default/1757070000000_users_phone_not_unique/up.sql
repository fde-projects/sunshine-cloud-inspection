-- 账号唯一只保留用户名、工号；手机号允许重复。
ALTER TABLE public.users DROP CONSTRAINT IF EXISTS users_phone_key;
COMMENT ON COLUMN public.users.username IS '登录名，全局唯一';
COMMENT ON COLUMN public.users.employee_no IS '工号，全局唯一';
COMMENT ON COLUMN public.users.phone IS '手机号，允许重复';
