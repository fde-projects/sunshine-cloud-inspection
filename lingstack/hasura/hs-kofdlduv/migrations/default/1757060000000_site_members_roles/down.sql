ALTER TABLE public.users ADD COLUMN IF NOT EXISTS roles jsonb NOT NULL DEFAULT '[]'::jsonb;
ALTER TABLE public.users DROP CONSTRAINT IF EXISTS users_role_check;
ALTER TABLE public.users ADD CONSTRAINT users_role_check
  CHECK (role IN ('super_admin', 'site_manager', 'inspector', 'user'));

ALTER TABLE public.site_members ADD COLUMN IF NOT EXISTS member_role text;
UPDATE public.site_members
SET member_role = CASE
  WHEN member_roles @> ARRAY['deputy_manager']::text[] THEN 'deputy_manager'
  ELSE 'inspector'
END
WHERE member_role IS NULL;
ALTER TABLE public.site_members ALTER COLUMN member_role SET DEFAULT 'inspector';
ALTER TABLE public.site_members ALTER COLUMN member_role SET NOT NULL;
ALTER TABLE public.site_members DROP CONSTRAINT IF EXISTS site_members_member_roles_check;
ALTER TABLE public.site_members DROP COLUMN IF EXISTS member_roles;
DROP INDEX IF EXISTS uq_site_members_one_primary;
