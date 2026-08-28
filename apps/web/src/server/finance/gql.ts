import { adminGql } from "@/lib/hasura-admin";

export async function gqlPages<T>(
  table: string,
  whereType: string,
  fields: string,
  where: Record<string, unknown> = {},
  orderBy = "{ id: asc }",
): Promise<T[]> {
  const pageSize = 500;
  const rows: T[] = [];
  let offset = 0;
  for (;;) {
    const d = await adminGql<Record<string, T[]>>(
      `query ($where: ${whereType}!, $limit: Int!, $offset: Int!) {
        ${table}(where: $where, limit: $limit, offset: $offset, order_by: ${orderBy}) { ${fields} }
      }`,
      { where, limit: pageSize, offset },
    );
    const chunk = d[table] || [];
    rows.push(...chunk);
    if (chunk.length < pageSize) break;
    offset += pageSize;
  }
  return rows;
}

export async function chunkIn<T>(
  values: string[],
  load: (slice: string[]) => Promise<T[]>,
  size = 200,
): Promise<T[]> {
  const out: T[] = [];
  for (let i = 0; i < values.length; i += size) {
    const slice = values.slice(i, i + size);
    if (!slice.length) continue;
    out.push(...(await load(slice)));
  }
  return out;
}
