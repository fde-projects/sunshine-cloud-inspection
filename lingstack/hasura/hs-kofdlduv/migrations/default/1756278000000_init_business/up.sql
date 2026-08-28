-- 阳光运维：业务表（对齐原 cursor-fdz，主键统一 uuid）
CREATE EXTENSION IF NOT EXISTS pgcrypto;

CREATE OR REPLACE FUNCTION public.set_updated_at()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  NEW.updated_at = now();
  RETURN NEW;
END;
$$;
COMMENT ON FUNCTION public.set_updated_at() IS '更新行时自动刷新 updated_at';

-- ========== 组织与账号 ==========
CREATE TABLE public.users (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  username text NOT NULL UNIQUE,
  password text NOT NULL,
  real_name text NOT NULL,
  employee_no varchar(32) UNIQUE,
  phone text NOT NULL UNIQUE,
  email text,
  avatar text,
  role text NOT NULL CHECK (role IN ('super_admin', 'site_manager', 'inspector')),
  roles jsonb NOT NULL DEFAULT '[]'::jsonb,
  status text NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'inactive')),
  region text,
  org_unit varchar(64),
  created_by_id uuid REFERENCES public.users(id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
COMMENT ON TABLE public.users IS '系统用户：管理员 / 网格长 / 巡检工程师';
COMMENT ON COLUMN public.users.id IS '用户主键';
COMMENT ON COLUMN public.users.username IS '登录名，全局唯一';
COMMENT ON COLUMN public.users.password IS 'bcrypt 密码哈希，禁止经 GraphQL 返回';
COMMENT ON COLUMN public.users.real_name IS '真实姓名';
COMMENT ON COLUMN public.users.employee_no IS '工号';
COMMENT ON COLUMN public.users.phone IS '手机号，全局唯一';
COMMENT ON COLUMN public.users.email IS '邮箱';
COMMENT ON COLUMN public.users.avatar IS '头像 URL';
COMMENT ON COLUMN public.users.role IS '主角色，与 roles 中优先级最高者同步';
COMMENT ON COLUMN public.users.roles IS '一账号多角色。示例 JSON：["super_admin"]';
COMMENT ON COLUMN public.users.status IS '账号状态 active / inactive';
COMMENT ON COLUMN public.users.region IS '所属区域';
COMMENT ON COLUMN public.users.org_unit IS '费用结算归属单位';
COMMENT ON COLUMN public.users.created_by_id IS '创建人用户';
COMMENT ON COLUMN public.users.created_at IS '创建时间';
COMMENT ON COLUMN public.users.updated_at IS '更新时间';

CREATE TABLE public.sites (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name text NOT NULL,
  code text NOT NULL UNIQUE,
  province text NOT NULL DEFAULT '',
  city text NOT NULL DEFAULT '',
  district text NOT NULL DEFAULT '',
  address text NOT NULL DEFAULT '',
  latitude numeric(10, 7) NOT NULL DEFAULT 0,
  longitude numeric(10, 7) NOT NULL DEFAULT 0,
  inspection_radius_meters integer NOT NULL DEFAULT 500
    CHECK (inspection_radius_meters BETWEEN 50 AND 5000),
  manager_id uuid REFERENCES public.users(id) ON DELETE SET NULL,
  status text NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'inactive')),
  deleted_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now()
);
COMMENT ON TABLE public.sites IS '网格（运维站点）';
COMMENT ON COLUMN public.sites.id IS '网格主键';
COMMENT ON COLUMN public.sites.name IS '网格名称';
COMMENT ON COLUMN public.sites.code IS '网格编码，全局唯一';
COMMENT ON COLUMN public.sites.province IS '省';
COMMENT ON COLUMN public.sites.city IS '市';
COMMENT ON COLUMN public.sites.district IS '区县';
COMMENT ON COLUMN public.sites.address IS '详细地址';
COMMENT ON COLUMN public.sites.latitude IS '纬度';
COMMENT ON COLUMN public.sites.longitude IS '经度';
COMMENT ON COLUMN public.sites.inspection_radius_meters IS '围栏半径（米），兼容旧数据';
COMMENT ON COLUMN public.sites.manager_id IS '正网格长';
COMMENT ON COLUMN public.sites.status IS '启用状态';
COMMENT ON COLUMN public.sites.deleted_at IS '软删除时间';
COMMENT ON COLUMN public.sites.created_at IS '创建时间';

CREATE TABLE public.site_members (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  site_id uuid NOT NULL REFERENCES public.sites(id) ON DELETE CASCADE,
  user_id uuid NOT NULL REFERENCES public.users(id) ON DELETE CASCADE,
  member_role text NOT NULL DEFAULT 'inspector'
    CHECK (member_role IN ('deputy_manager', 'inspector')),
  status text NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'inactive')),
  joined_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (site_id, user_id)
);
COMMENT ON TABLE public.site_members IS '网格成员：副网格长 / 工程师，一人可属多网格';
COMMENT ON COLUMN public.site_members.id IS '成员关系主键';
COMMENT ON COLUMN public.site_members.site_id IS '所属网格';
COMMENT ON COLUMN public.site_members.user_id IS '成员用户';
COMMENT ON COLUMN public.site_members.member_role IS '任职：deputy_manager 副网格长 / inspector 工程师';
COMMENT ON COLUMN public.site_members.status IS '成员状态';
COMMENT ON COLUMN public.site_members.joined_at IS '加入时间';

CREATE TABLE public.devices (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  site_id uuid NOT NULL REFERENCES public.sites(id) ON DELETE RESTRICT,
  serial_number text NOT NULL UNIQUE,
  device_type text NOT NULL
    CHECK (device_type IN ('string_inverter', 'central_inverter', 'energy_storage')),
  model text,
  manufacturer text,
  install_date date,
  status text NOT NULL DEFAULT 'active'
    CHECK (status IN ('active', 'inactive', 'maintenance')),
  created_at timestamptz NOT NULL DEFAULT now()
);
COMMENT ON TABLE public.devices IS '现场设备（逆变器 / 储能）';
COMMENT ON COLUMN public.devices.id IS '设备主键';
COMMENT ON COLUMN public.devices.site_id IS '归属网格';
COMMENT ON COLUMN public.devices.serial_number IS '设备序列号，全局唯一';
COMMENT ON COLUMN public.devices.device_type IS 'string_inverter 组串 / central_inverter 集中 / energy_storage 储能';
COMMENT ON COLUMN public.devices.model IS '型号';
COMMENT ON COLUMN public.devices.manufacturer IS '厂家';
COMMENT ON COLUMN public.devices.install_date IS '安装日期';
COMMENT ON COLUMN public.devices.status IS '设备状态';
COMMENT ON COLUMN public.devices.created_at IS '创建时间';

-- ========== 模板 / 任务 / 记录 ==========
CREATE TABLE public.inspection_templates (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name text NOT NULL,
  device_type text NOT NULL
    CHECK (device_type IN ('string_inverter', 'central_inverter', 'energy_storage')),
  entries jsonb NOT NULL DEFAULT '[]'::jsonb,
  product_lines jsonb NOT NULL DEFAULT '[]'::jsonb,
  is_global boolean NOT NULL DEFAULT true,
  site_id uuid REFERENCES public.sites(id) ON DELETE CASCADE,
  assign_mode varchar(16) NOT NULL DEFAULT 'single' CHECK (assign_mode IN ('single', 'multi')),
  unit_label varchar(32) NOT NULL DEFAULT '台',
  expense_enabled_default boolean NOT NULL DEFAULT false,
  version integer NOT NULL DEFAULT 1,
  created_at timestamptz NOT NULL DEFAULT now()
);
COMMENT ON TABLE public.inspection_templates IS '服务/巡检类型模板';
COMMENT ON COLUMN public.inspection_templates.id IS '模板主键';
COMMENT ON COLUMN public.inspection_templates.name IS '类型名称，如故障恢复';
COMMENT ON COLUMN public.inspection_templates.device_type IS '适用设备类型';
COMMENT ON COLUMN public.inspection_templates.entries IS '默认检查条目。示例 JSON：[{"id":"e1","name":"接地","description":"箱内主PE","isRequired":true,"order":1,"samplePhotos":[],"checkType":"photo","aiEnabled":true}]';
COMMENT ON COLUMN public.inspection_templates.product_lines IS '产品线变体。示例 JSON：[{"id":"pl1","name":"地面-组串式","entries":[]}]';
COMMENT ON COLUMN public.inspection_templates.is_global IS '是否管理员全局模板';
COMMENT ON COLUMN public.inspection_templates.site_id IS '网格自定义模板；空为全局';
COMMENT ON COLUMN public.inspection_templates.assign_mode IS 'single 一人一单 / multi 多人共享单元';
COMMENT ON COLUMN public.inspection_templates.unit_label IS '多人模式单元名称，如网格/台';
COMMENT ON COLUMN public.inspection_templates.expense_enabled_default IS '新建案例是否默认开启报销';
COMMENT ON COLUMN public.inspection_templates.version IS '模板版本';
COMMENT ON COLUMN public.inspection_templates.created_at IS '创建时间';

CREATE TABLE public.import_batches (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  import_type varchar(32) NOT NULL
    CHECK (import_type IN ('gsp_case', 'po_order', 'settle_price', 'perf_price')),
  file_name varchar(255) NOT NULL,
  total_rows integer NOT NULL DEFAULT 0,
  success_rows integer NOT NULL DEFAULT 0,
  fail_rows integer NOT NULL DEFAULT 0,
  fail_detail jsonb NOT NULL DEFAULT '[]'::jsonb,
  operator_id uuid REFERENCES public.users(id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
COMMENT ON TABLE public.import_batches IS '财务四类表格导入批次';
COMMENT ON COLUMN public.import_batches.id IS '批次主键';
COMMENT ON COLUMN public.import_batches.import_type IS 'gsp_case / po_order / settle_price / perf_price';
COMMENT ON COLUMN public.import_batches.file_name IS '上传文件名';
COMMENT ON COLUMN public.import_batches.total_rows IS '总行数';
COMMENT ON COLUMN public.import_batches.success_rows IS '成功行数';
COMMENT ON COLUMN public.import_batches.fail_rows IS '失败行数';
COMMENT ON COLUMN public.import_batches.fail_detail IS '失败明细。示例 JSON：[{"row":2,"reason":"案例号重复"}]';
COMMENT ON COLUMN public.import_batches.operator_id IS '操作人';
COMMENT ON COLUMN public.import_batches.created_at IS '创建时间';
COMMENT ON COLUMN public.import_batches.updated_at IS '更新时间';

CREATE TABLE public.service_cases (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  gsp_case_no varchar(32) NOT NULL UNIQUE,
  project_name varchar(128) NOT NULL,
  service_type varchar(32),
  product_line varchar(64),
  creator varchar(32),
  province varchar(16),
  city varchar(32),
  site_desc text,
  site_id uuid REFERENCES public.sites(id) ON DELETE SET NULL,
  task_type varchar(128),
  task_template_id uuid REFERENCES public.inspection_templates(id) ON DELETE SET NULL,
  assign_mode varchar(16) NOT NULL DEFAULT 'single' CHECK (assign_mode IN ('single', 'multi')),
  planned_units integer NOT NULL DEFAULT 1 CHECK (planned_units >= 1),
  completed_units integer NOT NULL DEFAULT 0,
  expense_enabled boolean NOT NULL DEFAULT false,
  unit_label varchar(32) NOT NULL DEFAULT '台',
  region varchar(16) NOT NULL DEFAULT 'south_china',
  status varchar(20) NOT NULL DEFAULT 'pending_assign'
    CHECK (status IN ('pending_assign','assigned','working','finished','settle_review','settled','month_locked')),
  inspector_id uuid REFERENCES public.users(id) ON DELETE SET NULL,
  assign_by_id uuid REFERENCES public.users(id) ON DELETE SET NULL,
  assign_time timestamptz,
  assign_remark text,
  finish_time timestamptz,
  import_batch_id uuid REFERENCES public.import_batches(id) ON DELETE SET NULL,
  version integer NOT NULL DEFAULT 1,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
COMMENT ON TABLE public.service_cases IS '服务案例（GSP），派工到结算全生命周期';
COMMENT ON COLUMN public.service_cases.id IS '案例主键';
COMMENT ON COLUMN public.service_cases.gsp_case_no IS 'GSP 案例号，唯一';
COMMENT ON COLUMN public.service_cases.project_name IS '项目名称';
COMMENT ON COLUMN public.service_cases.service_type IS '需求类型，如巡检/故障恢复';
COMMENT ON COLUMN public.service_cases.product_line IS '产品线';
COMMENT ON COLUMN public.service_cases.creator IS 'GSP 创建人';
COMMENT ON COLUMN public.service_cases.province IS '省';
COMMENT ON COLUMN public.service_cases.city IS '市';
COMMENT ON COLUMN public.service_cases.site_desc IS '现场描述';
COMMENT ON COLUMN public.service_cases.site_id IS '归属网格';
COMMENT ON COLUMN public.service_cases.task_type IS '需求类型展示名';
COMMENT ON COLUMN public.service_cases.task_template_id IS '关联巡检/作业模板';
COMMENT ON COLUMN public.service_cases.assign_mode IS '单人/多人';
COMMENT ON COLUMN public.service_cases.planned_units IS '计划执行单元数';
COMMENT ON COLUMN public.service_cases.completed_units IS '已完成单元数';
COMMENT ON COLUMN public.service_cases.expense_enabled IS '是否允许报销';
COMMENT ON COLUMN public.service_cases.unit_label IS '单元名称快照';
COMMENT ON COLUMN public.service_cases.region IS 'south_china / yunnan';
COMMENT ON COLUMN public.service_cases.status IS 'pending_assign → month_locked';
COMMENT ON COLUMN public.service_cases.inspector_id IS '主工程师（兼容；多人以派单表为准）';
COMMENT ON COLUMN public.service_cases.assign_by_id IS '派单人';
COMMENT ON COLUMN public.service_cases.assign_time IS '派单时间';
COMMENT ON COLUMN public.service_cases.assign_remark IS '派单备注';
COMMENT ON COLUMN public.service_cases.finish_time IS '完工时间';
COMMENT ON COLUMN public.service_cases.import_batch_id IS '导入批次';
COMMENT ON COLUMN public.service_cases.version IS '乐观锁版本';
COMMENT ON COLUMN public.service_cases.created_at IS '创建时间';
COMMENT ON COLUMN public.service_cases.updated_at IS '更新时间';

CREATE TABLE public.case_assignments (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  service_case_id uuid NOT NULL REFERENCES public.service_cases(id) ON DELETE CASCADE,
  inspector_id uuid NOT NULL REFERENCES public.users(id) ON DELETE RESTRICT,
  assign_by_id uuid REFERENCES public.users(id) ON DELETE SET NULL,
  assign_time timestamptz,
  status varchar(16) NOT NULL DEFAULT 'assigned'
    CHECK (status IN ('assigned','working','done','withdrawn')),
  completed_units integer NOT NULL DEFAULT 0,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (service_case_id, inspector_id)
);
COMMENT ON TABLE public.case_assignments IS '案例派工：案例 × 工程师';
COMMENT ON COLUMN public.case_assignments.id IS '派单主键';
COMMENT ON COLUMN public.case_assignments.service_case_id IS '服务案例';
COMMENT ON COLUMN public.case_assignments.inspector_id IS '被派工程师';
COMMENT ON COLUMN public.case_assignments.assign_by_id IS '派单人';
COMMENT ON COLUMN public.case_assignments.assign_time IS '派单时间';
COMMENT ON COLUMN public.case_assignments.status IS 'assigned / working / done / withdrawn';
COMMENT ON COLUMN public.case_assignments.completed_units IS '该工程师完成单元数';
COMMENT ON COLUMN public.case_assignments.created_at IS '创建时间';
COMMENT ON COLUMN public.case_assignments.updated_at IS '更新时间';

CREATE TABLE public.case_work_units (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  service_case_id uuid NOT NULL REFERENCES public.service_cases(id) ON DELETE CASCADE,
  seq integer NOT NULL,
  title varchar(128),
  status varchar(16) NOT NULL DEFAULT 'open'
    CHECK (status IN ('open','claimed','submitted','completed','cancelled')),
  inspector_id uuid REFERENCES public.users(id) ON DELETE SET NULL,
  inspection_task_id uuid,
  claimed_at timestamptz,
  submitted_at timestamptz,
  completed_at timestamptz,
  submit_count integer NOT NULL DEFAULT 0,
  device_serial varchar(128),
  serial_photo_url text,
  serial_confirmed_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (service_case_id, seq)
);
COMMENT ON TABLE public.case_work_units IS '案例执行单元（多人共享池认领）';
COMMENT ON COLUMN public.case_work_units.id IS '单元主键';
COMMENT ON COLUMN public.case_work_units.service_case_id IS '服务案例';
COMMENT ON COLUMN public.case_work_units.seq IS '单元序号，案例内唯一';
COMMENT ON COLUMN public.case_work_units.title IS '单元标题';
COMMENT ON COLUMN public.case_work_units.status IS 'open 待认领 → completed';
COMMENT ON COLUMN public.case_work_units.inspector_id IS '认领工程师';
COMMENT ON COLUMN public.case_work_units.inspection_task_id IS '关联巡检任务（后置 FK）';
COMMENT ON COLUMN public.case_work_units.claimed_at IS '认领时间';
COMMENT ON COLUMN public.case_work_units.submitted_at IS '提交时间';
COMMENT ON COLUMN public.case_work_units.completed_at IS '完成时间';
COMMENT ON COLUMN public.case_work_units.submit_count IS '提交次数';
COMMENT ON COLUMN public.case_work_units.device_serial IS '现场确认的设备序列号';
COMMENT ON COLUMN public.case_work_units.serial_photo_url IS '铭牌照片 URL';
COMMENT ON COLUMN public.case_work_units.serial_confirmed_at IS '序列号确认时间';
COMMENT ON COLUMN public.case_work_units.created_at IS '创建时间';
COMMENT ON COLUMN public.case_work_units.updated_at IS '更新时间';

CREATE TABLE public.inspection_tasks (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  site_id uuid NOT NULL REFERENCES public.sites(id) ON DELETE RESTRICT,
  device_id uuid REFERENCES public.devices(id) ON DELETE SET NULL,
  task_name text NOT NULL,
  inspector_id uuid REFERENCES public.users(id) ON DELETE SET NULL,
  created_by_id uuid NOT NULL REFERENCES public.users(id) ON DELETE RESTRICT,
  service_case_id uuid REFERENCES public.service_cases(id) ON DELETE SET NULL,
  work_unit_id uuid REFERENCES public.case_work_units(id) ON DELETE SET NULL,
  task_type varchar(32) NOT NULL DEFAULT 'inspection',
  status text NOT NULL DEFAULT 'pending'
    CHECK (status IN ('pending','in_progress','submitted','approved','rejected','archived')),
  planned_date date,
  started_at timestamptz,
  completed_at timestamptz,
  ai_enabled boolean NOT NULL DEFAULT true,
  template_snapshot jsonb,
  created_at timestamptz NOT NULL DEFAULT now()
);
COMMENT ON TABLE public.inspection_tasks IS '巡检/作业任务';
COMMENT ON COLUMN public.inspection_tasks.id IS '任务主键';
COMMENT ON COLUMN public.inspection_tasks.site_id IS '作业网格';
COMMENT ON COLUMN public.inspection_tasks.device_id IS '关联设备，可空（现场再确认序列号）';
COMMENT ON COLUMN public.inspection_tasks.task_name IS '任务名称';
COMMENT ON COLUMN public.inspection_tasks.inspector_id IS '执行工程师';
COMMENT ON COLUMN public.inspection_tasks.created_by_id IS '创建人';
COMMENT ON COLUMN public.inspection_tasks.service_case_id IS '关联服务案例';
COMMENT ON COLUMN public.inspection_tasks.work_unit_id IS '关联执行单元';
COMMENT ON COLUMN public.inspection_tasks.task_type IS 'inspection 巡检 / service 服务作业';
COMMENT ON COLUMN public.inspection_tasks.status IS '任务状态';
COMMENT ON COLUMN public.inspection_tasks.planned_date IS '计划日期';
COMMENT ON COLUMN public.inspection_tasks.started_at IS '开工时间';
COMMENT ON COLUMN public.inspection_tasks.completed_at IS '完成时间';
COMMENT ON COLUMN public.inspection_tasks.ai_enabled IS '是否启用 AI 验图';
COMMENT ON COLUMN public.inspection_tasks.template_snapshot IS '创建时模板条目快照。示例 JSON：[{"id":"e1","name":"接地","checkType":"photo","aiEnabled":true}]';
COMMENT ON COLUMN public.inspection_tasks.created_at IS '创建时间';

ALTER TABLE public.case_work_units
  ADD CONSTRAINT case_work_units_inspection_task_id_fkey
  FOREIGN KEY (inspection_task_id) REFERENCES public.inspection_tasks(id) ON DELETE SET NULL;

CREATE TABLE public.inspection_records (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  task_id uuid NOT NULL REFERENCES public.inspection_tasks(id) ON DELETE CASCADE,
  device_type text NOT NULL
    CHECK (device_type IN ('string_inverter', 'central_inverter', 'energy_storage')),
  entries jsonb NOT NULL DEFAULT '[]'::jsonb,
  report_photos jsonb,
  location jsonb,
  status text NOT NULL DEFAULT 'draft'
    CHECK (status IN ('draft','submitted','approved','rejected','archived')),
  submitted_at timestamptz,
  approved_at timestamptz,
  approved_by_id uuid REFERENCES public.users(id) ON DELETE SET NULL,
  reject_reason jsonb,
  audit_trail jsonb NOT NULL DEFAULT '[]'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now()
);
COMMENT ON TABLE public.inspection_records IS '巡检记录（拍照条目与审核结论）';
COMMENT ON COLUMN public.inspection_records.id IS '记录主键';
COMMENT ON COLUMN public.inspection_records.task_id IS '所属任务';
COMMENT ON COLUMN public.inspection_records.device_type IS '设备类型快照';
COMMENT ON COLUMN public.inspection_records.entries IS '检查项结果。示例 JSON：[{"templateEntryId":"e1","photos":["https://cdn/x.jpg"],"aiResult":{"status":"pending","confidence":0,"reason":""},"manualResult":"pending","finalResult":null,"remark":""}]';
COMMENT ON COLUMN public.inspection_records.report_photos IS '报告附加照片 URL 列表。示例 JSON：["https://cdn/a.jpg"]';
COMMENT ON COLUMN public.inspection_records.location IS '提交时定位留痕。示例 JSON：{"status":"ok","latitude":22.5,"longitude":114.0,"accuracyMeters":12}';
COMMENT ON COLUMN public.inspection_records.status IS 'draft / submitted / approved / rejected / archived';
COMMENT ON COLUMN public.inspection_records.submitted_at IS '提交时间';
COMMENT ON COLUMN public.inspection_records.approved_at IS '通过时间';
COMMENT ON COLUMN public.inspection_records.approved_by_id IS '审核人';
COMMENT ON COLUMN public.inspection_records.reject_reason IS '驳回原因。示例 JSON：{"reason":"接地照片不清","entryIds":["e1"]}';
COMMENT ON COLUMN public.inspection_records.audit_trail IS '操作追溯。示例 JSON：[{"action":"submitted","at":"2026-08-27T12:00:00Z","byName":"张三"}]';
COMMENT ON COLUMN public.inspection_records.created_at IS '创建时间';

CREATE TABLE public.vision_jobs (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  inspection_record_id uuid NOT NULL REFERENCES public.inspection_records(id) ON DELETE CASCADE,
  template_entry_id text,
  status text NOT NULL DEFAULT 'pending'
    CHECK (status IN ('pending','running','done','failed')),
  attempts integer NOT NULL DEFAULT 0,
  result jsonb,
  error_message text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
COMMENT ON TABLE public.vision_jobs IS '硅基流动验图任务队列';
COMMENT ON COLUMN public.vision_jobs.id IS '任务主键';
COMMENT ON COLUMN public.vision_jobs.inspection_record_id IS '巡检记录';
COMMENT ON COLUMN public.vision_jobs.template_entry_id IS '检查项 ID；空表示整单';
COMMENT ON COLUMN public.vision_jobs.status IS 'pending / running / done / failed';
COMMENT ON COLUMN public.vision_jobs.attempts IS '尝试次数';
COMMENT ON COLUMN public.vision_jobs.result IS '模型输出。示例 JSON：{"status":"pass","confidence":0.92,"reason":"接地辫可见"}';
COMMENT ON COLUMN public.vision_jobs.error_message IS '失败原因';
COMMENT ON COLUMN public.vision_jobs.created_at IS '创建时间';
COMMENT ON COLUMN public.vision_jobs.updated_at IS '更新时间';

CREATE TABLE public.ai_hard_rules (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  code varchar(32) NOT NULL UNIQUE,
  name varchar(64) NOT NULL,
  match_mode varchar(32) NOT NULL DEFAULT 'title_includes'
    CHECK (match_mode IN ('title_exact','title_includes','criteria_includes')),
  match_pattern varchar(255) NOT NULL,
  prompt_text text NOT NULL,
  json_schema_hint text,
  enabled boolean NOT NULL DEFAULT true,
  enforce_mode varchar(16) NOT NULL DEFAULT 'strict'
    CHECK (enforce_mode IN ('strict','normal','off')),
  version integer NOT NULL DEFAULT 1,
  change_note text,
  updated_by_id uuid REFERENCES public.users(id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
COMMENT ON TABLE public.ai_hard_rules IS 'AI 验图硬规则（超管可配）';
COMMENT ON COLUMN public.ai_hard_rules.id IS '规则主键';
COMMENT ON COLUMN public.ai_hard_rules.code IS '稳定编码：ac_side / grounding / dc_side / fault_record / sungrow / mount_fix';
COMMENT ON COLUMN public.ai_hard_rules.name IS '规则名称';
COMMENT ON COLUMN public.ai_hard_rules.match_mode IS '标题精确 / 标题包含 / 全文包含';
COMMENT ON COLUMN public.ai_hard_rules.match_pattern IS '匹配关键词，多个用 | 分隔';
COMMENT ON COLUMN public.ai_hard_rules.prompt_text IS '插入模型的硬规则正文';
COMMENT ON COLUMN public.ai_hard_rules.json_schema_hint IS '期望 JSON 结构说明';
COMMENT ON COLUMN public.ai_hard_rules.enabled IS '是否启用';
COMMENT ON COLUMN public.ai_hard_rules.enforce_mode IS 'strict 二次复核 / normal 仅主提示 / off 关闭';
COMMENT ON COLUMN public.ai_hard_rules.version IS '版本';
COMMENT ON COLUMN public.ai_hard_rules.change_note IS '变更说明';
COMMENT ON COLUMN public.ai_hard_rules.updated_by_id IS '最后修改人';
COMMENT ON COLUMN public.ai_hard_rules.created_at IS '创建时间';
COMMENT ON COLUMN public.ai_hard_rules.updated_at IS '更新时间';

-- ========== 报销 / 财务 ==========
CREATE TABLE public.case_expense_claims (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  service_case_id uuid NOT NULL REFERENCES public.service_cases(id) ON DELETE CASCADE,
  work_unit_id uuid REFERENCES public.case_work_units(id) ON DELETE SET NULL,
  inspector_id uuid NOT NULL REFERENCES public.users(id) ON DELETE RESTRICT,
  amount numeric(12, 2) NOT NULL DEFAULT 0,
  claim_amount numeric(12, 2) NOT NULL DEFAULT 0,
  line_items jsonb NOT NULL DEFAULT '[]'::jsonb,
  voucher_urls jsonb NOT NULL DEFAULT '[]'::jsonb,
  trip_skipped boolean NOT NULL DEFAULT false,
  note text,
  status varchar(16) NOT NULL DEFAULT 'draft'
    CHECK (status IN ('draft','submitted','approved','rejected')),
  review_by_id uuid REFERENCES public.users(id) ON DELETE SET NULL,
  review_at timestamptz,
  review_note text,
  month varchar(7),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
COMMENT ON TABLE public.case_expense_claims IS '案例报销单（案例 × 工程师）';
COMMENT ON COLUMN public.case_expense_claims.id IS '报销主键';
COMMENT ON COLUMN public.case_expense_claims.service_case_id IS '服务案例';
COMMENT ON COLUMN public.case_expense_claims.work_unit_id IS '关联作业单元（兼容）';
COMMENT ON COLUMN public.case_expense_claims.inspector_id IS '申报工程师';
COMMENT ON COLUMN public.case_expense_claims.amount IS '核定金额（通过前等于申报）';
COMMENT ON COLUMN public.case_expense_claims.claim_amount IS '申报金额';
COMMENT ON COLUMN public.case_expense_claims.line_items IS '费用明细。示例 JSON：[{"id":"l1","type":"trip","content":"往返电站","amount":120,"voucherUrls":[]}]';
COMMENT ON COLUMN public.case_expense_claims.voucher_urls IS '凭证 URL 列表。示例 JSON：["https://cdn/v.jpg"]';
COMMENT ON COLUMN public.case_expense_claims.trip_skipped IS '无行程（不强制里程）';
COMMENT ON COLUMN public.case_expense_claims.note IS '备注';
COMMENT ON COLUMN public.case_expense_claims.status IS 'draft / submitted / approved / rejected';
COMMENT ON COLUMN public.case_expense_claims.review_by_id IS '审核人';
COMMENT ON COLUMN public.case_expense_claims.review_at IS '审核时间';
COMMENT ON COLUMN public.case_expense_claims.review_note IS '审核意见';
COMMENT ON COLUMN public.case_expense_claims.month IS '归属月份 YYYY-MM';
COMMENT ON COLUMN public.case_expense_claims.created_at IS '创建时间';
COMMENT ON COLUMN public.case_expense_claims.updated_at IS '更新时间';

CREATE TABLE public.po_orders (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  po_no varchar(64) NOT NULL UNIQUE,
  gsp_case_no varchar(32) NOT NULL,
  service_case_id uuid REFERENCES public.service_cases(id) ON DELETE SET NULL,
  po_total_amount numeric(12, 2) NOT NULL DEFAULT 0,
  demand_date date,
  demander varchar(64),
  demand_type varchar(32),
  product_line varchar(64),
  product_model varchar(64),
  product_qty numeric(12, 2),
  fault_phenomenon text,
  fault_level varchar(64),
  duration_req varchar(64),
  demand_desc text,
  project_area varchar(64),
  project_country varchar(32),
  project_region varchar(64),
  province varchar(16),
  project_name varchar(128),
  project_scene varchar(32),
  submitter varchar(64),
  dingtalk_created_at timestamptz,
  dingtalk_updated_at timestamptz,
  match_status varchar(16) NOT NULL DEFAULT 'pending' CHECK (match_status IN ('matched','pending')),
  import_batch_id uuid REFERENCES public.import_batches(id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
COMMENT ON TABLE public.po_orders IS '钉钉 PO 订单';
COMMENT ON COLUMN public.po_orders.id IS 'PO 主键';
COMMENT ON COLUMN public.po_orders.po_no IS 'PO 号，唯一';
COMMENT ON COLUMN public.po_orders.gsp_case_no IS '对应 GSP 案例号';
COMMENT ON COLUMN public.po_orders.service_case_id IS '匹配到的服务案例';
COMMENT ON COLUMN public.po_orders.po_total_amount IS 'PO 总金额';
COMMENT ON COLUMN public.po_orders.demand_date IS '需求日期';
COMMENT ON COLUMN public.po_orders.demander IS '需求人';
COMMENT ON COLUMN public.po_orders.demand_type IS '需求类型';
COMMENT ON COLUMN public.po_orders.product_line IS '产品线';
COMMENT ON COLUMN public.po_orders.product_model IS '产品型号';
COMMENT ON COLUMN public.po_orders.product_qty IS '数量';
COMMENT ON COLUMN public.po_orders.fault_phenomenon IS '故障现象';
COMMENT ON COLUMN public.po_orders.fault_level IS '故障等级';
COMMENT ON COLUMN public.po_orders.duration_req IS '时效要求';
COMMENT ON COLUMN public.po_orders.demand_desc IS '需求描述';
COMMENT ON COLUMN public.po_orders.project_area IS '项目片区';
COMMENT ON COLUMN public.po_orders.project_country IS '国家';
COMMENT ON COLUMN public.po_orders.project_region IS '区域';
COMMENT ON COLUMN public.po_orders.province IS '省';
COMMENT ON COLUMN public.po_orders.project_name IS '项目名称';
COMMENT ON COLUMN public.po_orders.project_scene IS '场景';
COMMENT ON COLUMN public.po_orders.submitter IS '提交人';
COMMENT ON COLUMN public.po_orders.dingtalk_created_at IS '钉钉创建时间';
COMMENT ON COLUMN public.po_orders.dingtalk_updated_at IS '钉钉更新时间';
COMMENT ON COLUMN public.po_orders.match_status IS 'matched / pending';
COMMENT ON COLUMN public.po_orders.import_batch_id IS '导入批次';
COMMENT ON COLUMN public.po_orders.created_at IS '创建时间';
COMMENT ON COLUMN public.po_orders.updated_at IS '更新时间';

CREATE TABLE public.po_items (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  po_order_id uuid NOT NULL REFERENCES public.po_orders(id) ON DELETE CASCADE,
  source_row integer,
  item_category varchar(16) NOT NULL CHECK (item_category IN ('special','general')),
  item_code varchar(255) NOT NULL,
  item_name varchar(255) NOT NULL,
  item_desc text,
  unit varchar(32),
  qty numeric(12, 2) NOT NULL DEFAULT 0,
  settle_price numeric(12, 2),
  perf_price numeric(12, 2),
  item_revenue numeric(12, 2) NOT NULL DEFAULT 0,
  item_perf numeric(12, 2) NOT NULL DEFAULT 0,
  price_status varchar(20) NOT NULL DEFAULT 'pending_price'
    CHECK (price_status IN ('ok','pending_price','ignored')),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
COMMENT ON TABLE public.po_items IS 'PO 明细行';
COMMENT ON COLUMN public.po_items.id IS '明细主键';
COMMENT ON COLUMN public.po_items.po_order_id IS '所属 PO';
COMMENT ON COLUMN public.po_items.source_row IS 'Excel 源行号';
COMMENT ON COLUMN public.po_items.item_category IS 'special 专项 / general 通用';
COMMENT ON COLUMN public.po_items.item_code IS '物料/价格编码';
COMMENT ON COLUMN public.po_items.item_name IS '项目名称';
COMMENT ON COLUMN public.po_items.item_desc IS '描述';
COMMENT ON COLUMN public.po_items.unit IS '单位';
COMMENT ON COLUMN public.po_items.qty IS '数量';
COMMENT ON COLUMN public.po_items.settle_price IS '甲方结算单价';
COMMENT ON COLUMN public.po_items.perf_price IS '内部绩效单价';
COMMENT ON COLUMN public.po_items.item_revenue IS '行收入';
COMMENT ON COLUMN public.po_items.item_perf IS '行绩效';
COMMENT ON COLUMN public.po_items.price_status IS 'ok / pending_price / ignored';
COMMENT ON COLUMN public.po_items.created_at IS '创建时间';
COMMENT ON COLUMN public.po_items.updated_at IS '更新时间';

CREATE TABLE public.price_library (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  price_type varchar(16) NOT NULL CHECK (price_type IN ('settle','perf')),
  item_code text NOT NULL,
  item_name text NOT NULL,
  item_desc text,
  unit varchar(32),
  product_model varchar(64),
  scene varchar(32),
  region varchar(16),
  coop_type varchar(16),
  work_hours numeric(12, 2),
  unit_price numeric(12, 2) NOT NULL,
  effective_date date NOT NULL,
  status varchar(16) NOT NULL DEFAULT 'active' CHECK (status IN ('active','inactive')),
  created_by_id uuid REFERENCES public.users(id) ON DELETE SET NULL,
  change_remark text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
COMMENT ON TABLE public.price_library IS '价格库：甲方结算价 / 内部绩效价';
COMMENT ON COLUMN public.price_library.id IS '价格主键';
COMMENT ON COLUMN public.price_library.price_type IS 'settle 结算 / perf 绩效';
COMMENT ON COLUMN public.price_library.item_code IS '价格编码';
COMMENT ON COLUMN public.price_library.item_name IS '项目名称';
COMMENT ON COLUMN public.price_library.item_desc IS '描述';
COMMENT ON COLUMN public.price_library.unit IS '单位';
COMMENT ON COLUMN public.price_library.product_model IS '产品型号';
COMMENT ON COLUMN public.price_library.scene IS '场景';
COMMENT ON COLUMN public.price_library.region IS '区域';
COMMENT ON COLUMN public.price_library.coop_type IS '合作类型';
COMMENT ON COLUMN public.price_library.work_hours IS '工时';
COMMENT ON COLUMN public.price_library.unit_price IS '单价';
COMMENT ON COLUMN public.price_library.effective_date IS '生效日';
COMMENT ON COLUMN public.price_library.status IS 'active / inactive';
COMMENT ON COLUMN public.price_library.created_by_id IS '创建人';
COMMENT ON COLUMN public.price_library.change_remark IS '变更说明';
COMMENT ON COLUMN public.price_library.created_at IS '创建时间';
COMMENT ON COLUMN public.price_library.updated_at IS '更新时间';

CREATE TABLE public.item_price_mappings (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  source_item_name varchar(255) NOT NULL UNIQUE,
  normalized_source varchar(255) NOT NULL,
  target_item_code varchar(255) NOT NULL,
  mapping_type varchar(16) NOT NULL DEFAULT 'manual' CHECK (mapping_type IN ('manual','builtin')),
  confidence numeric(5, 4) NOT NULL DEFAULT 1,
  status varchar(16) NOT NULL DEFAULT 'active' CHECK (status IN ('active','inactive')),
  created_by_id uuid REFERENCES public.users(id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
COMMENT ON TABLE public.item_price_mappings IS 'PO 项目名到价格编码的映射';
COMMENT ON COLUMN public.item_price_mappings.id IS '映射主键';
COMMENT ON COLUMN public.item_price_mappings.source_item_name IS '源项目名';
COMMENT ON COLUMN public.item_price_mappings.normalized_source IS '归一化源名';
COMMENT ON COLUMN public.item_price_mappings.target_item_code IS '目标价格编码';
COMMENT ON COLUMN public.item_price_mappings.mapping_type IS 'manual / builtin';
COMMENT ON COLUMN public.item_price_mappings.confidence IS '置信度 0–1';
COMMENT ON COLUMN public.item_price_mappings.status IS 'active / inactive';
COMMENT ON COLUMN public.item_price_mappings.created_by_id IS '创建人';
COMMENT ON COLUMN public.item_price_mappings.created_at IS '创建时间';
COMMENT ON COLUMN public.item_price_mappings.updated_at IS '更新时间';

CREATE TABLE public.case_performances (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  service_case_id uuid NOT NULL UNIQUE REFERENCES public.service_cases(id) ON DELETE CASCADE,
  gsp_case_no varchar(32) NOT NULL UNIQUE,
  inspector_id uuid REFERENCES public.users(id) ON DELETE SET NULL,
  perf_base numeric(12, 2) NOT NULL DEFAULT 0,
  deduction numeric(12, 2) NOT NULL DEFAULT 0,
  deduction_reason text,
  deduct_by_id uuid REFERENCES public.users(id) ON DELETE SET NULL,
  deduction_status varchar(16) NOT NULL DEFAULT 'none'
    CHECK (deduction_status IN ('none','pending','approved','rejected')),
  deduction_review_by_id uuid REFERENCES public.users(id) ON DELETE SET NULL,
  deduction_review_time timestamptz,
  perf_final numeric(12, 2) NOT NULL DEFAULT 0,
  case_revenue numeric(12, 2) NOT NULL DEFAULT 0,
  review_status varchar(16) NOT NULL DEFAULT 'pending'
    CHECK (review_status IN ('pending','approved','rejected')),
  reviewer_id uuid REFERENCES public.users(id) ON DELETE SET NULL,
  review_time timestamptz,
  review_comment text,
  month varchar(7),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
COMMENT ON TABLE public.case_performances IS '案例绩效账本';
COMMENT ON COLUMN public.case_performances.id IS '账本主键';
COMMENT ON COLUMN public.case_performances.service_case_id IS '服务案例，一对一';
COMMENT ON COLUMN public.case_performances.gsp_case_no IS 'GSP 案例号';
COMMENT ON COLUMN public.case_performances.inspector_id IS '主工程师';
COMMENT ON COLUMN public.case_performances.perf_base IS '绩效基数';
COMMENT ON COLUMN public.case_performances.deduction IS '扣减金额';
COMMENT ON COLUMN public.case_performances.deduction_reason IS '扣减原因';
COMMENT ON COLUMN public.case_performances.deduct_by_id IS '扣减登记人';
COMMENT ON COLUMN public.case_performances.deduction_status IS '扣减审批状态';
COMMENT ON COLUMN public.case_performances.deduction_review_by_id IS '扣减审核人';
COMMENT ON COLUMN public.case_performances.deduction_review_time IS '扣减审核时间';
COMMENT ON COLUMN public.case_performances.perf_final IS '最终绩效';
COMMENT ON COLUMN public.case_performances.case_revenue IS '案例收入';
COMMENT ON COLUMN public.case_performances.review_status IS '结算审核状态';
COMMENT ON COLUMN public.case_performances.reviewer_id IS '结算审核人';
COMMENT ON COLUMN public.case_performances.review_time IS '结算审核时间';
COMMENT ON COLUMN public.case_performances.review_comment IS '审核意见';
COMMENT ON COLUMN public.case_performances.month IS '归属月份 YYYY-MM';
COMMENT ON COLUMN public.case_performances.created_at IS '创建时间';
COMMENT ON COLUMN public.case_performances.updated_at IS '更新时间';

CREATE TABLE public.case_perf_shares (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  service_case_id uuid NOT NULL REFERENCES public.service_cases(id) ON DELETE CASCADE,
  inspector_id uuid NOT NULL REFERENCES public.users(id) ON DELETE RESTRICT,
  completed_units integer NOT NULL DEFAULT 0,
  share_ratio numeric(8, 6) NOT NULL DEFAULT 0,
  perf_amount numeric(12, 2) NOT NULL DEFAULT 0,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (service_case_id, inspector_id)
);
COMMENT ON TABLE public.case_perf_shares IS '多人绩效分账';
COMMENT ON COLUMN public.case_perf_shares.id IS '分账主键';
COMMENT ON COLUMN public.case_perf_shares.service_case_id IS '服务案例';
COMMENT ON COLUMN public.case_perf_shares.inspector_id IS '工程师';
COMMENT ON COLUMN public.case_perf_shares.completed_units IS '完成单元数';
COMMENT ON COLUMN public.case_perf_shares.share_ratio IS '分账比例 0–1';
COMMENT ON COLUMN public.case_perf_shares.perf_amount IS '分得绩效';
COMMENT ON COLUMN public.case_perf_shares.created_at IS '创建时间';
COMMENT ON COLUMN public.case_perf_shares.updated_at IS '更新时间';

CREATE TABLE public.assessments (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  month varchar(7) NOT NULL,
  user_id uuid NOT NULL REFERENCES public.users(id) ON DELETE CASCADE,
  user_role varchar(24) NOT NULL,
  internal_score numeric(5, 2) NOT NULL DEFAULT 0,
  sungrow_score numeric(5, 2) NOT NULL DEFAULT 0,
  total_score numeric(5, 2) NOT NULL DEFAULT 0,
  rank_group varchar(24) NOT NULL CHECK (rank_group IN ('station_manager','inspector')),
  rank_result varchar(24),
  site_rank_result varchar(24),
  reward_amount numeric(12, 2) NOT NULL DEFAULT 0,
  tool_subsidy numeric(12, 2) NOT NULL DEFAULT 0,
  other_subsidy numeric(12, 2) NOT NULL DEFAULT 0,
  subsidy_remark text,
  correction_amount numeric(12, 2) NOT NULL DEFAULT 0,
  correction_reason text,
  event_penalty numeric(12, 2) NOT NULL DEFAULT 0,
  score_detail jsonb,
  updated_by_id uuid REFERENCES public.users(id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (month, user_id)
);
COMMENT ON TABLE public.assessments IS '月度考核';
COMMENT ON COLUMN public.assessments.id IS '考核主键';
COMMENT ON COLUMN public.assessments.month IS '月份 YYYY-MM';
COMMENT ON COLUMN public.assessments.user_id IS '被考核人';
COMMENT ON COLUMN public.assessments.user_role IS '考核时角色';
COMMENT ON COLUMN public.assessments.internal_score IS '内部得分';
COMMENT ON COLUMN public.assessments.sungrow_score IS '阳光云得分';
COMMENT ON COLUMN public.assessments.total_score IS '总分';
COMMENT ON COLUMN public.assessments.rank_group IS 'station_manager / inspector';
COMMENT ON COLUMN public.assessments.rank_result IS '全司排名档';
COMMENT ON COLUMN public.assessments.site_rank_result IS '网格内参考名次';
COMMENT ON COLUMN public.assessments.reward_amount IS '奖励金额';
COMMENT ON COLUMN public.assessments.tool_subsidy IS '工具补贴';
COMMENT ON COLUMN public.assessments.other_subsidy IS '其他补贴';
COMMENT ON COLUMN public.assessments.subsidy_remark IS '补贴说明';
COMMENT ON COLUMN public.assessments.correction_amount IS '纠偏金额';
COMMENT ON COLUMN public.assessments.correction_reason IS '纠偏原因';
COMMENT ON COLUMN public.assessments.event_penalty IS '专业事件扣罚合计';
COMMENT ON COLUMN public.assessments.score_detail IS '分项打分。示例 JSON：{"version":1,"items":[{"ruleItemId":"r1","score":8}],"total":8}';
COMMENT ON COLUMN public.assessments.updated_by_id IS '最后修改人';
COMMENT ON COLUMN public.assessments.created_at IS '创建时间';
COMMENT ON COLUMN public.assessments.updated_at IS '更新时间';

CREATE TABLE public.assessment_events (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  month varchar(7) NOT NULL,
  user_id uuid NOT NULL REFERENCES public.users(id) ON DELETE CASCADE,
  service_case_id uuid REFERENCES public.service_cases(id) ON DELETE SET NULL,
  category varchar(64) NOT NULL,
  content text NOT NULL,
  unit varchar(16) NOT NULL DEFAULT '次',
  qty numeric(12, 2) NOT NULL DEFAULT 1,
  unit_amount numeric(12, 2),
  amount numeric(12, 2) NOT NULL DEFAULT 0,
  remark text,
  created_by_id uuid REFERENCES public.users(id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
COMMENT ON TABLE public.assessment_events IS '考核专业指标事件（扣罚）';
COMMENT ON COLUMN public.assessment_events.id IS '事件主键';
COMMENT ON COLUMN public.assessment_events.month IS '月份 YYYY-MM';
COMMENT ON COLUMN public.assessment_events.user_id IS '当事人';
COMMENT ON COLUMN public.assessment_events.service_case_id IS '关联案例';
COMMENT ON COLUMN public.assessment_events.category IS '指标分类';
COMMENT ON COLUMN public.assessment_events.content IS '事件内容';
COMMENT ON COLUMN public.assessment_events.unit IS '计量单位';
COMMENT ON COLUMN public.assessment_events.qty IS '数量';
COMMENT ON COLUMN public.assessment_events.unit_amount IS '标准单价';
COMMENT ON COLUMN public.assessment_events.amount IS '扣罚金额（正数表示扣减）';
COMMENT ON COLUMN public.assessment_events.remark IS '备注';
COMMENT ON COLUMN public.assessment_events.created_by_id IS '登记人';
COMMENT ON COLUMN public.assessment_events.created_at IS '创建时间';
COMMENT ON COLUMN public.assessment_events.updated_at IS '更新时间';

CREATE TABLE public.assessment_score_rules (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  items jsonb NOT NULL DEFAULT '[]'::jsonb,
  version integer NOT NULL DEFAULT 1,
  updated_by_id uuid REFERENCES public.users(id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
COMMENT ON TABLE public.assessment_score_rules IS '全公司共用考核打分规则';
COMMENT ON COLUMN public.assessment_score_rules.id IS '规则主键';
COMMENT ON COLUMN public.assessment_score_rules.items IS '打分项。示例 JSON：[{"id":"r1","name":"质量","max":10}]';
COMMENT ON COLUMN public.assessment_score_rules.version IS '版本';
COMMENT ON COLUMN public.assessment_score_rules.updated_by_id IS '最后修改人';
COMMENT ON COLUMN public.assessment_score_rules.created_at IS '创建时间';
COMMENT ON COLUMN public.assessment_score_rules.updated_at IS '更新时间';

CREATE TABLE public.monthly_settlements (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  month varchar(7) NOT NULL,
  user_id uuid NOT NULL REFERENCES public.users(id) ON DELETE CASCADE,
  perf_total numeric(12, 2) NOT NULL DEFAULT 0,
  reward_total numeric(12, 2) NOT NULL DEFAULT 0,
  subsidy_total numeric(12, 2) NOT NULL DEFAULT 0,
  correction_total numeric(12, 2) NOT NULL DEFAULT 0,
  event_penalty numeric(12, 2) NOT NULL DEFAULT 0,
  expense_total numeric(12, 2) NOT NULL DEFAULT 0,
  final_amount numeric(12, 2) NOT NULL DEFAULT 0,
  status varchar(16) NOT NULL DEFAULT 'draft' CHECK (status IN ('draft','corrected','locked')),
  locked_by_id uuid REFERENCES public.users(id) ON DELETE SET NULL,
  locked_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (month, user_id)
);
COMMENT ON TABLE public.monthly_settlements IS '月度结算 / 发薪';
COMMENT ON COLUMN public.monthly_settlements.id IS '月结主键';
COMMENT ON COLUMN public.monthly_settlements.month IS '月份 YYYY-MM';
COMMENT ON COLUMN public.monthly_settlements.user_id IS '结算对象';
COMMENT ON COLUMN public.monthly_settlements.perf_total IS '绩效合计';
COMMENT ON COLUMN public.monthly_settlements.reward_total IS '奖励合计';
COMMENT ON COLUMN public.monthly_settlements.subsidy_total IS '补贴合计';
COMMENT ON COLUMN public.monthly_settlements.correction_total IS '纠偏合计';
COMMENT ON COLUMN public.monthly_settlements.event_penalty IS '事件扣罚';
COMMENT ON COLUMN public.monthly_settlements.expense_total IS '已通过报销合计';
COMMENT ON COLUMN public.monthly_settlements.final_amount IS '应发金额';
COMMENT ON COLUMN public.monthly_settlements.status IS 'draft / corrected / locked';
COMMENT ON COLUMN public.monthly_settlements.locked_by_id IS '锁定人';
COMMENT ON COLUMN public.monthly_settlements.locked_at IS '锁定时间';
COMMENT ON COLUMN public.monthly_settlements.created_at IS '创建时间';
COMMENT ON COLUMN public.monthly_settlements.updated_at IS '更新时间';

CREATE TABLE public.change_logs (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  entity_type varchar(32) NOT NULL,
  entity_id varchar(64) NOT NULL,
  field varchar(64) NOT NULL,
  old_value text,
  new_value text,
  operator_id uuid REFERENCES public.users(id) ON DELETE SET NULL,
  reason text,
  created_at timestamptz NOT NULL DEFAULT now()
);
COMMENT ON TABLE public.change_logs IS '关键字段变更日志';
COMMENT ON COLUMN public.change_logs.id IS '日志主键';
COMMENT ON COLUMN public.change_logs.entity_type IS '实体类型';
COMMENT ON COLUMN public.change_logs.entity_id IS '实体 ID';
COMMENT ON COLUMN public.change_logs.field IS '字段名';
COMMENT ON COLUMN public.change_logs.old_value IS '旧值';
COMMENT ON COLUMN public.change_logs.new_value IS '新值';
COMMENT ON COLUMN public.change_logs.operator_id IS '操作人';
COMMENT ON COLUMN public.change_logs.reason IS '原因';
COMMENT ON COLUMN public.change_logs.created_at IS '创建时间';

CREATE INDEX idx_site_members_user ON public.site_members(user_id);
CREATE INDEX idx_devices_site ON public.devices(site_id);
CREATE INDEX idx_tasks_site ON public.inspection_tasks(site_id);
CREATE INDEX idx_tasks_inspector ON public.inspection_tasks(inspector_id);
CREATE INDEX idx_tasks_case ON public.inspection_tasks(service_case_id);
CREATE INDEX idx_records_task ON public.inspection_records(task_id);
CREATE INDEX idx_cases_site ON public.service_cases(site_id);
CREATE INDEX idx_cases_status ON public.service_cases(status);
CREATE INDEX idx_assignments_inspector ON public.case_assignments(inspector_id);
CREATE INDEX idx_units_case ON public.case_work_units(service_case_id);
CREATE INDEX idx_expense_inspector ON public.case_expense_claims(inspector_id);
CREATE INDEX idx_po_gsp ON public.po_orders(gsp_case_no);
CREATE INDEX idx_vision_record ON public.vision_jobs(inspection_record_id);
CREATE INDEX idx_assessment_events_user ON public.assessment_events(user_id, month);

CREATE TRIGGER trg_users_updated_at BEFORE UPDATE ON public.users
  FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();
CREATE TRIGGER trg_import_batches_updated_at BEFORE UPDATE ON public.import_batches
  FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();
CREATE TRIGGER trg_service_cases_updated_at BEFORE UPDATE ON public.service_cases
  FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();
CREATE TRIGGER trg_case_assignments_updated_at BEFORE UPDATE ON public.case_assignments
  FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();
CREATE TRIGGER trg_case_work_units_updated_at BEFORE UPDATE ON public.case_work_units
  FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();
CREATE TRIGGER trg_vision_jobs_updated_at BEFORE UPDATE ON public.vision_jobs
  FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();
CREATE TRIGGER trg_ai_hard_rules_updated_at BEFORE UPDATE ON public.ai_hard_rules
  FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();
CREATE TRIGGER trg_case_expense_claims_updated_at BEFORE UPDATE ON public.case_expense_claims
  FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();
CREATE TRIGGER trg_po_orders_updated_at BEFORE UPDATE ON public.po_orders
  FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();
CREATE TRIGGER trg_po_items_updated_at BEFORE UPDATE ON public.po_items
  FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();
CREATE TRIGGER trg_price_library_updated_at BEFORE UPDATE ON public.price_library
  FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();
CREATE TRIGGER trg_item_price_mappings_updated_at BEFORE UPDATE ON public.item_price_mappings
  FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();
CREATE TRIGGER trg_case_performances_updated_at BEFORE UPDATE ON public.case_performances
  FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();
CREATE TRIGGER trg_case_perf_shares_updated_at BEFORE UPDATE ON public.case_perf_shares
  FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();
CREATE TRIGGER trg_assessments_updated_at BEFORE UPDATE ON public.assessments
  FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();
CREATE TRIGGER trg_assessment_events_updated_at BEFORE UPDATE ON public.assessment_events
  FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();
CREATE TRIGGER trg_assessment_score_rules_updated_at BEFORE UPDATE ON public.assessment_score_rules
  FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();
CREATE TRIGGER trg_monthly_settlements_updated_at BEFORE UPDATE ON public.monthly_settlements
  FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();

-- 种子：超管 + 默认模板 + 硬规则
INSERT INTO public.users (username, password, real_name, phone, role, roles, status)
VALUES (
  'admin',
  crypt('admin123', gen_salt('bf')),
  '超级管理员',
  '13800000000',
  'super_admin',
  '["super_admin"]'::jsonb,
  'active'
);

INSERT INTO public.inspection_templates (name, device_type, entries, assign_mode, unit_label)
VALUES (
  '组串巡检',
  'string_inverter',
  '[
    {"id":"gnd","name":"接地 / GND","description":"箱内主 PE 与箱外机壳接地双连接点","isRequired":true,"order":1,"samplePhotos":[],"checkType":"photo","aiEnabled":true},
    {"id":"dc","name":"直流侧安装","description":"空闲孔防护盖齐全","isRequired":true,"order":2,"samplePhotos":[],"checkType":"photo","aiEnabled":true},
    {"id":"ac","name":"交流侧安装","description":"主 PE 铜编织带 / 铜芯压接合规","isRequired":true,"order":3,"samplePhotos":[],"checkType":"photo","aiEnabled":true},
    {"id":"fix","name":"安装固定","description":"抱箍、螺栓关键部位","isRequired":true,"order":4,"samplePhotos":[],"checkType":"photo","aiEnabled":true},
    {"id":"fault","name":"故障记录","description":"实时故障页与历史故障页","isRequired":false,"order":5,"samplePhotos":[],"checkType":"photo","aiEnabled":true},
    {"id":"cloud","name":"阳光云截图","description":"完整应用截图与设备序列号","isRequired":true,"order":6,"samplePhotos":[],"checkType":"photo","aiEnabled":true}
  ]'::jsonb,
  'single',
  '台'
);

INSERT INTO public.ai_hard_rules (code, name, match_mode, match_pattern, prompt_text, enforce_mode) VALUES
('grounding', '接地 / GND', 'title_includes', '接地|GND|PE',
 '必须同时看到箱内主 PE 连接点和箱外机壳接地辫；缺任一连接点判不合格。', 'strict'),
('dc_side', '直流侧安装', 'title_includes', '直流',
 '空闲孔必须有防护盖；缺失防护盖判不合格。', 'strict'),
('ac_side', '交流侧安装', 'title_includes', '交流|AC',
 '主 PE 应为铜编织带或铜芯压接，虚接、铝线替代判不合格。', 'strict'),
('mount_fix', '安装固定', 'title_includes', '固定|抱箍|安装',
 '需能看清抱箍与螺栓紧固；照片过远或关键部位被遮挡判不合格。', 'normal'),
('fault_record', '故障记录', 'title_includes', '故障',
 '需同时提供实时故障页与历史故障页两类证据。', 'strict'),
('sungrow', '阳光云截图', 'title_includes', '阳光云|序列号',
 '截图须完整且能读出设备序列号。', 'strict');
