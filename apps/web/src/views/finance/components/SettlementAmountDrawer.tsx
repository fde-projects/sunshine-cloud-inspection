"use client";

import { Drawer, Empty } from "antd";
import { useDrawerWidth } from "../../../hooks/useDrawerWidth";
import { SettlementAmountBody } from "./SettlementAmountPanel";

type Props = {
  open: boolean;
  caseId?: string;
  caseLabel?: string;
  onClose: () => void;
};

export default function SettlementAmountDrawer({ open, caseId, caseLabel, onClose }: Props) {
  const drawerWidth = useDrawerWidth(800);

  return (
    <Drawer
      open={open}
      onClose={onClose}
      width={drawerWidth}
      title={caseLabel ? `金额构成 · ${caseLabel}` : "金额构成"}
      destroyOnHidden
    >
      {caseId ? (
        <SettlementAmountBody caseId={caseId} onNavigate={onClose} />
      ) : (
        <Empty description="暂无金额明细" />
      )}
    </Drawer>
  );
}
