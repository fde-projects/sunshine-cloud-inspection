"use client";

import { useEffect, useState } from "react";
import { gql } from "@/lib/gql";
import { getStoredUser } from "@/lib/session";

export default function IncomePage() {
  const [rows, setRows] = useState<
    { id: string; month: string; perf_amount: string; service_case?: { gsp_case_no: string; project_name: string } | null }[]
  >([]);
  const [err, setErr] = useState("");
  useEffect(() => {
    const u = getStoredUser();
    gql<{ case_perf_shares: typeof rows }>(
      `query ($uid: uuid!) {
        case_perf_shares(where: { inspector_id: { _eq: $uid } }, order_by: { created_at: desc }) {
          id perf_amount
          service_case { gsp_case_no project_name }
        }
      }`,
      { uid: u?.id },
    )
      .then((d) => setRows(d.case_perf_shares))
      .catch((e) => setErr(e.message));
  }, []);

  const total = rows.reduce((s, r) => s + Number(r.perf_amount || 0), 0);

  return (
    <div>
      <h1 className="text-2xl font-semibold">我的收入</h1>
      <p className="mt-2 text-3xl font-semibold text-[var(--brand)]">¥ {total.toFixed(2)}</p>
      {err ? <p className="mt-3 text-red-600">{err}</p> : null}
      <ul className="mt-4 space-y-2 text-sm">
        {rows.map((r) => (
          <li key={r.id} className="rounded-xl bg-white p-3 ring-1 ring-[var(--line)] flex justify-between">
            <span>{r.service_case?.gsp_case_no} {r.service_case?.project_name}</span>
            <span>¥ {r.perf_amount}</span>
          </li>
        ))}
        {!rows.length ? <li className="text-[var(--muted)]">结算审核通过后将显示绩效。</li> : null}
      </ul>
    </div>
  );
}
