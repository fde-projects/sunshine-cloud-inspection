import { getStoredUser, getToken } from "./session";

let graphqlUrlCache: string | null = null;

export async function getGraphqlUrl(): Promise<string> {
  if (graphqlUrlCache) return graphqlUrlCache;
  const res = await fetch("/api/config");
  if (!res.ok) throw new Error("无法读取 GraphQL 配置");
  const data = (await res.json()) as { graphqlUrl?: string };
  const url = String(data.graphqlUrl || "").trim();
  if (!url) throw new Error("未配置数据服务地址，请检查环境变量 HASURA_GRAPHQL_URL");
  graphqlUrlCache = url;
  return graphqlUrlCache;
}

export async function gql<T>(
  query: string,
  variables?: Record<string, unknown>,
  token?: string | null,
): Promise<T> {
  const url = await getGraphqlUrl();
  const jwt = token === undefined ? getToken() : token;
  const activeRole = getStoredUser()?.role;
  const res = await fetch(url, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      ...(jwt ? { authorization: `Bearer ${jwt}` } : {}),
      ...(activeRole ? { "x-hasura-role": activeRole } : {}),
    },
    body: JSON.stringify({ query, variables }),
  }).catch(() => {
    throw new Error("网络连接失败，请检查网络后重试");
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
