/** 列表排版预览：不足 N 条时补齐假数据（仅看布局，不写库） */
export const LAYOUT_DEMO_COUNT = 25;

export function padLayoutDemo<T>(
  rows: T[],
  count: number,
  factory: (index: number, sample: T | undefined) => T,
): T[] {
  if (rows.length >= count) return rows;
  const out = rows.slice();
  for (let i = rows.length; i < count; i += 1) {
    out.push(factory(i + 1, rows[0]));
  }
  return out;
}
