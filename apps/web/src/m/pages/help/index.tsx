"use client";

import { useNavigate } from "react-router-dom";
import { NavBar } from "@/m/lib/react-vant";
import HelpManualView from "@/views/help/HelpManual";
import { engineerManual } from "@/views/help/engineer-manual";
import "@/views/help/help.css";
import "./help.css";

/** 手机作业端：工程师图文手册 */
export default function MobileHelpPage() {
  const navigate = useNavigate();
  return (
    <div className="m-help-page">
      <HelpManualView
        manual={engineerManual}
        toolbar={<NavBar title="使用帮助" leftText="返回" onClickLeft={() => navigate("/m/my")} />}
      />
    </div>
  );
}
