const fs = require("fs");
const path = require("path");
const envPath = path.resolve(__dirname, "../../.env");
const env = fs.readFileSync(envPath, "utf8");
function get(k) {
  const m = env.match(new RegExp(`^${k}=(.*)$`, "m"));
  if (!m) return "";
  return m[1].trim().replace(/^["']|["']$/g, "");
}
const url =
  get("HASURA_GRAPHQL_ENDPOINT") ||
  get("NEXT_PUBLIC_HASURA_GRAPHQL_URL") ||
  get("HASURA_URL");
const secret = get("HASURA_GRAPHQL_ADMIN_SECRET") || get("HASURA_ADMIN_SECRET");
if (!url || !secret) {
  console.error("missing hasura env", { url: !!url, secret: !!secret });
  process.exit(1);
}

(async () => {
  const q = `query {
    all: case_expense_claims(order_by: { created_at: desc }, limit: 20) {
      id status claim_amount amount created_at
      service_case { gsp_case_no project_name }
    }
    submitted: case_expense_claims_aggregate(where: { status: { _eq: "submitted" } }) {
      aggregate { count }
    }
    pending: case_expense_claims_aggregate(where: { status: { _eq: "pending" } }) {
      aggregate { count }
    }
    draft: case_expense_claims_aggregate(where: { status: { _eq: "draft" } }) {
      aggregate { count }
    }
  }`;
  const res = await fetch(url, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-hasura-admin-secret": secret,
    },
    body: JSON.stringify({ query: q }),
  });
  const j = await res.json();
  if (j.errors) {
    console.log(JSON.stringify(j.errors, null, 2));
    process.exit(1);
  }
  console.log(
    "counts",
    JSON.stringify({
      submitted: j.data.submitted.aggregate.count,
      pending: j.data.pending.aggregate.count,
      draft: j.data.draft.aggregate.count,
    }),
  );
  console.log(JSON.stringify(j.data.all, null, 2));
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
