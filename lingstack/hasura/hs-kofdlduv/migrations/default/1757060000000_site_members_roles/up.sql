-- 任职回到 site_members：一人一站一行，member_roles 多选。
-- 账号表只保留 role：super_admin / user。登录 JWT 从任职推。

ALTER TABLE public.site_members ADD COLUMN IF NOT EXISTS member_roles text[];

UPDATE public.site_members
SET member_roles = ARRAY[member_role]::text[]
WHERE member_roles IS NULL
  AND member_role IN ('deputy_manager', 'inspector', 'primary_manager');

INSERT INTO public.site_members (site_id, user_id, member_roles, status, joined_at)
SELECT s.site_id, s.user_id, s.roles, s.status, s.joined_at
FROM public.site_staff s
ON CONFLICT (site_id, user_id) DO UPDATE
SET member_roles = EXCLUDED.member_roles,
    status = EXCLUDED.status;

DELETE FROM public.site_members
WHERE member_roles IS NULL OR cardinality(member_roles) < 1;

ALTER TABLE public.site_members ALTER COLUMN member_roles SET NOT NULL;

ALTER TABLE public.site_members DROP CONSTRAINT IF EXISTS site_members_member_role_check;
ALTER TABLE public.site_members DROP COLUMN IF EXISTS member_role;

ALTER TABLE public.site_members DROP CONSTRAINT IF EXISTS site_members_member_roles_check;
ALTER TABLE public.site_members ADD CONSTRAINT site_members_member_roles_check CHECK (
  member_roles <@ ARRAY['primary_manager', 'deputy_manager', 'inspector']::text[]
  AND cardinality(member_roles) >= 1
  AND NOT (
    member_roles @> ARRAY['primary_manager']::text[]
    AND member_roles @> ARRAY['deputy_manager']::text[]
  )
);

DROP INDEX IF EXISTS uq_site_members_one_primary;
CREATE UNIQUE INDEX uq_site_members_one_primary
  ON public.site_members (site_id)
  WHERE status = 'active' AND member_roles @> ARRAY['primary_manager']::text[];

COMMENT ON TABLE public.site_members IS '网格任职：一人一站一行，member_roles 可多选';
COMMENT ON COLUMN public.site_members.member_roles IS 'primary_manager / deputy_manager / inspector；正长与副长互斥';

DROP TABLE IF EXISTS public.site_staff;

ALTER TABLE public.users DROP CONSTRAINT IF EXISTS users_role_check;
UPDATE public.users
SET role = CASE WHEN role = 'super_admin' THEN 'super_admin' ELSE 'user' END;
ALTER TABLE public.users ADD CONSTRAINT users_role_check CHECK (role IN ('super_admin', 'user'));
ALTER TABLE public.users DROP COLUMN IF EXISTS roles;

COMMENT ON COLUMN public.users.role IS '账号身份：super_admin 管理员 / user 普通账号；网格任职在 site_members';
