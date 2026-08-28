"use client";

import { useParams } from "next/navigation";
import { Navigate } from "react-router-dom";

export default function TaskRedirect() {
  const params = useParams<{ id: string }>();
  if (!params?.id) return null;
  return <Navigate to={`/m/inspection/${params.id}`} replace />;
}
