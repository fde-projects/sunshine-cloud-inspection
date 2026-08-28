# -*- coding: utf-8 -*-
from pathlib import Path

WEB = Path(r"c:\Users\Administrator\Desktop\cursor-jdyp\apps\web\src\app")

PAGES = {
    "(main)/dashboard/page.tsx": "@/views/dashboard",
    "(main)/analysis/page.tsx": "@/views/analysis",
    "(main)/users/page.tsx": "@/views/users",
    "(main)/sites/page.tsx": "@/views/sites",
    "(main)/templates/page.tsx": "@/views/templates",
    "(main)/hard-rules/page.tsx": "@/views/hard-rules",
    "(main)/audit/page.tsx": "@/views/audit",
    "(main)/records/page.tsx": "@/views/records",
    "(main)/settings/page.tsx": "@/views/settings",
    "(main)/finance/dashboard/page.tsx": "@/views/finance/dashboard",
    "(main)/finance/cases/page.tsx": "@/views/finance/cases",
    "(main)/finance/po-orders/page.tsx": "@/views/finance/po-orders",
    "(main)/finance/prices/page.tsx": "@/views/finance/prices",
    "(main)/finance/review/page.tsx": "@/views/finance/review",
    "(main)/finance/assessment/page.tsx": "@/views/finance/assessment",
    "(main)/finance/monthly/page.tsx": "@/views/finance/monthly",
    "m/page.tsx": "@/m/pages/home",
    "m/login/page.tsx": "@/m/pages/login",
    "m/tasks/page.tsx": "@/m/pages/tasks",
    "m/tasks/[id]/page.tsx": "@/m/pages/tasks/detail",
    "m/inspection/[taskId]/page.tsx": "@/m/pages/inspection",
    "m/my/page.tsx": "@/m/pages/my",
    "m/settings/page.tsx": "@/m/pages/settings",
    "m/success/page.tsx": "@/m/pages/success",
    "m/photo/page.tsx": "@/m/pages/photo",
    "m/report/[id]/page.tsx": "@/m/pages/report",
    "m/start/page.tsx": "@/m/pages/start",
    "m/sites/page.tsx": "@/m/pages/sites",
    "m/income/page.tsx": "@/m/pages/finance/income",
    "m/finance-cases/[id]/page.tsx": "@/m/pages/finance/case-detail",
    "m/finance-cases/[id]/expense/page.tsx": "@/m/pages/finance/expense",
}

TPL = '''"use client";

export {{ default }} from "{mod}";
'''

for rel, mod in PAGES.items():
    path = WEB / rel
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(TPL.format(mod=mod), encoding="utf-8")
    print(path)

# jobs alias
jobs = WEB / "(main)/jobs/page.tsx"
jobs.write_text(
    '''"use client";

import { Navigate } from "react-router-dom";

export default function JobsRedirect() {
  return <Navigate to="/m/tasks" replace />;
}
''',
    encoding="utf-8",
)

forbidden = WEB / "(main)/403/page.tsx"
forbidden.parent.mkdir(parents=True, exist_ok=True)
forbidden.write_text(
    '''"use client";

export { default } from "@/views/forbidden";
''',
    encoding="utf-8",
)

print("wrappers ok")
