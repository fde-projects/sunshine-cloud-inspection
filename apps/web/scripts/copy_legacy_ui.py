# -*- coding: utf-8 -*-
"""Copy old PC/H5 UI into apps/web, preserving UTF-8."""
from __future__ import annotations

import shutil
from pathlib import Path

ROOT = Path(__file__).resolve().parents[3]  # cursor-jdyp
OLD = Path(r"c:\Users\Administrator\Desktop\cursor-fdz")
WEB = ROOT / "apps" / "web" / "src"

PC = OLD / "frontend-pc" / "src"
H5 = OLD / "frontend-h5" / "src"


def ensure_use_client(path: Path) -> None:
    if path.suffix not in {".ts", ".tsx"}:
        return
    text = path.read_text(encoding="utf-8")
    if text.startswith('"use client"') or text.startswith("'use client'"):
        return
    if path.suffix == ".ts" and "from 'react'" not in text and 'from "react"' not in text:
        # keep server-safe utils/api as-is; api files run in browser too
        if "/api/" in str(path).replace("\\", "/") or "/utils/" in str(path).replace("\\", "/"):
            return
    path.write_text('"use client";\n\n' + text, encoding="utf-8")


def copy_tree(src: Path, dst: Path, skip_names: set[str] | None = None) -> None:
    skip_names = skip_names or set()
    if not src.exists():
        raise SystemExit(f"missing {src}")
    dst.parent.mkdir(parents=True, exist_ok=True)
    if src.is_file():
        dst.parent.mkdir(parents=True, exist_ok=True)
        shutil.copy2(src, dst)
        return
    for item in src.rglob("*"):
        if item.is_dir():
            continue
        rel = item.relative_to(src)
        if any(part in skip_names for part in rel.parts):
            continue
        target = dst / rel
        target.parent.mkdir(parents=True, exist_ok=True)
        shutil.copy2(item, target)


def copy_file(src: Path, dst: Path) -> None:
    dst.parent.mkdir(parents=True, exist_ok=True)
    shutil.copy2(src, dst)


def main() -> None:
    # --- PC pages (same depth as original src/pages) ---
    pc_pages = [
        "dashboard",
        "users",
        "sites",
        "templates",
        "hard-rules",
        "audit",
        "records",
        "analysis",
        "settings",
        "finance",
        "forbidden",
        "devices",
    ]
    for name in pc_pages:
        copy_tree(PC / "pages" / name, WEB / "views" / name)

    # drop unused nested layout; Next has finance/layout.tsx
    fl = WEB / "views" / "finance" / "FinanceLayout.tsx"
    if fl.exists():
        fl.unlink()

    # components
    for name in [
        "RecordDetailDrawer.tsx",
        "EntryReviewCard.tsx",
        "EntryReviewCard.css",
        "DayDatePicker.tsx",
        "SiteMapView.tsx",
        "MapPicker.tsx",
        "PlaceholderPage.tsx",
        "ErrorBoundary.tsx",
    ]:
        copy_file(PC / "components" / name, WEB / "components" / name)

    # utils (keep existing imageCompress / request will be rewritten)
    for name in [
        "displayLabels.ts",
        "finance-clear.tsx",
        "photo-url.ts",
        "chinaRegions.ts",
        "addressParse.ts",
        "gaodeTileLayer.ts",
        "compress-image.ts",
    ]:
        copy_file(PC / "utils" / name, WEB / "utils" / name)

    copy_tree(PC / "hooks", WEB / "hooks")
    copy_file(PC / "types" / "finance.ts", WEB / "types" / "finance.ts")
    copy_file(PC / "stores" / "branding.ts", WEB / "stores" / "branding.ts")

    # REST api modules used by copied pages (user/site already GraphQL-compatible)
    for name in [
        "finance.ts",
        "template.ts",
        "record.ts",
        "hard-rule.ts",
        "system.ts",
        "stats.ts",
        "task.ts",
        "device.ts",
        "alert.ts",
        "upload.ts",
        "auth.ts",
        "geocode.ts",
    ]:
        copy_file(PC / "api" / name, WEB / "api" / name)

    # --- H5: mirror frontend-h5/src under src/m ---
    for name in ["pages", "layouts", "components"]:
        copy_tree(H5 / name, WEB / "m" / name)
    for name in [
        "workTypeLabels.ts",
        "useVisiblePolling.ts",
        "datetime.ts",
        "displayLabels.ts",
        "imageCompress.ts",
        "useCachedResource.ts",
        "mobileCacheKeys.ts",
        "assetRecovery.ts",
        "photo-url.ts",
    ]:
        copy_file(H5 / "utils" / name, WEB / "m" / "utils" / name)
    copy_tree(H5 / "api", WEB / "m" / "api")

    # use client on UI files
    for folder in [
        WEB / "views",
        WEB / "components",
        WEB / "hooks",
        WEB / "m" / "pages",
        WEB / "m" / "layouts",
        WEB / "m" / "components",
        WEB / "stores" / "branding.ts",
        WEB / "utils" / "finance-clear.tsx",
    ]:
        if folder.is_file():
            ensure_use_client(folder)
            continue
        for p in folder.rglob("*"):
            if p.suffix in {".tsx", ".ts"} and p.is_file():
                # skip css-only; ensure tsx always client
                if p.suffix == ".tsx":
                    ensure_use_client(p)

    print("copied ok")


if __name__ == "__main__":
    main()
