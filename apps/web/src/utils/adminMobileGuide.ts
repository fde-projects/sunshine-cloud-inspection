/** 管理端窄屏引导：配置与本地记忆（不影响 /m 现场端） */

export type DesktopPreferredRule = {
  /** 路径前缀匹配 */
  prefix: string;
  /** 引导标题 */
  title: string;
  /** 一句话说明 */
  reason: string;
};

/**
 * 复杂配置 / 重编辑页：窄屏进入时加强引导。
 * 列表与审批类页面不在此列，可继续手机轻操作。
 */
export const DESKTOP_PREFERRED_RULES: DesktopPreferredRule[] = [
  {
    prefix: '/templates',
    title: '服务类型配置',
    reason: '含多产品线与检查条目，适合在电脑上编辑，避免漏配或误操作。',
  },
  {
    prefix: '/hard-rules',
    title: '硬规则配置',
    reason: '规则项与样例图较多，建议在电脑浏览器中完成配置与核对。',
  },
  {
    prefix: '/sites',
    title: '网格管理',
    reason: '涉及地图选点与地址解析，电脑上定位更准、操作更稳。',
  },
  {
    prefix: '/finance/prices',
    title: '价格库',
    reason: '价格条目与映射维护信息量大，建议在电脑上维护。',
  },
  {
    prefix: '/finance/po-orders',
    title: 'PO 管理',
    reason: '导入、匹配与条目编辑更适合桌面大屏操作。',
  },
  {
    prefix: '/settings',
    title: '系统设置',
    reason: '品牌与系统参数建议在电脑上调整，便于预览效果。',
  },
  {
    prefix: '/analysis',
    title: '数据分析',
    reason: '图表与对比在大屏上更清晰，手机仅适合快速扫一眼。',
  },
  {
    prefix: '/finance/dashboard',
    title: '经营看板',
    reason: '多维看板适合电脑浏览；手机可查看摘要，精细分析请用桌面。',
  },
];

const BANNER_KEY = 'admin-mobile-guide:banner';
const GATE_KEY = 'admin-mobile-guide:gate';

function todayKey() {
  const d = new Date();
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}

export function matchDesktopPreferred(pathname: string): DesktopPreferredRule | null {
  const path = pathname || '';
  const hit = DESKTOP_PREFERRED_RULES.filter(
    (r) => path === r.prefix || path.startsWith(`${r.prefix}/`),
  ).sort((a, b) => b.prefix.length - a.prefix.length)[0];
  return hit || null;
}

export function isBannerDismissedToday(): boolean {
  if (typeof window === 'undefined') return true;
  try {
    return localStorage.getItem(BANNER_KEY) === todayKey();
  } catch {
    return false;
  }
}

export function dismissBannerToday() {
  try {
    localStorage.setItem(BANNER_KEY, todayKey());
  } catch {
    /* ignore */
  }
}

type GateMap = Record<string, string>;

function readGateMap(): GateMap {
  if (typeof window === 'undefined') return {};
  try {
    const raw = localStorage.getItem(GATE_KEY);
    if (!raw) return {};
    const parsed = JSON.parse(raw) as GateMap;
    return parsed && typeof parsed === 'object' ? parsed : {};
  } catch {
    return {};
  }
}

export function isGateDismissedToday(prefix: string): boolean {
  return readGateMap()[prefix] === todayKey();
}

export function dismissGateToday(prefix: string) {
  try {
    const next = { ...readGateMap(), [prefix]: todayKey() };
    localStorage.setItem(GATE_KEY, JSON.stringify(next));
  } catch {
    /* ignore */
  }
}
