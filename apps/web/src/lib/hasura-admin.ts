/** Server-only Hasura admin GraphQL（仅登录查用户，不进浏览器）. */
export async function adminGql<T>(
  query: string,
  variables?: Record<string, unknown>,
): Promise<T> {
  const url = process.env.HASURA_GRAPHQL_URL;
  const secret = process.env.HASURA_GRAPHQL_ADMIN_SECRET;
  if (!url || !secret) throw new Error("Hasura 服务端配置缺失");

  const res = await fetch(url, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-hasura-admin-secret": secret,
    },
    body: JSON.stringify({ query, variables }),
  });
  const json = (await res.json()) as {
    data?: T;
    errors?: { message: string }[];
  };
  if (json.errors?.length) {
    throw new Error(json.errors.map((e) => e.message).join("; "));
  }
  if (!json.data) throw new Error("GraphQL 无数据");
  return json.data;
}

export async function userGql<T>(
  token: string,
  query: string,
  variables?: Record<string, unknown>,
): Promise<T> {
  const url = process.env.HASURA_GRAPHQL_URL;
  if (!url) throw new Error("HASURA_GRAPHQL_URL 未配置");
  const res = await fetch(url, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      authorization: `Bearer ${token}`,
    },
    body: JSON.stringify({ query, variables }),
  });
  const json = (await res.json()) as {
    data?: T;
    errors?: { message: string }[];
  };
  if (json.errors?.length) {
    throw new Error(json.errors.map((e) => e.message).join("; "));
  }
  if (!json.data) throw new Error("GraphQL 无数据");
  return json.data;
}
