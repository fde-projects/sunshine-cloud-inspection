import { getToken } from "./session";

let graphqlUrlCache: string | null = null;

export async function getGraphqlUrl(): Promise<string> {
  if (graphqlUrlCache) return graphqlUrlCache;
  const res = await fetch("/api/config");
  if (!res.ok) throw new Error("无法读取 GraphQL 配置");
  const data = (await res.json()) as { graphqlUrl: string };
  graphqlUrlCache = data.graphqlUrl;
  return graphqlUrlCache;
}

export async function gql<T>(
  query: string,
  variables?: Record<string, unknown>,
  token?: string | null,
): Promise<T> {
  const url = await getGraphqlUrl();
  const jwt = token === undefined ? getToken() : token;
  const res = await fetch(url, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      ...(jwt ? { authorization: `Bearer ${jwt}` } : {}),
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
