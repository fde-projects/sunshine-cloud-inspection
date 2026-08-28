"use client";

import { Navigate } from "react-router-dom";

export default function JobsRedirect() {
  return <Navigate to="/m/tasks" replace />;
}
