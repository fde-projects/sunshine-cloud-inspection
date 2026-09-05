"use client";

import { useAuthStore } from "@/stores/auth";
import { adminManual } from "./admin-manual";
import { managerManual } from "./manager-manual";
import HelpManualView from "./HelpManual";
import "./help.css";

export default function HelpPage() {
  const role = useAuthStore((s) => s.user?.role);

  if (role === "super_admin") {
    return <HelpManualView manual={adminManual} />;
  }
  if (role === "site_manager") {
    return <HelpManualView manual={managerManual} />;
  }

  return (
    <div className="help-placeholder">
      <h2>工程师请到手机作业端查看手册</h2>
      <p>电脑管理后台不提供工程师操作说明，请用手机打开作业端后，在「我的」里进入使用帮助。</p>
    </div>
  );
}
