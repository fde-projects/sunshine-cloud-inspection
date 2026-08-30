CREATE TABLE public.app_settings (
  key text PRIMARY KEY,
  value jsonb NOT NULL DEFAULT '{}'::jsonb,
  updated_at timestamptz NOT NULL DEFAULT now()
);
COMMENT ON TABLE public.app_settings IS '系统级键值配置，如品牌名称与 Logo';
COMMENT ON COLUMN public.app_settings.key IS '配置键，如 branding';
COMMENT ON COLUMN public.app_settings.value IS 'JSON 配置值';

CREATE TRIGGER trg_app_settings_updated_at
BEFORE UPDATE ON public.app_settings
FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();

INSERT INTO public.app_settings (key, value)
VALUES (
  'branding',
  jsonb_build_object(
    'systemName', '阳光运维系统',
    'subtitle', '阳光运维平台',
    'logoUrl', null
  )
);
