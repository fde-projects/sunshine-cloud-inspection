export type PriceLike = {
  id?: string;
  priceType: "settle" | "perf" | string;
  itemCode: string;
  itemName?: string;
  itemDesc?: string | null;
  unit?: string | null;
  productModel: string | null;
  scene: string | null;
  region: string | null;
  coopType: string | null;
  workHours?: string | number | null;
  unitPrice: string | number;
  effectiveDate: string;
  status: string;
};

export type MappingLike = {
  sourceItemName: string;
  targetItemCode: string;
};

export type UploadFile = {
  buffer: Buffer;
  originalname: string;
  size: number;
};

export type ImportDupPlan = {
  createCount: number;
  updateCount: number;
  fileDupCount: number;
  frozenSkipCount: number;
  createSamples: string[];
  updateSamples: string[];
  fileDupSamples: string[];
  frozenSkipSamples: string[];
};

export type FailRow = { row: number; reason: string };

export const PRICE_GQL_FIELDS =
  "id price_type item_code item_name item_desc unit product_model scene region coop_type work_hours unit_price effective_date status change_remark";

export function money(value: number) {
  return (Math.round((value + Number.EPSILON) * 100) / 100).toFixed(2);
}

export function mapPrice(row: Record<string, unknown>): PriceLike {
  return {
    id: String(row.id || ""),
    priceType: String(row.price_type || ""),
    itemCode: String(row.item_code || ""),
    itemName: String(row.item_name || ""),
    itemDesc: (row.item_desc as string | null) ?? null,
    unit: (row.unit as string | null) ?? null,
    productModel: (row.product_model as string | null) ?? null,
    scene: (row.scene as string | null) ?? null,
    region: (row.region as string | null) ?? null,
    coopType: (row.coop_type as string | null) ?? null,
    workHours: (row.work_hours as string | number | null) ?? null,
    unitPrice: (row.unit_price as string | number) ?? 0,
    effectiveDate: String(row.effective_date || ""),
    status: String(row.status || "active"),
  };
}

export function monthKeyShanghai(date: Date | string | null | undefined = new Date()): string {
  const d = date instanceof Date ? date : date ? new Date(date) : new Date();
  const safe = Number.isNaN(d.getTime()) ? new Date() : d;
  return safe.toLocaleString("sv-SE", { timeZone: "Asia/Shanghai" }).slice(0, 7);
}
