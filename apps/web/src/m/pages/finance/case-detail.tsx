"use client";

import { useEffect, useMemo, useState } from 'react';
import { useNavigate, useParams, useLocation } from 'react-router-dom';
import { Toast, Dialog } from '@/m/lib/react-vant';
import {
  claimFinanceUnit,
  unclaimFinanceUnit,
  fetchMyFinanceCase,
  startFinanceCase,
  type MobileFinanceCase,
} from '../../api/finance';
import { fetchTask } from '../../api/task';
import { useAuthStore } from '../../stores/auth';
import { resolveWorkTypeLabel, workActionLabel } from '../../utils/workTypeLabels';
import { isPreviewCaseId } from '../../utils/mobilePreview';
import { buildPreviewCaseDetail } from '../../utils/mobilePreviewData';
import './finance.css';

const TASK_STATUS_LABEL: Record<string, string> = {
  pending: '未开始',
  in_progress: '进行中',
  submitted: '已提交',
  approved: '已通过',
  rejected: '已驳回·需返工',
};

const CASE_STATUS_LABEL: Record<string, string> = {
  assigned: '待接单',
  working: '作业中',
  finished: '已完工',
  settle_review: '结算审核中',
  settled: '已结算',
  month_locked: '已月结',
};

const UNIT_STATUS_LABEL: Record<string, string> = {
  open: '可认领',
  claimed: '作业中',
  submitted: '已提交',
  completed: '已完成',
  cancelled: '已取消',
};

type UnitFilter = 'open' | 'mine' | 'all';
type UnitItem = NonNullable<MobileFinanceCase['units']>[number];

/** 手机端一屏约 3 行 × 4 列，避免可认领列表过长 */
const GRID_PAGE = 12;

export default function FinanceCaseDetailPage() {
  const { id = '' } = useParams();
  const navigate = useNavigate();
  const location = useLocation();
  const previewMode = isPreviewCaseId(id);
  const userId = useAuthStore((s) => s.user?.id);
  const [item, setItem] = useState<MobileFinanceCase>();
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState('');
  const [busy, setBusy] = useState(false);
  const [busyHint, setBusyHint] = useState('');
  const [unitFilter, setUnitFilter] = useState<UnitFilter>('mine');
  const [unitSearch, setUnitSearch] = useState('');
  const [gridLimit, setGridLimit] = useState(GRID_PAGE);
  const [showCompletedAll, setShowCompletedAll] = useState(false);
  /** 本地聚焦台：可在已认领多台之间切换，不必等当前台完成 */
  const [focusUnitId, setFocusUnitId] = useState<string | null>(null);

  const load = async () => {
    if (!id) return;
    setLoading(true);
    setLoadError('');
    try {
      if (previewMode) {
        const data = buildPreviewCaseDetail(userId, id);
        setItem(data);
        setFocusUnitId(data.activeUnit?.id || null);
        setUnitFilter(
          data.assignMode === 'multi' || Number(data.plannedUnits) > 1 ? 'mine' : 'mine',
        );
        return;
      }
      const data = await fetchMyFinanceCase(id);
      setItem(data);
      setFocusUnitId(data.activeUnit?.id || null);
      const planned = Math.max(1, Number(data.plannedUnits) || 1);
      const unitFlow = data.assignMode === 'multi' || planned > 1;
      if (!unitFlow) return;
      if (!['assigned', 'working'].includes(data.status)) {
        setUnitFilter('mine');
        return;
      }
      const hasMine = (data.units || []).some(
        (u) =>
          !!userId &&
          u.inspectorId === userId &&
          u.status !== 'open' &&
          u.status !== 'cancelled',
      );
      setUnitFilter(hasMine ? 'mine' : 'open');
    } catch {
      setItem(undefined);
      setLoadError('案例加载失败，请检查网络后重试');
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    void load();
  }, [id, userId, location.key, previewMode]);

  useEffect(() => {
    setGridLimit(GRID_PAGE);
    setShowCompletedAll(false);
  }, [unitFilter, id]);

  useEffect(() => {
    if (!item) return;
    // 结案后默认看「我的」，便于回看报告
    if (!['assigned', 'working'].includes(item.status)) {
      setUnitFilter('mine');
    }
  }, [item?.status]);

  const isMulti = item?.assignMode === 'multi';
  const unitLabel = item?.unitLabel || '台';
  const plannedCap = Math.max(1, Number(item?.plannedUnits) || 1);
  // 单人多台与多人一样走分台认领；多人特有的加人/分账仍用 isMulti
  const useUnitFlow = isMulti || plannedCap > 1;
  const units = useMemo(() => {
    const raw = item?.units || [];
    // 计划缩减后，超出计划且仍 open 的不展示；有进展的历史行仍可见
    return raw.filter((u) => u.seq <= plannedCap || u.status !== 'open');
  }, [item?.units, plannedCap]);
  /** 单人一台：详情页展示已识别序列号（半途退出后仍可见） */
  const singleUnitSerial = useMemo(() => {
    if (useUnitFlow || !item) return null;
    const mine =
      (userId &&
        units.find(
          (u) =>
            u.inspectorId === userId &&
            u.status !== 'open' &&
            u.status !== 'cancelled',
        )) ||
      null;
    const preferred =
      mine ||
      units.find((u) => !!u.deviceSerial?.trim()) ||
      units.find((u) => u.seq === 1) ||
      units[0] ||
      null;
    if (!preferred) return null;
    const serial = preferred.deviceSerial?.trim() || '';
    return { seq: preferred.seq, serial, status: preferred.status };
  }, [useUnitFlow, item, units, userId]);
  const openUnits = useMemo(
    () =>
      units
        .filter((u) => u.status === 'open' && u.seq <= plannedCap)
        .sort((a, b) => a.seq - b.seq),
    [units, plannedCap],
  );
  const myInProgress = useMemo(() => {
    return units
      .filter(
        (u) =>
          !!userId &&
          u.inspectorId === userId &&
          (u.status === 'claimed' || u.status === 'submitted'),
      )
      .sort((a, b) => a.seq - b.seq);
  }, [units, userId]);
  const myUnitList = useMemo(() => {
    return units
      .filter(
        (u) =>
          !!userId &&
          u.inspectorId === userId &&
          u.status !== 'open' &&
          u.status !== 'cancelled',
      )
      .sort((a, b) => a.seq - b.seq);
  }, [units, userId]);

  const matchUnitSearch = (u: UnitItem) => {
    const q = unitSearch.trim().toUpperCase();
    if (!q) return true;
    if (String(u.seq).includes(q.replace(/^#/, ''))) return true;
    if (String(u.deviceSerial || '').toUpperCase().includes(q)) return true;
    return false;
  };

  const serialKey = (raw?: string | null) =>
    String(raw || '').trim().replace(/\s+/g, '').toUpperCase();

  const duplicateSerials = useMemo(() => {
    const counts = new Map<string, number>();
    for (const u of units) {
      if (u.status === 'cancelled') continue;
      const sn = serialKey(u.deviceSerial);
      if (sn.length < 4) continue;
      counts.set(sn, (counts.get(sn) || 0) + 1);
    }
    return new Set([...counts.entries()].filter(([, n]) => n > 1).map(([sn]) => sn));
  }, [units]);

  const claimedUnits = useMemo(
    () => units.filter((u) => u.status === 'claimed' || u.status === 'submitted'),
    [units],
  );
  const completedUnits = useMemo(
    () => units.filter((u) => u.status === 'completed').sort((a, b) => a.seq - b.seq),
    [units],
  );
  const filteredMine = useMemo(
    () => myUnitList.filter(matchUnitSearch),
    [myUnitList, unitSearch],
  );
  const filteredOpen = useMemo(
    () => openUnits.filter(matchUnitSearch),
    [openUnits, unitSearch],
  );
  const filteredClaimed = useMemo(
    () => claimedUnits.filter(matchUnitSearch),
    [claimedUnits, unitSearch],
  );
  const filteredCompleted = useMemo(
    () => completedUnits.filter(matchUnitSearch),
    [completedUnits, unitSearch],
  );

  const myActive = useMemo(() => {
    if (!item) return null;
    if (focusUnitId) {
      const focused = myInProgress.find((u) => u.id === focusUnitId);
      if (focused) return focused;
    }
    return (
      item.activeUnit ||
      myInProgress[0] ||
      null
    );
  }, [item, focusUnitId, myInProgress]);

  const myTripClaim = useMemo(() => {
    const list = item?.expenses || [];
    if (!userId) return list[0];
    return (
      list.find((e) => e.inspectorId === userId) ||
      list.find((e) => !e.inspectorId) ||
      undefined
    );
  }, [item?.expenses, userId]);

  if (loading) {
    return (
      <div className="mobile-finance-page case-detail-shell">
        <header className="case-chrome">
          <div className="case-chrome__nav">
            <button type="button" onClick={() => navigate('/m/tasks')}>
              ← 返回
            </button>
          </div>
          <div className="case-chrome__title">
            <h1>作业详情</h1>
            <span>加载中</span>
          </div>
          <p className="case-chrome__meta">
            <span>正在拉取案例…</span>
          </p>
        </header>
        <div className="mobile-list-skeleton" style={{ padding: '12px 16px' }} aria-busy>
          <i />
          <i />
          <i />
          <i />
        </div>
      </div>
    );
  }

  if (loadError || !item) {
    return (
      <div className="mobile-finance-page">
        <header className="mobile-finance-head">
          <button type="button" onClick={() => navigate('/m/tasks')}>
            ← 返回
          </button>
          <h1>作业详情</h1>
        </header>
        <section className="mobile-finance-card">
          <p className="trip-reject" style={{ marginTop: 0 }}>
            {loadError || '案例不存在'}
          </p>
          <button
            type="button"
            className="mobile-finance-primary"
            style={{ width: '100%', marginTop: 12 }}
            onClick={() => void load()}
          >
            重试
          </button>
        </section>
      </div>
    );
  }

  const isTripSkipped = false;

  /** 实际填了开始里程 */
  const hasTripStartFilled = (() => {
    const claim = myTripClaim;
    if (!claim || claim.tripSkipped) return false;
    const lines = Array.isArray(claim.lineItems) ? claim.lineItems : [];
    const trip = lines.find((l) => l.type === 'trip');
    if (trip) {
      return !!(
        trip.startOdometerUrl &&
        (trip.startNavShots || []).length &&
        trip.startMileage != null &&
        trip.startMileage !== ''
      );
    }
    const navOk =
      (claim.startNavUrls && claim.startNavUrls.length > 0) || !!claim.startNavUrl;
    return !!(
      claim.startOdometerUrl &&
      navOk &&
      claim.startMileage != null &&
      claim.startMileage !== ''
    );
  })();

  const hasTripEnd = (() => {
    const claim = myTripClaim;
    if (!claim || claim.tripSkipped) return false;
    const lines = Array.isArray(claim.lineItems) ? claim.lineItems : [];
    const trip = lines.find((l) => l.type === 'trip');
    if (trip) {
      return !!(
        trip.endOdometerUrl &&
        (trip.endNavShots || []).length &&
        trip.endMileage != null &&
        trip.endMileage !== ''
      );
    }
    const navOk =
      (claim.endNavUrls && claim.endNavUrls.length > 0) || !!claim.endNavUrl;
    return !!(
      claim.endOdometerUrl &&
      navOk &&
      claim.endMileage != null &&
      claim.endMileage !== ''
    );
  })();

  const hasExpenseFilled = (() => {
    const claim = myTripClaim;
    if (!claim || claim.tripSkipped) return false;
    const lines = Array.isArray(claim.lineItems) ? claim.lineItems : [];
    if (lines.length) {
      return lines.some(
        (l) =>
          Number(l.amount) > 0 ||
          !!l.startOdometerUrl ||
          !!l.endOdometerUrl ||
          (l.photoUrls || []).length > 0 ||
          (l.voucherUrls || []).length > 0,
      );
    }
    return hasTripStartFilled || hasTripEnd || Number(claim.claimAmount ?? claim.amount) > 0;
  })();

  const tripStatusLabel = (() => {
    if (myTripClaim?.status === 'submitted') return '已提交 · 待审核';
    if (myTripClaim?.status === 'approved') return '报销已通过';
    if (myTripClaim?.status === 'rejected') return '报销已驳回';
    if (hasExpenseFilled) {
      if (hasTripStartFilled && !hasTripEnd) return '行程未填完';
      return '已填写';
    }
    return '未填写';
  })();

  const expenseClaimStatus = myTripClaim?.status || 'draft';
  const expenseLocked =
    expenseClaimStatus === 'submitted' || expenseClaimStatus === 'approved';
  const expenseButtonLabel = (() => {
    if (expenseClaimStatus === 'submitted') return '查看费用明细';
    if (expenseClaimStatus === 'approved') return '查看费用明细';
    if (expenseClaimStatus === 'rejected') return '修改后重新提交';
    if (!hasExpenseFilled) return '填写费用明细';
    if (hasTripStartFilled && !hasTripEnd) return '继续填写费用明细';
    return '修改费用明细';
  })();
  const expenseTip = (() => {
    if (expenseClaimStatus === 'submitted') {
      return '已提交审核，目前只能查看，审核通过或驳回前不可修改。';
    }
    if (expenseClaimStatus === 'approved') {
      return '报销已通过，费用明细仅供查看。';
    }
    if (expenseClaimStatus === 'rejected') {
      return '报销已驳回，可修改明细后重新提交。';
    }
    if (['finished', 'settle_review'].includes(item.status)) {
      return '案例已完工也可补填或修改费用明细；提交审核后不可再改，驳回后可改。';
    }
    return '需要报销再点进去填：可添加多条费用明细（行程、过路费等）。不报销可跳过。';
  })();

  const goInspectUnit = async (unit: UnitItem | null | undefined, autoStart: boolean) => {
    if (previewMode) {
      Toast.info('预览数据仅看排版，不会真实提交');
      return;
    }
    setBusyHint('进入作业…');
    setBusy(true);
    try {
      let current = item;
      if (autoStart && current.status === 'assigned') {
        current = await startFinanceCase(id);
        setItem(current);
      }
      const taskId =
        unit?.inspectionTaskId ||
        current.inspectionTaskId ||
        current.activeUnit?.inspectionTaskId;
      if (!taskId) {
        Toast.fail(
          useUnitFlow
            ? '请先认领一个作业单元'
            : `未找到${workActionLabel(resolveWorkTypeLabel(current), 'task_noun')}，请联系网格长确认服务类型`,
        );
        return;
      }
      if (unit?.id) setFocusUnitId(unit.id);
      navigate(`/m/inspection/${taskId}`);
    } catch {
      /* 拦截器 */
    } finally {
      setBusy(false);
      setBusyHint('');
    }
  };

  const viewUnitReport = async (taskId?: string | null) => {
    if (guardPreview()) return;
    if (!taskId) {
      Toast.fail('该台暂无报告可查看');
      return;
    }
    setBusyHint('打开报告…');
    setBusy(true);
    try {
      const t = await fetchTask(taskId);
      if (!t.record?.id) {
        Toast.fail('报告尚未生成');
        return;
      }
      navigate(`/m/report/${t.record.id}`);
    } catch {
      /* 拦截器 */
    } finally {
      setBusy(false);
      setBusyHint('');
    }
  };

  const enterInspection = async (autoStart: boolean) => {
    if (useUnitFlow) {
      await goInspectUnit(myActive, autoStart);
      return;
    }
    setBusyHint('进入作业…');
    setBusy(true);
    try {
      let current = item;
      if (autoStart && current.status === 'assigned') {
        current = await startFinanceCase(id);
        setItem(current);
      } else if (!current.inspectionTaskId) {
        current = await startFinanceCase(id);
        setItem(current);
      }
      const taskId = current.inspectionTaskId || current.activeUnit?.inspectionTaskId;
      if (!taskId) {
        Toast.fail(
          `未找到${workActionLabel(resolveWorkTypeLabel(current), 'task_noun')}，请联系网格长确认服务类型`,
        );
        return;
      }
      navigate(`/m/inspection/${taskId}`);
    } catch {
      /* 拦截器 */
    } finally {
      setBusy(false);
      setBusyHint('');
    }
  };

  /** 认领：可并行多台；已有作业时默认留在本页，方便继续认领 */
  const claimUnit = async (unitId: string, goAfter: boolean) => {
    const target = units.find((u) => u.id === unitId);
    try {
      if (myInProgress.length > 0) {
        await Dialog.confirm({
          title: '确认认领',
          message: target
            ? `将再认领 ${unitLabel} #${target.seq}。点错可在「我的」里取消认领（未开始作业时）。`
            : `确认再认领一台？点错可在「我的」里取消认领。`,
          confirmButtonText: '确认认领',
          cancelButtonText: '取消',
        });
      }
    } catch {
      return;
    }
    setBusyHint(goAfter ? '认领并进入…' : '认领中…');
    setBusy(true);
    try {
      if (item.status === 'assigned') {
        await startFinanceCase(id);
      }
      const res = await claimFinanceUnit(id, unitId);
      setItem(res.case);
      setFocusUnitId(res.case.activeUnit?.id || unitId);
      const seq = res.case.activeUnit?.seq || res.case.units?.find((u) => u.id === unitId)?.seq;
      Toast.success(seq ? `已认领 ${unitLabel} #${seq}` : '认领成功');
      if (goAfter && res.inspectionTaskId) {
        navigate(`/m/inspection/${res.inspectionTaskId}`);
        return;
      }
    } catch {
      /* */
    } finally {
      setBusy(false);
      setBusyHint('');
    }
  };

  const unclaimUnit = async (unitId: string) => {
    const target = units.find((u) => u.id === unitId);
    try {
      await Dialog.confirm({
        title: '取消认领',
        message: target
          ? `确认取消 ${unitLabel} #${target.seq}？将退回可认领池，其他人可认领。`
          : '确认取消认领？将退回可认领池。',
        confirmButtonText: '取消认领',
        cancelButtonText: '再想想',
      });
    } catch {
      return;
    }
    setBusyHint('取消认领…');
    setBusy(true);
    try {
      const next = await unclaimFinanceUnit(id, unitId);
      setItem(next);
      if (focusUnitId === unitId) setFocusUnitId('');
      Toast.success(target ? `已取消 ${unitLabel} #${target.seq}` : '已取消认领');
    } catch {
      /* 拦截器 */
    } finally {
      setBusy(false);
      setBusyHint('');
    }
  };

  const claimNext = async () => {
    const next = openUnits[0];
    if (!next) {
      Toast.fail(`暂无可认领${unitLabel}`);
      return;
    }
    // 已有未完成台时只认领不跳转，便于连续认领
    await claimUnit(next.id, myInProgress.length === 0);
  };

  const canInspect =
    ['assigned', 'working'].includes(item.status) &&
    (useUnitFlow
      ? !!myActive && myActive.status === 'claimed'
      : !item.inspectionDone);
  // 分台：只针对「本人仍卡在已提交」的台（用于引导补结束里程 / 后台自动完结）
  const finishTargetUnit = useUnitFlow
    ? myInProgress.find((u) => u.status === 'submitted') ||
      (myActive?.status === 'submitted' ? myActive : null) ||
      null
    : null;
  const reportReady = useUnitFlow
    ? !!finishTargetUnit
    : item.inspectionDone ||
      item.inspectionTaskStatus === 'submitted' ||
      item.inspectionTaskStatus === 'approved' ||
      myActive?.status === 'submitted';
  // 软提示：本人已开始行程但未结束（不拦完工）
  const needsTripEndReminder =
    ['assigned', 'working'].includes(item.status) &&
    hasTripStartFilled &&
    !isTripSkipped &&
    !hasTripEnd;
  const finished = !['assigned', 'working'].includes(item.status);
  const workType = resolveWorkTypeLabel(item);
  const multiWorking = useUnitFlow && ['assigned', 'working'].includes(item.status);

  const primaryLabel = useUnitFlow && myActive
    ? `进入当前${unitLabel} #${myActive.seq}`
    : item.status === 'assigned'
      ? workActionLabel(workType, 'accept_start')
      : item.inspectionTaskStatus === 'rejected'
        ? workActionLabel(workType, 'rework')
        : item.inspectionTaskStatus === 'in_progress' || item.status === 'working'
          ? workActionLabel(workType, 'continue')
          : workActionLabel(workType, 'start');

  const progressPct = Math.min(
    100,
    Math.round(
      ((completedUnits.length || item.completedUnits || 0) /
        Math.max(1, item.plannedUnits || 1)) *
        100,
    ),
  );

  const renderUnitChip = (u: UnitItem, clickable: boolean) => (
    <button
      key={u.id}
      type="button"
      className={`unit-chip ${u.status === 'open' ? 'is-open' : ''} ${
        u.id === myActive?.id ? 'is-mine' : ''
      }`}
      disabled={busy || !clickable}
      onClick={() => clickable && void claimUnit(u.id, myInProgress.length === 0)}
    >
      #{u.seq}
    </button>
  );

  const showExpenseDock = ['assigned', 'working', 'finished', 'settle_review', 'settled'].includes(
    item.status,
  );
  const showPrimaryDock =
    (!useUnitFlow && canInspect) ||
    (useUnitFlow && multiWorking && canInspect && !!myActive) ||
    (useUnitFlow && multiWorking && openUnits.length > 0 && !myActive);
  const showClaimSide =
    useUnitFlow && multiWorking && openUnits.length > 0 && !!myActive;
  const showDock = showPrimaryDock || showClaimSide || showExpenseDock;
  const claimLabel =
    myUnitList.length > 0 || myInProgress.length > 0
      ? `认领 #${openUnits[0]?.seq ?? ''}`
      : `认领 #${openUnits[0]?.seq ?? ''}`;
  const guardPreview = () => {
    if (!previewMode) return false;
    Toast.info('预览数据仅看排版，不会真实提交');
    return true;
  };
  const primaryAction = (() => {
    if (!useUnitFlow && canInspect) {
      return {
        label: primaryLabel,
        onClick: () => {
          if (guardPreview()) return;
          void enterInspection(item.status === 'assigned');
        },
      };
    }
    if (useUnitFlow && multiWorking && canInspect && myActive) {
      return {
        label: primaryLabel,
        onClick: () => {
          if (guardPreview()) return;
          void goInspectUnit(myActive, false);
        },
      };
    }
    if (useUnitFlow && multiWorking && openUnits.length > 0) {
      return {
        label: claimLabel,
        onClick: () => {
          if (guardPreview()) return;
          void claimNext();
        },
      };
    }
    return null;
  })();

  const filterTabs = (
    multiWorking
      ? ([
          ['mine', `我的 ${myUnitList.length}`],
          ['open', `可认领 ${openUnits.length}`],
          ['all', `全部 ${units.length}`],
        ] as const)
      : ([
          ['mine', `我的 ${myUnitList.length}`],
          ['all', `全部 ${units.length}`],
        ] as const)
  );

  return (
    <div
      className={`mobile-finance-page case-detail-shell${showDock ? ' has-dock' : ''}${
        previewMode ? ' is-preview' : ''
      }`}
    >
      <header className="case-chrome">
        <div className="case-chrome__nav">
          <button type="button" onClick={() => navigate('/m/tasks')}>
            ← 返回
          </button>
          {previewMode ? <span className="case-chrome__preview">预览</span> : null}
        </div>
        <div className="case-chrome__title">
          <h1>{item.projectName || item.gspCaseNo}</h1>
          <span>{CASE_STATUS_LABEL[item.status] || item.status}</span>
        </div>
        <p className="case-chrome__meta">
          <span>{item.gspCaseNo}</span>
          <span>
            {item.province || '-'}
            {item.city ? ` · ${item.city}` : ''}
          </span>
          <span>{item.taskTypeName || item.taskType || '未设置'}</span>
        </p>
        {useUnitFlow ? (
          <p className="case-chrome__sub">
            {completedUnits.length || item.completedUnits || 0}/{item.plannedUnits || 1} 完成
            {multiWorking
              ? ` · 可认领 ${openUnits.length} · 进行中 ${myInProgress.length}`
              : ''}
            {myActive ? ` · 当前 #${myActive.seq}` : ''}
          </p>
        ) : (
          <p className="case-chrome__sub">
            {item.inspectionTaskStatus
              ? item.inspectionTaskStatus === 'in_progress'
                ? workActionLabel(workType, 'doing')
                : TASK_STATUS_LABEL[item.inspectionTaskStatus] || item.inspectionTaskStatus
              : '待开始'}
          </p>
        )}
        {item.assignRemark?.trim() ? (
          <p className="case-chrome__remark">
            <b>派单备注</b>
            {item.assignRemark.trim()}
          </p>
        ) : null}
        {canInspect ? (
          <details className="case-chrome__tip">
            <summary>现场说明</summary>
            <p>
              {useUnitFlow
                ? workActionLabel(workType, 'tip_unit')
                : workActionLabel(workType, 'tip_photo')}
            </p>
          </details>
        ) : null}
        {useUnitFlow && multiWorking ? (
          <div className="case-chrome__bar" aria-hidden>
            <i style={{ width: `${progressPct}%` }} />
          </div>
        ) : null}

        {useUnitFlow && (multiWorking || (finished && myUnitList.length > 0)) ? (
          <div className="case-chrome__tools">
            <div className="case-tabs" role="tablist">
              {filterTabs.map(([key, label]) => (
                <button
                  key={key}
                  type="button"
                  role="tab"
                  className={`case-tab${unitFilter === key ? ' is-active' : ''}`}
                  onClick={() => setUnitFilter(key)}
                >
                  {label}
                </button>
              ))}
            </div>
            <div className="case-search">
              <input
                type="search"
                value={unitSearch}
                placeholder={`搜索序列号或${unitLabel}号`}
                onChange={(e) => setUnitSearch(e.target.value)}
              />
              {unitSearch.trim() ? (
                <button type="button" onClick={() => setUnitSearch('')}>
                  清除
                </button>
              ) : null}
            </div>
          </div>
        ) : null}
      </header>

      <div className="case-scroll">
        {!useUnitFlow && singleUnitSerial ? (
          <div className="case-row">
            <div>
              <strong>
                {unitLabel} #{singleUnitSerial.seq}
              </strong>
              <small className={singleUnitSerial.serial ? '' : 'is-empty'}>
                序列号：{singleUnitSerial.serial || '未识别'}
              </small>
            </div>
            {(item.inspectionDone || finished) && item.inspectionTaskId ? (
              <button
                type="button"
                className="case-row-btn"
                disabled={busy}
                onClick={() => void viewUnitReport(item.inspectionTaskId)}
              >
                报告
              </button>
            ) : null}
          </div>
        ) : null}

        {useUnitFlow && (multiWorking || (finished && myUnitList.length > 0)) ? (
          <>
            {multiWorking && !myActive && openUnits.length === 0 ? (
              <p className="case-empty">
                暂无可认领{unitLabel}
                {Number(item.plannedUnits) > 0 && !(item.units || []).length
                  ? '，请刷新或联系网格长'
                  : ''}
              </p>
            ) : null}

            {unitFilter === 'mine' && (
              <ul className="case-list">
                {filteredMine.length === 0 ? (
                  <li className="case-empty">
                    {myUnitList.length === 0 ? `暂无我的${unitLabel}` : '没有匹配'}
                  </li>
                ) : (
                  filteredMine.map((u) => {
                    const canEnter = u.status === 'claimed';
                    const canUnclaim =
                      u.status === 'claimed' &&
                      !u.deviceSerial?.trim() &&
                      !u.serialPhotoUrl?.trim();
                    const canViewReport =
                      !!u.inspectionTaskId &&
                      (u.status === 'submitted' || u.status === 'completed');
                    const isFocus = u.id === myActive?.id;
                    return (
                      <li key={u.id} className={isFocus ? 'is-focus' : ''}>
                        <div className="case-list__main">
                          <strong>
                            #{u.seq}
                            {isFocus ? ' 当前' : ''}
                          </strong>
                          <small
                            className={`${u.deviceSerial ? '' : 'is-empty'}${
                              duplicateSerials.has(serialKey(u.deviceSerial)) ? ' is-dup' : ''
                            }`}
                          >
                            {u.deviceSerial?.trim() || '未识别序列号'}
                            {duplicateSerials.has(serialKey(u.deviceSerial)) ? ' · 重复' : ''}
                          </small>
                        </div>
                        <span className="case-list__status">
                          {UNIT_STATUS_LABEL[u.status] || u.status}
                        </span>
                        <div className="case-list__actions">
                          {canEnter ? (
                            <button
                              type="button"
                              className="case-row-btn is-primary"
                              disabled={busy}
                              onClick={() => void goInspectUnit(u, false)}
                            >
                              进入
                            </button>
                          ) : null}
                          {canUnclaim ? (
                            <button
                              type="button"
                              className="case-row-btn"
                              disabled={busy}
                              onClick={() => void unclaimUnit(u.id)}
                            >
                              取消
                            </button>
                          ) : null}
                          {canViewReport ? (
                            <button
                              type="button"
                              className="case-row-btn"
                              onClick={() => void viewUnitReport(u.inspectionTaskId)}
                            >
                              报告
                            </button>
                          ) : null}
                        </div>
                      </li>
                    );
                  })
                )}
              </ul>
            )}

            {multiWorking && unitFilter === 'open' && (
              <>
                {filteredOpen.length === 0 ? (
                  <p className="case-empty">
                    {openUnits.length === 0 ? `没有可认领的${unitLabel}` : '没有匹配'}
                  </p>
                ) : (
                  <>
                    <div className="case-chip-grid">
                      {filteredOpen.slice(0, gridLimit).map((u) => renderUnitChip(u, true))}
                    </div>
                    {filteredOpen.length > gridLimit ? (
                      <button
                        type="button"
                        className="case-more"
                        onClick={() => setGridLimit((n) => n + GRID_PAGE)}
                      >
                        再显示 {Math.min(GRID_PAGE, filteredOpen.length - gridLimit)} 台
                      </button>
                    ) : null}
                  </>
                )}
              </>
            )}

            {unitFilter === 'all' && (
              <div className="case-all">
                {filteredClaimed.length > 0 ? (
                  <>
                    <div className="case-section-label">作业中 · {filteredClaimed.length}</div>
                    <ul className="case-list">
                      {filteredClaimed.map((u) => {
                        const mine = !!userId && u.inspectorId === userId;
                        const canEnter = mine && u.status === 'claimed';
                        const canUnclaim =
                          mine &&
                          u.status === 'claimed' &&
                          !u.deviceSerial?.trim() &&
                          !u.serialPhotoUrl?.trim();
                        const canViewReport =
                          mine &&
                          !!u.inspectionTaskId &&
                          (u.status === 'submitted' || u.status === 'completed');
                        return (
                          <li key={u.id}>
                            <div className="case-list__main">
                              <strong>
                                #{u.seq}
                                {mine ? ' 我的' : ''}
                              </strong>
                              <small
                                className={`${u.deviceSerial ? '' : 'is-empty'}${
                                  duplicateSerials.has(serialKey(u.deviceSerial)) ? ' is-dup' : ''
                                }`}
                              >
                                {u.deviceSerial?.trim() || '未识别序列号'}
                              </small>
                            </div>
                            <span className="case-list__status">
                              {UNIT_STATUS_LABEL[u.status] || u.status}
                            </span>
                            <div className="case-list__actions">
                              {canEnter ? (
                                <button
                                  type="button"
                                  className="case-row-btn is-primary"
                                  disabled={busy}
                                  onClick={() => void goInspectUnit(u, false)}
                                >
                                  进入
                                </button>
                              ) : null}
                              {canUnclaim ? (
                                <button
                                  type="button"
                                  className="case-row-btn"
                                  disabled={busy}
                                  onClick={() => void unclaimUnit(u.id)}
                                >
                                  取消
                                </button>
                              ) : null}
                              {canViewReport ? (
                                <button
                                  type="button"
                                  className="case-row-btn"
                                  onClick={() => void viewUnitReport(u.inspectionTaskId)}
                                >
                                  报告
                                </button>
                              ) : null}
                            </div>
                          </li>
                        );
                      })}
                    </ul>
                  </>
                ) : null}
                {filteredCompleted.length > 0 ? (
                  <>
                    <button
                      type="button"
                      className="case-section-label is-btn"
                      onClick={() => setShowCompletedAll((v) => !v)}
                    >
                      已完成 · {filteredCompleted.length}
                      <span>{showCompletedAll ? '收起' : '展开'}</span>
                    </button>
                    {showCompletedAll ? (
                      <ul className="case-list">
                        {filteredCompleted.map((u) => {
                          const mine = !!userId && u.inspectorId === userId;
                          const canView = !!u.inspectionTaskId && mine;
                          return (
                            <li key={u.id}>
                              <div className="case-list__main">
                                <strong>
                                  #{u.seq}
                                  {mine ? ' 我的' : ''}
                                </strong>
                                <small>{u.deviceSerial?.trim() || '未识别序列号'}</small>
                              </div>
                              <span className="case-list__status">已完成</span>
                              {canView ? (
                                <div className="case-list__actions">
                                  <button
                                    type="button"
                                    className="case-row-btn"
                                    onClick={() => void viewUnitReport(u.inspectionTaskId)}
                                  >
                                    报告
                                  </button>
                                </div>
                              ) : null}
                            </li>
                          );
                        })}
                      </ul>
                    ) : null}
                  </>
                ) : null}
                {openUnits.length > 0 && multiWorking ? (
                  <p className="case-empty">可认领 {openUnits.length} 台，请切到「可认领」或底部认领</p>
                ) : null}
              </div>
            )}
          </>
        ) : null}

        {finished ? (
          <div className="case-empty case-empty--action">
            <p>本单已结束</p>
            <button type="button" className="case-row-btn" onClick={() => navigate('/m/income')}>
              去「我的收入」查看 ›
            </button>
          </div>
        ) : null}
      </div>

      {showDock ? (
        <footer className="case-dock">
          {primaryAction ? (
            <button
              type="button"
              className="case-dock__primary"
              disabled={busy}
              onClick={primaryAction.onClick}
            >
              {busy ? busyHint || '处理中…' : primaryAction.label}
            </button>
          ) : null}
          {(showClaimSide || showExpenseDock) && (
            <div
              className={`case-dock__secondary${
                showClaimSide && showExpenseDock ? ' is-split' : ''
              }`}
            >
              {showClaimSide ? (
                <button
                  type="button"
                  className="case-dock__outline"
                  disabled={busy}
                  onClick={() => {
                    if (guardPreview()) return;
                    void claimNext();
                  }}
                >
                  {claimLabel}
                </button>
              ) : null}
              {showExpenseDock ? (
                <button
                  type="button"
                  className={`case-dock__outline${needsTripEndReminder ? ' is-warn' : ''}`}
                  onClick={() => {
                    if (guardPreview()) return;
                    navigate(`/m/finance-cases/${id}/expense`);
                  }}
                >
                  {expenseButtonLabel}
                  {needsTripEndReminder ? ' · 未填完' : ''}
                </button>
              ) : null}
            </div>
          )}
        </footer>
      ) : null}
    </div>
  );
}
