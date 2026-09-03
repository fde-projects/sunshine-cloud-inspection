import { randomUUID } from "crypto";
import { adminGql } from "@/lib/hasura-admin";
import { rematchUnboundCases } from "./finance/demand-type-match";
import { HARD_RULE_DEFAULTS } from "./hard-rule-defaults";
import {
  parseHardRuleBindings,
  parseHardRuleSamples,
  serializeHardRuleHint,
  splitHardRuleParts,
} from "@/lib/hard-rule-match";

type EntryDef = {
  name: string;
  description: string;
  isRequired?: boolean;
  isOptionalModule?: boolean;
};

type TemplateRow = {
  id: string;
  name: string;
  device_type: string;
  entries: unknown[] | null;
  product_lines: Array<{ id?: string; name?: string; entries?: unknown[] }> | null;
  is_global: boolean;
  site_id: string | null;
  version: number | null;
};

const DEVICE_TEMPLATES: Array<{
  name: string;
  deviceType: "string_inverter" | "central_inverter" | "energy_storage";
  entries: EntryDef[];
}> = [
  {
    name: "组串式逆变器",
    deviceType: "string_inverter",
    entries: [
      {
        name: "上传阳光云截图",
        description:
          "必检硬性项。须上传与合格样本同级的完整阳光云页面截图（含设备信息与序列号，不可半截/只截功率数字）；半截图不合格。",
      },
      {
        name: "上传故障记录",
        description:
          "必检硬性项。须同时上传两类截图供 AI 分析：①实时故障/告警页；②历史故障/告警页。只传一张或只传同一类，判定不合格。",
      },
      {
        name: "安装固定检查",
        description:
          "必检硬性项。至少拍摄 2 个不同角度，须能看清支架/螺栓等固定点，证明安装牢固、无松动倾斜；单张侧面不合格。",
      },
      {
        name: "直流侧安装检查",
        description:
          "必检硬性项。已插线端子正常即可；未插线空闲孔须盖蓝色/红色/橙色防护盖，无盖呈黑洞裸露不合格。",
      },
      {
        name: "交流侧安装检查",
        description:
          "必检硬性项。检查交流侧接线与防护；相线之外必须看到 PE 接地线已接入，未接 PE 直接不合格。",
      },
      {
        name: "接地安装检查",
        description:
          "必检硬性项。现场照片须同时清晰看到：①黄绿双色接地线；②接地排或接地端子（含 PE 螺栓/铜编织带接地点）；③接地标识（含面板丝印 PE/GND/接地字样）。三样缺一样即不合格；高压警示牌与相线色环不算。",
      },
    ],
  },
  {
    name: "集中式逆变器",
    deviceType: "central_inverter",
    entries: [
      {
        name: "上传阳光云截图",
        description:
          "必检硬性项。须上传与合格样本同级的完整阳光云页面截图（含设备信息与序列号，不可半截/只截功率数字）；半截图不合格。",
      },
      {
        name: "上传故障记录",
        description:
          "必检硬性项。须同时上传两类截图供 AI 分析：①实时故障/告警页；②历史故障/告警页。只传一张或只传同一类，判定不合格。",
      },
      {
        name: "设备箱体检查",
        description: "必检。检查箱体外观、门锁、密封、防腐与内部整洁状况。",
      },
      {
        name: "逆变器检查",
        description: "必检。检查逆变器本体运行状态、指示灯、接线与散热情况。",
      },
      {
        name: "低压配电柜检查",
        description: "必检。检查低压配电柜内元器件、接线与标识是否正常。",
      },
      {
        name: "环网柜检查",
        description: "必检。检查环网柜外观、柜门、指示与安全防护状态。",
      },
      {
        name: "中压变压器检查",
        description: "可选项（视情况）。现场有中压变压器时检查外观、油位/温升、异响与渗漏等。",
        isRequired: false,
        isOptionalModule: true,
      },
    ],
  },
  {
    name: "储能系统",
    deviceType: "energy_storage",
    entries: [
      {
        name: "箱体检查",
        description: "必检。检查储能系统箱体外观、门锁、密封与标识。",
      },
      {
        name: "电池箱检查",
        description: "必检。检查电池箱外观、连接、温控/消防相关部件状态。",
      },
      {
        name: "PCS 检查",
        description: "必检。检查 PCS 运行状态、指示、接线与散热情况。",
      },
      {
        name: "环网柜检查",
        description: "必检。检查环网柜外观、柜门、指示与安全防护状态。",
      },
      {
        name: "中压变压器检查",
        description: "可选项（视情况）。现场有中压变压器时检查外观、油位/温升、异响与渗漏等。",
        isRequired: false,
        isOptionalModule: true,
      },
      {
        name: "其它系统检查",
        description: "必检。检查其它附属系统（通信、消防、空调等）是否异常。",
      },
    ],
  },
];

const DEMAND_TYPES = ["巡检", "故障恢复", "整改", "维护", "交付"] as const;

const JOB_RECORD: EntryDef = {
  name: "现场作业记录",
  description: "请按该服务类型现场规范完成作业并上传凭证；可在「服务类型」中完善检查条目与样本图。",
};

const TEMPLATE_FIELDS = `
  id name device_type entries product_lines is_global site_id assign_mode unit_label expense_enabled_default version created_at
`;

function buildEntries(defs: EntryDef[]) {
  return defs.map((item, order) => ({
    id: randomUUID(),
    name: item.name,
    description: item.description,
    isRequired: item.isRequired !== false,
    order,
    samplePhotos: [] as string[],
    checkType: "photo",
    aiEnabled: true,
    isOptionalModule: item.isOptionalModule || false,
  }));
}

function cloneEntries(entries: unknown[] | null | undefined) {
  return (Array.isArray(entries) ? entries : []).map((raw, order) => {
    const e = (raw || {}) as Record<string, unknown>;
    return {
      ...e,
      id: randomUUID(),
      name: e.name,
      description: e.description || "",
      isRequired: e.isRequired !== false,
      order: typeof e.order === "number" ? e.order : order,
      samplePhotos: Array.isArray(e.samplePhotos) ? e.samplePhotos : [],
      checkType: e.checkType === "text" ? "text" : "photo",
      aiEnabled: e.aiEnabled !== false,
    };
  });
}

function entryNames(entries: unknown[] | null | undefined) {
  return (Array.isArray(entries) ? entries : [])
    .map((raw) => String((raw as { name?: string })?.name || "").trim())
    .join("|");
}

async function loadTemplates(): Promise<TemplateRow[]> {
  const d = await adminGql<{ inspection_templates: TemplateRow[] }>(
    `query { inspection_templates(limit: 1000) { ${TEMPLATE_FIELDS} } }`,
  );
  return d.inspection_templates || [];
}

async function insertTemplate(obj: Record<string, unknown>) {
  await adminGql(
    `mutation ($obj: inspection_templates_insert_input!) {
      insert_inspection_templates_one(object: $obj) { id }
    }`,
    { obj },
  );
}

async function updateTemplate(id: string, set: Record<string, unknown>) {
  await adminGql(
    `mutation ($id: uuid!, $set: inspection_templates_set_input!) {
      update_inspection_templates_by_pk(pk_columns: { id: $id }, _set: $set) { id }
    }`,
    { id, set },
  );
}

function isGlobal(t: TemplateRow) {
  return t.is_global && !t.site_id;
}

async function seedHardRules() {
  const d = await adminGql<{
    ai_hard_rules: Array<{
      code: string;
      name: string;
      prompt_text: string | null;
      json_schema_hint: string | null;
      version: number | null;
    }>;
  }>(`query { ai_hard_rules { code name prompt_text json_schema_hint version } }`);
  const byCode = new Map((d.ai_hard_rules || []).map((r) => [r.code, r]));
  let inserted = 0;
  let updated = 0;
  for (const def of HARD_RULE_DEFAULTS) {
    const exists = byCode.get(def.code);
    const obj = {
      name: def.name,
      match_mode: def.matchMode,
      match_pattern: def.matchPattern,
      prompt_text: def.promptText,
      json_schema_hint: def.jsonSchemaHint,
      enabled: true,
      enforce_mode: def.enforceMode,
      change_note: "系统种子：迁入内置硬规则",
    };
    if (!exists) {
      await adminGql(
        `mutation ($obj: ai_hard_rules_insert_input!) {
          insert_ai_hard_rules_one(object: $obj) { code }
        }`,
        { obj: { ...obj, code: def.code, version: 1 } },
      );
      inserted += 1;
      continue;
    }
    const prompt = String(exists.prompt_text || "");
    const stillShortSeed = !prompt.includes("【") || !exists.json_schema_hint;
    if (!stillShortSeed) continue;
    await adminGql(
      `mutation ($c: String!, $set: ai_hard_rules_set_input!) {
        update_ai_hard_rules(where: { code: { _eq: $c } }, _set: $set) { affected_rows }
      }`,
      {
        c: def.code,
        set: { ...obj, version: Number(exists.version || 1) + 1 },
      },
    );
    updated += 1;
  }
  return { inserted, updated };
}

function stringInverterEntryDefs(): EntryDef[] {
  const tpl = DEVICE_TEMPLATES.find((item) => item.deviceType === "string_inverter");
  return tpl?.entries || [];
}

type CatalogEntryHit = {
  templateId: string;
  templateName: string;
  productLineName: string;
  entryId: string;
  entryName: string;
};

function flattenTemplateEntries(templates: TemplateRow[]): CatalogEntryHit[] {
  const items: CatalogEntryHit[] = [];
  for (const tpl of templates) {
    const lines = Array.isArray(tpl.product_lines) ? tpl.product_lines : [];
    if (lines.length) {
      for (const line of lines) {
        const lineName = String(line.name || "").trim();
        for (const raw of Array.isArray(line.entries) ? line.entries : []) {
          const row = (raw || {}) as { id?: string; name?: string };
          const entryName = String(row.name || "").trim();
          if (!entryName) continue;
          items.push({
            templateId: tpl.id,
            templateName: tpl.name,
            productLineName: lineName,
            entryId: String(row.id || ""),
            entryName,
          });
        }
      }
    } else {
      for (const raw of Array.isArray(tpl.entries) ? tpl.entries : []) {
        const row = (raw || {}) as { id?: string; name?: string };
        const entryName = String(row.name || "").trim();
        if (!entryName) continue;
        items.push({
          templateId: tpl.id,
          templateName: tpl.name,
          productLineName: "",
          entryId: String(row.id || ""),
          entryName,
        });
      }
    }
  }
  return items;
}

/** 组串式产线补回直流侧/安装固定检查项，并把未绑定的内置规则绑到同名检查项。 */
export async function healBuiltinHardRuleBindings(): Promise<{ entries: number; bindings: number }> {
  const templates = await loadTemplates();
  const needed = stringInverterEntryDefs().filter((item) =>
    ["直流侧安装检查", "安装固定检查"].includes(item.name),
  );
  let entriesAdded = 0;
  for (const tpl of templates) {
    const lines = Array.isArray(tpl.product_lines) ? [...tpl.product_lines] : [];
    let changed = false;
    const nextLines = lines.map((line) => {
      const lineName = String(line.name || "");
      if (!lineName.includes("组串")) return line;
      const list = Array.isArray(line.entries) ? [...line.entries] : [];
      const names = new Set(
        list.map((raw) => String((raw as { name?: string })?.name || "").trim()).filter(Boolean),
      );
      for (const def of needed) {
        if (names.has(def.name)) continue;
        list.push({
          id: randomUUID(),
          name: def.name,
          description: def.description,
          isRequired: true,
          order: list.length,
          samplePhotos: [],
          checkType: "photo",
          aiEnabled: true,
        });
        names.add(def.name);
        changed = true;
        entriesAdded += 1;
      }
      return { ...line, entries: list };
    });
    if (changed) {
      await updateTemplate(tpl.id, {
        product_lines: nextLines,
        version: Number(tpl.version || 1) + 1,
      });
    }
  }

  const catalog = flattenTemplateEntries(await loadTemplates());
  const rules = await adminGql<{
    ai_hard_rules: Array<{
      code: string;
      name: string;
      match_mode: string | null;
      match_pattern: string | null;
      json_schema_hint: string | null;
      version: number | null;
    }>;
  }>(`query { ai_hard_rules { code name match_mode match_pattern json_schema_hint version } }`);

  let bindings = 0;
  for (const row of rules.ai_hard_rules || []) {
    const existing = parseHardRuleBindings(row);
    const live = existing.filter((b) => catalog.some((item) => item.entryId && item.entryId === b.entryId));
    if (live.length) continue;
    const def = HARD_RULE_DEFAULTS.find((item) => item.code === row.code);
    const parts = splitHardRuleParts(def?.matchPattern || row.match_pattern || row.name);
    const byName =
      catalog.find((item) => item.entryName === row.name) ||
      catalog.find((item) => item.entryName === def?.name) ||
      catalog.find((item) => parts.some((p) => item.entryName.includes(p)));
    if (!byName) continue;
    const samples = parseHardRuleSamples({ jsonSchemaHint: row.json_schema_hint });
    const hint = serializeHardRuleHint({
      bindings: [
        {
          templateId: byName.templateId,
          entryId: byName.entryId,
          templateName: byName.templateName,
          entryName: byName.entryName,
          productLineName: byName.productLineName,
        },
      ],
      samples,
    });
    await adminGql(
      `mutation ($c: String!, $set: ai_hard_rules_set_input!) {
        update_ai_hard_rules(where: { code: { _eq: $c } }, _set: $set) { affected_rows }
      }`,
      {
        c: row.code,
        set: {
          match_mode: "title_exact",
          match_pattern: byName.entryName,
          json_schema_hint: hint,
          version: Number(row.version || 1) + 1,
          change_note: "系统：内置规则绑定同名检查项",
        },
      },
    );
    bindings += 1;
  }
  return { entries: entriesAdded, bindings };
}

/** 强制写入全部内置硬规则（清空后恢复用） */
async function forceSeedHardRules() {
  await adminGql(`mutation { delete_ai_hard_rules(where: {}) { affected_rows } }`);
  let inserted = 0;
  for (const def of HARD_RULE_DEFAULTS) {
    await adminGql(
      `mutation ($obj: ai_hard_rules_insert_input!) {
        insert_ai_hard_rules_one(object: $obj) { code }
      }`,
      {
        obj: {
          code: def.code,
          name: def.name,
          match_mode: def.matchMode,
          match_pattern: def.matchPattern,
          prompt_text: def.promptText,
          json_schema_hint: def.jsonSchemaHint,
          enabled: true,
          enforce_mode: def.enforceMode,
          version: 1,
          change_note: "系统恢复：内置硬规则",
        },
      },
    );
    inserted += 1;
  }
  return { inserted, updated: 0 };
}

function buildProductLinesFromDevices() {
  return DEVICE_TEMPLATES.map((item) => ({
    id: randomUUID(),
    name: item.name,
    entries: buildEntries(item.entries),
  }));
}

async function seedInspectionDemandType() {
  const productLines = buildProductLinesFromDevices();
  await insertTemplate({
    name: "巡检",
    device_type: "string_inverter",
    is_global: true,
    site_id: null,
    assign_mode: "single",
    unit_label: "台",
    expense_enabled_default: true,
    version: 1,
    entries: [],
    product_lines: productLines,
  });
}

/** 恢复内置服务类型 + AI 硬规则（不含测试脏数据 / 排版预览） */
export async function restoreBuiltinCatalog(): Promise<CatalogSeedResult> {
  await adminGql(`mutation { delete_inspection_templates(where: { is_global: { _eq: true } }) { affected_rows } }`);
  const hardRules = await forceSeedHardRules();
  await seedInspectionDemandType();
  let demandTypes = 1;
  for (const name of DEMAND_TYPES) {
    if (name === "巡检") continue;
    if (await seedDemandType(name)) demandTypes += 1;
  }
  await writePersistedSeedRev({
    restoredAt: new Date().toISOString(),
    hardRules,
    demandTypes,
    source: "restore-builtin-catalog",
  });
  completedRev = CATALOG_SEED_REV;
  return {
    hardRules,
    devices: { created: 0, synced: 0 },
    demandTypes,
    caseTypes: 0,
    productLines: DEVICE_TEMPLATES.length,
    rematched: 0,
  };
}

async function seedDemandType(name: string) {
  const all = await loadTemplates();
  if (all.some((t) => t.name === name)) return false;
  await insertTemplate({
    name,
    device_type: "string_inverter",
    is_global: true,
    site_id: null,
    assign_mode: "single",
    unit_label: "台",
    expense_enabled_default: false,
    version: 1,
    entries: buildEntries([JOB_RECORD]),
    product_lines: [],
  });
  return true;
}

async function seedDemandTypesFromCases() {
  const d = await adminGql<{ service_cases: Array<{ service_type: string | null }> }>(
    `query { service_cases(limit: 5000) { service_type } }`,
  );
  const names = new Set(
    (d.service_cases || [])
      .map((c) => String(c.service_type || "").trim())
      .filter(Boolean),
  );
  let created = 0;
  for (const name of names) {
    if (await seedDemandType(name)) created += 1;
  }
  return created;
}

async function attachProductLinesFromCases() {
  const [templates, cases] = await Promise.all([
    loadTemplates(),
    adminGql<{
      service_cases: Array<{
        id: string;
        gsp_case_no: string;
        service_type: string | null;
        product_line: string | null;
        task_template_id: string | null;
      }>;
    }>(`query { service_cases(limit: 5000) { id gsp_case_no service_type product_line task_template_id } }`),
  ]);
  const byId = new Map(templates.map((t) => [t.id, t]));
  const missing = new Map<string, Set<string>>();
  for (const item of cases.service_cases || []) {
    const pl = String(item.product_line || "").trim();
    if (!pl) continue;
    const demand = String(item.service_type || "").trim();
    const tpl =
      (item.task_template_id ? byId.get(item.task_template_id) : undefined) ||
      (demand ? templates.find((t) => t.name === demand) : undefined) ||
      null;
    if (!tpl) continue;
    const lines = Array.isArray(tpl.product_lines) ? tpl.product_lines : [];
    if (lines.some((p) => String(p.name || "").trim() === pl)) continue;
    const set = missing.get(tpl.id) || new Set<string>();
    set.add(pl);
    missing.set(tpl.id, set);
  }
  let updated = 0;
  for (const [id, names] of missing) {
    const tpl = byId.get(id);
    if (!tpl) continue;
    const lines = Array.isArray(tpl.product_lines) ? [...tpl.product_lines] : [];
    const fallback =
      (lines.find((p) => Array.isArray(p.entries) && p.entries.length)?.entries as unknown[] | undefined) ||
      tpl.entries ||
      [];
    for (const name of names) {
      lines.push({
        id: randomUUID(),
        name,
        entries: cloneEntries(fallback),
      });
    }
    await updateTemplate(id, {
      product_lines: lines,
      version: Number(tpl.version || 1) + 1,
    });
    updated += 1;
  }
  return updated;
}

export type CatalogSeedResult = {
  hardRules: { inserted: number; updated: number };
  devices: { created: number; synced: number };
  demandTypes: number;
  caseTypes: number;
  productLines: number;
  rematched: number;
};

async function seedOriginalCatalog(): Promise<CatalogSeedResult> {
  const hardRules = await seedHardRules();
  let demandTypes = 0;
  for (const name of DEMAND_TYPES) {
    if (await seedDemandType(name)) demandTypes += 1;
  }
  const caseTypes = await seedDemandTypesFromCases();
  const rematch1 = await rematchUnboundCases();
  const productLines = await attachProductLinesFromCases();
  const rematch2 = await rematchUnboundCases();
  return {
    hardRules,
    devices: { created: 0, synced: 0 },
    demandTypes,
    caseTypes,
    productLines,
    rematched: rematch1.matched + rematch2.matched,
  };
}

const CATALOG_SEED_REV = 4;
const SEED_SETTING_KEY = "catalog_seed";

let inflight: Promise<CatalogSeedResult | null> | null = null;
let completedRev = 0;

async function readPersistedSeedRev() {
  const d = await adminGql<{ app_settings_by_pk: { value: { rev?: number } } | null }>(
    `query { app_settings_by_pk(key: "${SEED_SETTING_KEY}") { value } }`,
  );
  return Number(d.app_settings_by_pk?.value?.rev || 0);
}

async function writePersistedSeedRev(extra: Record<string, unknown>) {
  await adminGql(
    `mutation ($obj: app_settings_insert_input!) {
      insert_app_settings_one(
        object: $obj
        on_conflict: { constraint: app_settings_pkey, update_columns: [value, updated_at] }
      ) { key }
    }`,
    {
      obj: {
        key: SEED_SETTING_KEY,
        value: { rev: CATALOG_SEED_REV, ...extra },
        updated_at: new Date().toISOString(),
      },
    },
  );
}

/** 设备型号不当服务类型用；用户删过仍会被旧种子写回，这里清掉未被案例引用的那三条 */
async function removeUnusedDeviceNamedTemplates() {
  const names = DEVICE_TEMPLATES.map((item) => item.name);
  const all = await loadTemplates();
  let removed = 0;
  for (const name of names) {
    const tpl = all.find((t) => t.name === name && isGlobal(t));
    if (!tpl) continue;
    const used = await adminGql<{ service_cases_aggregate: { aggregate: { count: number } } }>(
      `query ($id: uuid!) {
        service_cases_aggregate(where: { task_template_id: { _eq: $id } }) { aggregate { count } }
      }`,
      { id: tpl.id },
    );
    if (used.service_cases_aggregate.aggregate.count > 0) continue;
    await adminGql(`mutation ($id: uuid!) { delete_inspection_templates_by_pk(id: $id) { id } }`, {
      id: tpl.id,
    });
    removed += 1;
  }
  return removed;
}

/** 首次部署补齐服务类型 / 硬规则；之后不再把用户删掉的条目写回去 */
export async function ensureOriginalCatalog() {
  if (completedRev >= CATALOG_SEED_REV) return;
  if (!process.env.HASURA_GRAPHQL_URL || !process.env.HASURA_GRAPHQL_ADMIN_SECRET) return;
  if (!inflight) {
    inflight = (async () => {
      const persisted = await readPersistedSeedRev();
      if (persisted >= CATALOG_SEED_REV) {
        completedRev = CATALOG_SEED_REV;
        return null;
      }
      const result =
        persisted === 0
          ? await seedOriginalCatalog()
          : persisted < CATALOG_SEED_REV
            ? {
                hardRules: { inserted: 0, updated: 0 },
                devices: { created: 0, synced: 0 },
                demandTypes: 0,
                caseTypes: 0,
                productLines: await attachProductLinesFromCases(),
                rematched: (await rematchUnboundCases()).matched,
              }
            : {
                hardRules: { inserted: 0, updated: 0 },
                devices: { created: 0, synced: 0 },
                demandTypes: 0,
                caseTypes: 0,
                productLines: 0,
                rematched: 0,
              };
      const removedDeviceTypes = await removeUnusedDeviceNamedTemplates();
      await writePersistedSeedRev({ ...result, removedDeviceTypes });
      completedRev = CATALOG_SEED_REV;
      console.info("[catalog-seed]", { ...result, removedDeviceTypes, persisted });
      return result;
    })().catch((err) => {
      inflight = null;
      console.warn("[catalog-seed] failed", err instanceof Error ? err.message : err);
      return null;
    });
  }
  await inflight;
}
