import type { MobileFinanceCase } from '../api/finance';
import { parsePreviewCaseIndex, previewCasePath } from './mobilePreview';

const PROJECTS = [
  '华能德州齐河50MW光伏电站',
  '国电投张家口怀来分布式',
  '大唐鄂尔多斯库布齐二期',
  '三峡新能源青海格尔木',
  '中广核广东阳江海工区',
  '隆基渭南大荔农光互补',
  '协鑫苏州工业园屋顶',
  '正泰杭州余杭工商业',
  '晶科上饶万年渔光互补',
  '天合常州武进分布式',
  '阳光电源肥东地面电站',
  '通威威远渔光一体',
  '爱旭义乌高效组件厂',
  '东方日升宁波象山',
  '固德威苏州储能配套',
  '锦浪科技象山逆变器站',
  '禾迈杭州微型逆变器',
  '上能电气无锡地面站',
  '古瑞瓦特深圳工商业',
  '华为数字能源东莞示范',
  '特变电工新疆昌吉',
  '金风科技甘肃酒泉',
  '明阳智能广东汕尾',
  '运达股份浙江临海',
  '远景能源江苏如东',
  '三一重能湖南株洲',
  '电气风电上海临港',
  '中车株洲风电光伏混合',
  '海装风电内蒙古乌兰',
  '湘电股份湘潭整县推进',
];

const TASK_TYPES = ['年度巡检', '专项排查', '故障消缺', '组件清洗', '逆变器维护', '并网检测'];
const PROVINCES = ['山东', '河北', '内蒙古', '青海', '广东', '浙江', '江苏', '安徽', '江西', '新疆'];
const CITIES = ['德州', '张家口', '鄂尔多斯', '格尔木', '阳江', '渭南', '苏州', '杭州', '上饶', '常州'];
const REMARKS = [
  '优先处理逆变器房，注意高温时段安全',
  '业主要求当日完成并回传照片',
  '山区信号弱，提交后稍等再刷新',
  '门口登记后进入，佩戴安全帽',
  null,
  null,
];

function pad2(n: number) {
  return String(n).padStart(2, '0');
}

function serialFor(caseIndex: number, seq: number) {
  const base = 20240000 + caseIndex * 1000 + seq * 17;
  return `SN${String(base).slice(0, 8)}${pad2(seq % 100)}`;
}

function caseStatus(n: number): string {
  if (n % 7 === 0) return 'finished';
  if (n % 5 === 0) return 'assigned';
  if (n % 3 === 0 || n % 2 === 0) return 'working';
  return 'assigned';
}

function plannedUnitsFor(n: number): number {
  if (n % 5 === 1) return 1;
  if (n % 4 === 0) return 30;
  if (n % 3 === 0) return 12;
  if (n % 5 === 0) return 8;
  return 6;
}

export function buildPreviewFinanceCases(
  count = 30,
  siteId?: string | null,
): MobileFinanceCase[] {
  return Array.from({ length: count }, (_, i) => {
    const n = i + 1;
    const status = caseStatus(n);
    const planned = plannedUnitsFor(n);
    const completed =
      status === 'finished'
        ? planned
        : status === 'working'
          ? Math.min(planned - 1, Math.max(1, Math.floor(planned * (0.2 + (n % 4) * 0.1))))
          : 0;
    return {
      id: `preview-case-${n}`,
      gspCaseNo: `OT2609${pad2(n)}${String(1000 + n).slice(-3)}`,
      projectName: PROJECTS[i % PROJECTS.length],
      province: PROVINCES[i % PROVINCES.length],
      city: CITIES[i % CITIES.length],
      status,
      siteId: siteId || 'preview-site',
      taskType: 'inspection',
      taskTypeName: TASK_TYPES[i % TASK_TYPES.length],
      assignMode: planned > 1 ? 'multi' : 'single',
      plannedUnits: planned,
      completedUnits: completed,
      unitLabel: planned > 1 ? '台' : '项',
      hasPo: true,
      assignRemark: REMARKS[i % REMARKS.length],
    };
  });
}

export type PreviewHomeItem = {
  key: string;
  title: string;
  meta: string;
  status: string;
  statusLabel: string;
  href: string;
};

export function buildPreviewHomeItems(count = 30): PreviewHomeItem[] {
  return buildPreviewFinanceCases(count)
    .filter((c) => ['assigned', 'working'].includes(c.status))
    .map((c) => {
      const n = Number(String(c.id).replace(/\D/g, '')) || 1;
      return {
        key: `preview-home-${n}`,
        title: c.projectName,
        meta: `${c.gspCaseNo} · ${c.taskTypeName || '未设类型'}`,
        status: c.status === 'assigned' ? 'assigned' : 'working',
        statusLabel:
          c.status === 'assigned'
            ? '待接单'
            : Number(c.plannedUnits) > 1
              ? `进行中 ${c.completedUnits}/${c.plannedUnits}`
              : '作业中',
        href: previewCasePath(n),
      };
    });
}

type UnitRow = NonNullable<MobileFinanceCase['units']>[number];

/** 按案例序号生成差异化台清单，避免每条预览都一样 */
function buildUnitsForCase(
  caseIndex: number,
  planned: number,
  status: string,
  mineId: string,
): UnitRow[] {
  const pattern = caseIndex % 5;

  return Array.from({ length: planned }, (_, i) => {
    const seq = i + 1;
    let unitStatus: string;
    let inspectorId: string | null = null;

    if (status === 'assigned' || planned === 1) {
      if (planned === 1 && status === 'working') {
        unitStatus = 'claimed';
        inspectorId = mineId;
      } else if (planned === 1 && status === 'finished') {
        unitStatus = 'completed';
        inspectorId = mineId;
      } else {
        unitStatus = 'open';
      }
    } else if (status === 'finished') {
      unitStatus = 'completed';
      inspectorId = seq % 2 === 0 ? mineId : 'other-inspector';
    } else if (pattern === 0) {
      // 我刚开始：前几台我的，其余可认领
      if (seq <= 2) {
        unitStatus = 'claimed';
        inspectorId = mineId;
      } else if (seq <= Math.ceil(planned * 0.25)) {
        unitStatus = 'completed';
        inspectorId = mineId;
      } else {
        unitStatus = 'open';
      }
    } else if (pattern === 1) {
      // 多人并行
      if (seq <= 3) {
        unitStatus = 'claimed';
        inspectorId = mineId;
      } else if (seq <= 6) {
        unitStatus = 'claimed';
        inspectorId = 'other-inspector';
      } else if (seq <= Math.ceil(planned * 0.4)) {
        unitStatus = 'completed';
        inspectorId = seq % 2 === 0 ? mineId : 'other-inspector';
      } else if (seq <= Math.ceil(planned * 0.55)) {
        unitStatus = 'submitted';
        inspectorId = seq % 3 === 0 ? mineId : 'other-inspector';
      } else {
        unitStatus = 'open';
      }
    } else if (pattern === 2) {
      // 接近收尾
      if (seq > planned - 2) {
        unitStatus = 'claimed';
        inspectorId = mineId;
      } else if (seq > planned - 5) {
        unitStatus = 'open';
      } else {
        unitStatus = 'completed';
        inspectorId = seq % 2 === 0 ? mineId : 'other-inspector';
      }
    } else if (pattern === 3) {
      // 大量可认领
      if (seq === 1) {
        unitStatus = 'claimed';
        inspectorId = mineId;
      } else if (seq <= 3) {
        unitStatus = 'completed';
        inspectorId = 'other-inspector';
      } else {
        unitStatus = 'open';
      }
    } else {
      // 我有已提交待看报告
      if (seq <= 2) {
        unitStatus = 'submitted';
        inspectorId = mineId;
      } else if (seq <= 4) {
        unitStatus = 'claimed';
        inspectorId = mineId;
      } else if (seq <= Math.ceil(planned * 0.35)) {
        unitStatus = 'completed';
        inspectorId = mineId;
      } else if (seq % 4 === 0) {
        unitStatus = 'claimed';
        inspectorId = 'other-inspector';
      } else {
        unitStatus = 'open';
      }
    }

    const serial =
      unitStatus === 'open' && seq % (3 + (caseIndex % 3)) === 0
        ? null
        : serialFor(caseIndex, seq);

    return {
      id: `preview-unit-${caseIndex}-${seq}`,
      seq,
      status: unitStatus,
      inspectorId,
      deviceSerial: serial,
      inspectionTaskId: unitStatus !== 'open' ? `preview-task-${caseIndex}-${seq}` : null,
    };
  });
}

export function buildPreviewCaseDetail(
  userId?: string | null,
  caseIdOrIndex: string | number = 1,
): MobileFinanceCase {
  const mineId = userId || 'preview-user';
  const caseIndex =
    typeof caseIdOrIndex === 'number'
      ? Math.max(1, caseIdOrIndex)
      : parsePreviewCaseIndex(caseIdOrIndex) || 1;
  const i = caseIndex - 1;
  const status = caseStatus(caseIndex);
  const planned = plannedUnitsFor(caseIndex);
  const units = buildUnitsForCase(caseIndex, planned, status, mineId);
  const completed = units.filter((u) => u.status === 'completed').length;
  const myActive = units.find((u) => u.inspectorId === mineId && u.status === 'claimed') || null;
  const project = PROJECTS[i % PROJECTS.length];
  const taskTypeName = TASK_TYPES[i % TASK_TYPES.length];

  return {
    id: `preview-case-${caseIndex}`,
    gspCaseNo: `OT2609${pad2(caseIndex)}${String(1000 + caseIndex).slice(-3)}`,
    projectName: `${project}`,
    province: PROVINCES[i % PROVINCES.length],
    city: CITIES[i % CITIES.length],
    status: status === 'finished' ? 'finished' : status,
    siteId: 'preview-site',
    taskType: 'inspection',
    taskTypeName,
    assignMode: planned > 1 ? 'multi' : 'single',
    plannedUnits: planned,
    completedUnits: completed,
    unitLabel: planned > 1 ? '台' : '项',
    hasPo: true,
    assignRemark:
      REMARKS[i % REMARKS.length] ||
      `预览案例 #${caseIndex}：${planned}${planned > 1 ? '台' : '项'} · ${taskTypeName}`,
    expenses: [],
    units,
    activeUnit: myActive
      ? {
          id: myActive.id,
          seq: myActive.seq,
          status: myActive.status,
          inspectionTaskId: myActive.inspectionTaskId,
        }
      : null,
    inspectionTaskId: planned === 1 ? units[0]?.inspectionTaskId || null : null,
    inspectionDone: status === 'finished',
    inspectionTaskStatus:
      status === 'finished' ? 'approved' : myActive ? 'in_progress' : status === 'working' ? 'in_progress' : null,
  };
}
