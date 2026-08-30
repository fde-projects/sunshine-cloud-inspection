"use client";

import { Suspense } from "react";
import TemplatesPage from "@/views/templates";

export default function Page() {
  return (
    <Suspense fallback={null}>
      <TemplatesPage />
    </Suspense>
  );
}
