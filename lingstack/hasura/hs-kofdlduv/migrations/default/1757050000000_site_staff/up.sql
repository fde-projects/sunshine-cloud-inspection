-- 任职只保留一张表：一人一站一行，roles 多选。
-- 旧 site_members 属 lingstack，本库账号无法 ALTER/DROP，清空后不再使用。
DROP TABLE IF EXISTS public.site_member_duties;

CREATE TABLE public.site_staff (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  site_id uuid NOT NULL REFERENCES public.sites(id) ON DELETE CASCADE,
  user_id uuid NOT NULL REFERENCES public.users(id) ON DELETE CASCADE,
  roles text[] NOT NULL,
  status text NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'inactive')),
  joined_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (site_id, user_id),
  CONSTRAINT site_staff_roles_valid_check CHECK (
    roles <@ ARRAY['primary_manager', 'deputy_manager', 'inspector']::text[]
    AND cardinality(roles) >= 1
    AND NOT (
      roles @> ARRAY['primary_manager']::text[]
      AND roles @> ARRAY['deputy_manager']::text[]
    )
  )
);

CREATE UNIQUE INDEX uq_site_staff_one_primary
  ON public.site_staff (site_id)
  WHERE status = 'active' AND roles @> ARRAY['primary_manager']::text[];

CREATE INDEX idx_site_staff_user ON public.site_staff (user_id);

COMMENT ON TABLE public.site_staff IS '网格任职：一人一站一行，roles 可多选；一人可属多网格';
COMMENT ON COLUMN public.site_staff.roles IS 'primary_manager / deputy_manager / inspector；正长与副长互斥';

TRUNCATE public.site_members;

UPDATE public.sites SET manager_id = NULL;

UPDATE public.users
SET role = 'inspector', roles = '[]'::jsonb
WHERE role <> 'super_admin'
  AND NOT COALESCE(roles, '[]'::jsonb) @> '["super_admin"]'::jsonb;
