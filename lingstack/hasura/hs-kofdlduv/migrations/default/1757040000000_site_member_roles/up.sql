-- 任职多选落在独立表：当前库账号不是 site_members 的 owner，无法 ALTER 旧表。
-- 一人一站可多任职；一人可属多网格；一站仅一名正长。
CREATE TABLE IF NOT EXISTS public.site_member_duties (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  site_id uuid NOT NULL REFERENCES public.sites(id) ON DELETE CASCADE,
  user_id uuid NOT NULL REFERENCES public.users(id) ON DELETE CASCADE,
  duty text NOT NULL CHECK (duty IN ('primary_manager', 'deputy_manager', 'inspector')),
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (site_id, user_id, duty)
);

CREATE UNIQUE INDEX IF NOT EXISTS uq_site_member_duties_one_primary
  ON public.site_member_duties (site_id)
  WHERE duty = 'primary_manager';

CREATE INDEX IF NOT EXISTS idx_site_member_duties_user
  ON public.site_member_duties (user_id);

COMMENT ON TABLE public.site_member_duties IS '网格任职多选：一人一站可多任职；一人可属多网格';
COMMENT ON COLUMN public.site_member_duties.duty IS 'primary_manager / deputy_manager / inspector；正长与副长互斥由应用校验';

INSERT INTO public.site_member_duties (site_id, user_id, duty)
SELECT m.site_id, m.user_id, m.member_role
FROM public.site_members m
WHERE m.status = 'active'
  AND m.member_role IN ('deputy_manager', 'inspector')
ON CONFLICT (site_id, user_id, duty) DO NOTHING;

INSERT INTO public.site_member_duties (site_id, user_id, duty)
SELECT s.id, s.manager_id, 'primary_manager'
FROM public.sites s
WHERE s.manager_id IS NOT NULL
  AND s.deleted_at IS NULL
ON CONFLICT (site_id, user_id, duty) DO NOTHING;

INSERT INTO public.site_member_duties (site_id, user_id, duty)
SELECT s.id, s.manager_id, 'inspector'
FROM public.sites s
JOIN public.users u ON u.id = s.manager_id
WHERE s.manager_id IS NOT NULL
  AND s.deleted_at IS NULL
  AND (
    COALESCE(u.roles, '[]'::jsonb) @> '["inspector"]'::jsonb
    OR u.role = 'inspector'
  )
ON CONFLICT (site_id, user_id, duty) DO NOTHING;
