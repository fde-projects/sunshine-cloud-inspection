"use client";

import { useCallback, useEffect, useMemo, useState } from 'react';
import {
  Alert,
  Button,
  Form,
  Input,
  Modal,
  Popconfirm,
  Select,
  Space,
  Table,
  Tabs,
  Tag,
  Typography,
  message,
} from 'antd';
import {
  PlusOutlined,
  EditOutlined,
  DeleteOutlined,
  UserSwitchOutlined,
  TeamOutlined,
} from '@ant-design/icons';
import type { ColumnsType } from 'antd/es/table';
import {
  fetchSites,
  createSite,
  updateSite,
  deleteSite,
  appointManager,
  appointDeputy,
  removeDeputy,
  fetchSiteMembers,
  addSiteMember,
  removeSiteMember,
  isSiteCodeTaken,
  syncPrimaryManagerInspector,
  type SiteMemberItem,
} from '../../api/site';
import { createUser, fetchStaffingUsers } from '../../api/user';
import type { SiteItem, UserInfo, UserRole } from '../../types';
import SiteFormModal from './SiteFormModal';
import { composeFullAddress } from '../../utils/addressParse';
import { isAntValidateError } from '../../utils/ant-form';
import { chineseErrorMessage } from '../../utils/displayLabels';
import { useAuthStore } from '../../stores/auth';
import FillTable, { listTablePagination } from '../../components/FillTable';

/** 网格管理：电站档案 + 编制（正/副网格长、工程师） */
export default function SitesPage() {
  const currentUser = useAuthStore((state) => state.user);
  const isAdmin = currentUser?.role === 'super_admin';
  const currentUserId = currentUser?.id;
  const [loading, setLoading] = useState(false);
  const [data, setData] = useState<SiteItem[]>([]);
  const [total, setTotal] = useState(0);
  const [page, setPage] = useState(1);
  const [pageSize, setPageSize] = useState(20);
  const [keyword, setKeyword] = useState('');
  const [province, setProvince] = useState('');
  const [city, setCity] = useState('');
  const [status, setStatus] = useState<string | undefined>();

  const [modalOpen, setModalOpen] = useState(false);
  const [editing, setEditing] = useState<SiteItem | null>(null);
  const [form] = Form.useForm();

  const [appointOpen, setAppointOpen] = useState(false);
  const [appointSite, setAppointSite] = useState<SiteItem | null>(null);
  const [managers, setManagers] = useState<UserInfo[]>([]);
  const [managerId, setManagerId] = useState<string>();

  const [staffOpen, setStaffOpen] = useState(false);
  const [staffSite, setStaffSite] = useState<SiteItem | null>(null);
  const [deputies, setDeputies] = useState<SiteMemberItem[]>([]);
  const [inspectors, setInspectors] = useState<SiteMemberItem[]>([]);
  const [staffCandidates, setStaffCandidates] = useState<UserInfo[]>([]);
  const [pickDeputyId, setPickDeputyId] = useState<string>();
  const [pickInspectorId, setPickInspectorId] = useState<string>();
  const [staffLoading, setStaffLoading] = useState(false);

  const [createOpen, setCreateOpen] = useState(false);
  const [createKind, setCreateKind] = useState<'deputy' | 'inspector'>('inspector');
  const [createForm] = Form.useForm();
  const [createSubmitting, setCreateSubmitting] = useState(false);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const res = await fetchSites({
        page,
        limit: pageSize,
        keyword: keyword || undefined,
        province: province || undefined,
        city: city || undefined,
        status,
      });
      setData(res.list);
      setTotal(res.total);
    } catch (error) {
      const shown = chineseErrorMessage(error instanceof Error ? error.message : error);
      if (shown) message.error(shown);
    } finally {
      setLoading(false);
    }
  }, [page, pageSize, keyword, province, city, status]);

  useEffect(() => {
    load();
  }, [load]);

  const openCreate = () => {
    setEditing(null);
    form.resetFields();
    form.setFieldsValue({ status: 'active' });
    setModalOpen(true);
  };

  const openEdit = (record: SiteItem) => {
    setEditing(record);
    form.setFieldsValue({
      ...record,
      fullAddress: composeFullAddress(record),
    });
    setModalOpen(true);
  };

  const submit = async () => {
    try {
      const values = await form.validateFields();
      if (values.latitude == null || values.latitude === '' || values.longitude == null || values.longitude === '') {
        message.warning('请先点「地址解析」或在地图上选点，确定网格位置');
        return;
      }
      const code = String(values.code || '').trim();
      if (await isSiteCodeTaken(code, editing?.id)) {
        message.error('该网格编码已存在，请换一个');
        return;
      }
      const payload = {
        ...values,
        code,
        latitude: Number(values.latitude),
        longitude: Number(values.longitude),
      };
      delete payload.fullAddress;
      delete payload.inspectionRadiusKm;
      delete payload.inspectionRadiusMeters;
      if (editing) {
        await updateSite(editing.id, payload);
        message.success('网格已更新');
      } else {
        await createSite(payload);
        message.success('网格已创建');
      }
      setModalOpen(false);
      load();
    } catch (error) {
      if (isAntValidateError(error)) {
        const first = (error as { errorFields: { errors?: string[] }[] }).errorFields[0]?.errors?.[0];
        if (first) message.warning(first);
        return;
      }
      const shown = chineseErrorMessage(error instanceof Error ? error.message : error);
      if (shown) message.error(shown);
    }
  };

  const onDelete = async (id: string) => {
    await deleteSite(id);
    message.success('网格已删除');
    load();
  };

  const openAppoint = async (record: SiteItem) => {
    setAppointSite(record);
    const res = await fetchStaffingUsers({ status: "active", limit: 200 });
    const candidates = res.list.filter((user) => {
      const roles = user.roles?.length ? user.roles : [user.role];
      return roles.includes("site_manager") && !roles.includes("super_admin");
    });
    setManagers(candidates);
    setManagerId(
      record.managerId && candidates.some((user) => user.id === record.managerId)
        ? record.managerId
        : undefined,
    );
    setAppointOpen(true);
  };

  const submitAppoint = async () => {
    if (!appointSite || !managerId) {
      message.warning('请选择正网格长');
      return;
    }
    await appointManager(appointSite.id, managerId);
    const picked = managers.find((m) => m.id === managerId);
    const roles = picked ? (picked.roles?.length ? picked.roles : [picked.role]) : [];
    const synced = await syncPrimaryManagerInspector(
      appointSite.id,
      managerId,
      roles.includes('inspector'),
    );
    message.success(
      synced === 'created'
        ? '已任命正网格长，并自动写入工程师编制（账号已开通工程师）'
        : '已任命正网格长',
    );
    setAppointOpen(false);
    load();
  };

  const loadStaff = async (site: SiteItem) => {
    setStaffLoading(true);
    try {
      const [dep, insp, allUsers] = await Promise.all([
        fetchSiteMembers(site.id, 'deputy_manager'),
        fetchSiteMembers(site.id, 'inspector'),
        fetchStaffingUsers({ status: 'active', limit: 100 }),
      ]);
      setDeputies(dep);
      setInspectors(insp);
      const candidates = allUsers.list.filter(
        (u) => !(u.roles?.length ? u.roles : [u.role]).includes('super_admin'),
      );
      setStaffCandidates(candidates);

      // 历史数据自愈：正网格长已开工程师但未进编制 → 自动写入
      if (site.managerId) {
        const manager =
          candidates.find((u) => u.id === site.managerId) ||
          (site.managerId === currentUserId ? currentUser : null);
        const managerRoles = manager
          ? ((manager as UserInfo).roles?.length
              ? (manager as UserInfo).roles!
              : [(manager as UserInfo).role])
          : [];
        const hasInspector =
          managerRoles.includes('inspector') ||
          (site.managerId === currentUserId &&
            Boolean(
              currentUser?.roles?.includes('inspector') || currentUser?.role === 'inspector',
            ));
        const already = insp.some((m) => m.userId === site.managerId && m.status !== 'inactive');
        if (hasInspector && !already) {
          const r = await syncPrimaryManagerInspector(site.id, site.managerId, true);
          if (r === 'created') {
            const nextInsp = await fetchSiteMembers(site.id, 'inspector');
            setInspectors(nextInsp);
          }
        }
      }
    } finally {
      setStaffLoading(false);
    }
  };

  const openStaff = async (record: SiteItem) => {
    setStaffSite(record);
    setPickDeputyId(undefined);
    setPickInspectorId(undefined);
    setStaffOpen(true);
    await loadStaff(record);
  };

  const submitCreateJoin = async () => {
    if (!staffSite) return;
    if (createKind === 'deputy' && !canManageDeputies) {
      message.warning('仅正网格长或管理员可设置副网格长');
      return;
    }
    if (createKind === 'inspector' && !canManageInspectors) {
      message.warning('无权聘用工程师');
      return;
    }
    let values: {
      username?: string;
      password?: string;
      realName?: string;
      phone?: string;
      employeeNo?: string;
    };
    try {
      values = await createForm.validateFields();
    } catch (error) {
      if (isAntValidateError(error)) return;
      throw error;
    }
    setCreateSubmitting(true);
    try {
      const roles: UserRole[] =
        createKind === 'deputy' ? ['site_manager'] : ['inspector'];
      const created = await createUser({
        username: values.username,
        password: values.password,
        realName: values.realName,
        employeeNo: values.employeeNo,
        phone: values.phone,
        roles,
        role: roles[0],
      });
      if (createKind === 'deputy') {
        await appointDeputy(staffSite.id, created.id);
        message.success(`已创建副网格长「${created.username}」，可用电脑管理后台登录`);
      } else {
        await addSiteMember(staffSite.id, created.id);
        message.success(
          `已创建工程师「${created.username}」。请打开首页选「手机作业端」或访问 /m/login 登录（不能进电脑管理后台）`,
          6,
        );
      }
      setCreateOpen(false);
      await loadStaff(staffSite);
    } catch (error) {
      const shown = chineseErrorMessage(error instanceof Error ? error.message : error);
      message.error(shown || '创建失败');
    } finally {
      setCreateSubmitting(false);
    }
  };

  const onAddDeputy = async () => {
    if (!canManageDeputies) {
      message.warning('仅正网格长或管理员可设置副网格长');
      return;
    }
    if (!staffSite || !pickDeputyId) {
      message.warning('请选择副网格长');
      return;
    }
    if (inspectors.some((d) => d.userId === pickDeputyId)) {
      message.warning('该账号已是本网格工程师，同一网格不可再设为副网格长');
      return;
    }
    try {
      await appointDeputy(staffSite.id, pickDeputyId);
      message.success('已添加副网格长');
      setPickDeputyId(undefined);
      await loadStaff(staffSite);
    } catch (error) {
      const shown = chineseErrorMessage(error instanceof Error ? error.message : error);
      message.error(shown || '添加失败');
    }
  };

  const onAddInspector = async () => {
    if (!staffSite || !pickInspectorId) {
      message.warning('请选择工程师');
      return;
    }
    if (deputies.some((d) => d.userId === pickInspectorId)) {
      message.warning('该账号已是本网格副网格长，同一网格不可再聘为工程师');
      return;
    }
    if (inspectors.some((d) => d.userId === pickInspectorId)) {
      message.info('该账号已聘为本网格工程师');
      return;
    }
    try {
      await addSiteMember(staffSite.id, pickInspectorId);
      message.success(
        '已聘用。该账号请用「手机作业端」(/m/login) 登录接单，不能登录电脑管理后台',
        5,
      );
      setPickInspectorId(undefined);
      await loadStaff(staffSite);
    } catch (error) {
      const shown = chineseErrorMessage(error instanceof Error ? error.message : error);
      message.error(shown || '聘用失败');
    }
  };

  const hireSelfAsInspector = async () => {
    if (!staffSite || !currentUserId) return;
    try {
      await addSiteMember(staffSite.id, currentUserId);
      message.success('已将本人聘为本网格工程师');
      await loadStaff(staffSite);
    } catch (error) {
      const shown = chineseErrorMessage(error instanceof Error ? error.message : error);
      message.error(shown || '聘用失败');
    }
  };

  const regionHint = [province && `省「${province}」`, city && `市「${city}」`]
    .filter(Boolean)
    .join('、');

  const iAmDeputyOnStaffSite = deputies.some(
    (d) => d.userId === currentUserId && d.status !== 'inactive',
  );

  const iAmPrimaryOnStaffSite = !!staffSite && !!currentUserId && staffSite.managerId === currentUserId;

  /** 可管工程师：管理员 / 正长 / 副长 */
  const canManageInspectors =
    !!staffSite &&
    !!currentUserId &&
    (isAdmin || iAmPrimaryOnStaffSite || iAmDeputyOnStaffSite);

  /** 可设副长：仅管理员或正长（副长不能再设副长） */
  const canManageDeputies = !!staffSite && !!currentUserId && (isAdmin || iAmPrimaryOnStaffSite);

  const canManageStaff = canManageInspectors;

  const openCreateJoin = (kind: 'deputy' | 'inspector') => {
    if (kind === 'deputy' && !canManageDeputies) {
      message.warning('仅正网格长或管理员可设置副网格长');
      return;
    }
    if (kind === 'inspector' && !canManageInspectors) {
      message.warning('无权聘用工程师');
      return;
    }
    setCreateKind(kind);
    setCreateOpen(true);
  };

  const hasRole = (u: UserInfo, role: string) =>
    (u.roles?.length ? u.roles : [u.role]).includes(role as UserInfo['role']);

  const iAmInspectorRole = Boolean(
    currentUser &&
      (currentUser.roles?.includes('inspector') || currentUser.role === 'inspector'),
  );

  const iAmHiredInspector = inspectors.some(
    (m) => m.userId === currentUserId && m.status !== 'inactive',
  );

  const selfCanQuickHire =
    canManageInspectors &&
    iAmInspectorRole &&
    !iAmHiredInspector &&
    !iAmDeputyOnStaffSite &&
    !!currentUserId;

  // 副网格长候选：非本网格正网格长、未在编
  const deputyOptions = staffCandidates
    .filter((u) => u.id !== staffSite?.managerId)
    .filter((u) => !deputies.some((d) => d.userId === u.id))
    .filter((u) => !inspectors.some((d) => d.userId === u.id))
    .map((u) => ({
      value: u.id,
      label: `${u.realName}（${u.username} / ${hasRole(u, 'site_manager') ? '网格长' : '工程师'}）`,
    }));

  const inspectorOptions = useMemo(
    () =>
      staffCandidates
        .filter((u) => hasRole(u, 'inspector'))
        .filter((u) => !inspectors.some((d) => d.userId === u.id))
        .filter((u) => !deputies.some((d) => d.userId === u.id))
        .map((u) => ({
          value: u.id,
          label:
            u.id === staffSite?.managerId
              ? `${u.realName}（${u.username} / 正网格长·兼工程师）`
              : `${u.realName}（${u.username}）`,
        })),
    [staffCandidates, inspectors, deputies, staffSite?.managerId],
  );

  const columns: ColumnsType<SiteItem> = [
    { title: '网格名称', dataIndex: 'name', width: 140 },
    { title: '编码', dataIndex: 'code', width: 100 },
    {
      title: '地区',
      render: (_, r) => `${r.province}${r.city}${r.district}`,
      ellipsis: true,
    },
    { title: '地址', dataIndex: 'address', ellipsis: true },
    {
      title: '正网格长',
      dataIndex: ['manager', 'realName'],
      width: 100,
      render: (v) => v || '-',
    },
    {
      title: '状态',
      dataIndex: 'status',
      width: 90,
      render: (v) => (
        <Tag color={v === 'active' ? 'green' : 'default'}>{v === 'active' ? '启用' : '停用'}</Tag>
      ),
    },
    {
      title: '操作',
      width: 300,
      fixed: 'right',
      render: (_, record) => (
        <Space wrap>
          <Button type="link" icon={<EditOutlined />} onClick={() => openEdit(record)}>
            编辑
          </Button>
          {isAdmin && (
            <Button type="link" icon={<UserSwitchOutlined />} onClick={() => openAppoint(record)}>
              正网格长
            </Button>
          )}
          <Button type="link" icon={<TeamOutlined />} onClick={() => void openStaff(record)}>
            人员
          </Button>
          {isAdmin && (
            <Popconfirm title="确认删除该网格？有设备时将失败" onConfirm={() => onDelete(record.id)}>
              <Button type="link" danger icon={<DeleteOutlined />}>
                删除
              </Button>
            </Popconfirm>
          )}
        </Space>
      ),
    },
  ];

  return (
    <div className="admin-fill-page">
      <Space style={{ marginBottom: 12 }} wrap>
        <Input.Search
          placeholder="搜索名称/编码/地区"
          allowClear
          onSearch={(v) => {
            setPage(1);
            setKeyword(v);
          }}
          style={{ width: 220 }}
        />
        <Input.Search
          placeholder="省份，如：四川"
          allowClear
          value={province}
          onChange={(e) => setProvince(e.target.value)}
          onSearch={(v) => {
            setPage(1);
            setProvince(v.trim());
          }}
          enterButton="按省查"
          style={{ width: 240 }}
        />
        <Input.Search
          placeholder="城市，如：自贡"
          allowClear
          value={city}
          onChange={(e) => setCity(e.target.value)}
          onSearch={(v) => {
            setPage(1);
            setCity(v.trim());
          }}
          enterButton="按市查"
          style={{ width: 240 }}
        />
        <Select
          allowClear
          placeholder="状态"
          style={{ width: 120 }}
          value={status}
          onChange={(v) => {
            setPage(1);
            setStatus(v);
          }}
          options={[
            { value: 'active', label: '启用' },
            { value: 'inactive', label: '停用' },
          ]}
        />
        {isAdmin && (
          <Button type="primary" icon={<PlusOutlined />} onClick={openCreate}>
            新增网格
          </Button>
        )}
      </Space>

      <Typography.Paragraph type="secondary" style={{ marginBottom: 12 }}>
        {regionHint
          ? `当前筛选：${regionHint} → 共 ${total} 个网格`
          : '管理员任命正网格长；正网格长可设副长与工程师，副网格长只能管工程师。人员支持「新建并加入」。一网格一名正网格长，工程师可跨网格。'}
      </Typography.Paragraph>

      <FillTable
        rowKey="id"
        loading={loading}
        columns={columns}
        dataSource={data}
        scroll={{ x: 1100 }}
        pagination={listTablePagination({
          current: page,
          total,
          pageSize,
          itemLabel: '个电站',
          onChange: (p, ps) => {
            setPage(p);
            setPageSize(ps);
          },
        })}
      />

      <SiteFormModal
        open={modalOpen}
        editing={editing}
        form={form}
        onCancel={() => setModalOpen(false)}
        onSubmit={() => void submit()}
      />

      <Modal
        title={`任命正网格长 - ${appointSite?.name || ''}`}
        open={appointOpen}
        onCancel={() => setAppointOpen(false)}
        onOk={() => void submitAppoint()}
      >
        <Typography.Paragraph type="secondary">
          每站仅一名正网格长。请先在「账号管理」创建网格长登录账号（待任命）；任命后才会成为正网格长。若该账号已开通工程师，任命后会自动写入本站工程师编制。
        </Typography.Paragraph>
        <Select
          showSearch
          style={{ width: '100%' }}
          placeholder="选择正网格长"
          value={managerId}
          onChange={setManagerId}
          optionFilterProp="label"
          notFoundContent="没有可任命的正网格长账号"
          options={managers.map((m) => {
            const roles = m.roles?.length ? m.roles : [m.role];
            return {
              value: m.id,
              label: `${m.realName}（${m.username} / ${roles.includes('site_manager') ? '网格长账号' : '工程师'}）`,
            };
          })}
        />
      </Modal>

      <Modal
        title={`网格人员 - ${staffSite?.name || ''}`}
        open={staffOpen}
        onCancel={() => setStaffOpen(false)}
        footer={null}
        width={720}
        destroyOnHidden
      >
        <div
          style={{
            padding: '12px 16px',
            marginBottom: 12,
            background: '#f6ffed',
            border: '1px solid #b7eb8f',
            borderRadius: 8,
          }}
        >
          <Space wrap size={12}>
            <Tag color="green" style={{ margin: 0 }}>正网格长</Tag>
            <Typography.Text strong>
              {staffSite?.manager?.realName || '未任命'}
            </Typography.Text>
            {staffSite?.manager && (
              <Typography.Text type="secondary">
                账号：{staffSite.manager.username}
                {staffSite.manager.phone ? ` · 电话：${staffSite.manager.phone}` : ''}
              </Typography.Text>
            )}
            {staffSite?.manager && inspectors.some((item) => item.userId === staffSite.manager?.id) && (
              <Tag color="blue" style={{ margin: 0 }}>兼任工程师</Tag>
            )}
          </Space>
        </div>
        <Typography.Paragraph type="secondary" style={{ marginBottom: 12 }}>
          {isAdmin
            ? '管理员可代正网格长配置编制。工程师请用「手机作业端」(/m/login)；副网格长用电脑管理后台。同一网格副长与工程师只能任其一。'
            : canManageDeputies
              ? '正网格长可设副长与工程师：可选用已有账号，或「新建并加入」。工程师请用「手机作业端」；副网格长用电脑管理后台。同一网格副长与工程师只能任其一。'
              : canManageInspectors
                ? '副网格长只能管理工程师，不能设置副网格长。工程师请用「手机作业端」(/m/login) 登录。'
                : '当前账号未任职本网格编制管理；请联系正网格长或管理员。'}
        </Typography.Paragraph>
        <Tabs
          items={[
            {
              key: 'deputy',
              label: `副网格长（${deputies.length}）`,
              children: (
                <div>
                  {canManageDeputies && (
                    <Space style={{ marginBottom: 12 }} wrap>
                      <Select
                        showSearch
                        style={{ width: 280 }}
                        placeholder="选择已有账号"
                        value={pickDeputyId}
                        onChange={setPickDeputyId}
                        optionFilterProp="label"
                        options={deputyOptions}
                      />
                      <Button type="primary" onClick={() => void onAddDeputy()}>
                        加入
                      </Button>
                      <Button onClick={() => openCreateJoin('deputy')}>新建并加入</Button>
                    </Space>
                  )}
                  {!canManageDeputies && canManageInspectors && (
                    <Alert
                      type="info"
                      showIcon
                      style={{ marginBottom: 12 }}
                      message="副网格长无权设置其他副网格长，仅正网格长或管理员可操作。"
                    />
                  )}
                  <Table
                    rowKey="id"
                    size="small"
                    loading={staffLoading}
                    pagination={false}
                    dataSource={deputies}
                    columns={[
                      { title: '姓名', dataIndex: ['user', 'realName'] },
                      { title: '用户名', dataIndex: ['user', 'username'] },
                      ...(canManageDeputies
                        ? [
                            {
                              title: '操作',
                              width: 100,
                              render: (_: unknown, r: SiteMemberItem) => (
                                <Popconfirm
                                  title="确认移除该副网格长？"
                                  onConfirm={async () => {
                                    if (!staffSite) return;
                                    try {
                                      await removeDeputy(staffSite.id, r.userId);
                                      message.success('已移除');
                                      await loadStaff(staffSite);
                                    } catch (error) {
                                      const shown = chineseErrorMessage(
                                        error instanceof Error ? error.message : error,
                                      );
                                      message.error(shown || '移除失败');
                                    }
                                  }}
                                >
                                  <Button type="link" danger>
                                    移除
                                  </Button>
                                </Popconfirm>
                              ),
                            },
                          ]
                        : []),
                    ]}
                  />
                </div>
              ),
            },
            {
              key: 'inspector',
              label: `工程师（${inspectors.length}）`,
              children: (
                <div>
                  {canManageInspectors && (
                    <Alert
                      type="info"
                      showIcon
                      style={{ marginBottom: 12 }}
                      message="工程师登录方式"
                      description={
                        <span>
                          用下表「用户名」+ 创建时的密码，打开{' '}
                          <Typography.Link href="/m/login" target="_blank">
                            /m/login
                          </Typography.Link>{' '}
                          （或首页 → 手机作业端）。电脑管理后台无法登录纯工程师账号。
                        </span>
                      }
                    />
                  )}
                  {canManageInspectors && (
                    <Space style={{ marginBottom: 12 }} wrap>
                      <Select
                        showSearch
                        style={{ width: 280 }}
                        placeholder="选择已有工程师账号"
                        value={pickInspectorId}
                        onChange={setPickInspectorId}
                        optionFilterProp="label"
                        options={inspectorOptions}
                        notFoundContent="暂无可选账号，可点「新建并加入」"
                      />
                      <Button type="primary" onClick={() => void onAddInspector()}>
                        聘用
                      </Button>
                      <Button onClick={() => openCreateJoin('inspector')}>新建并加入</Button>
                      {selfCanQuickHire && (
                        <Button onClick={() => void hireSelfAsInspector()}>聘用本人</Button>
                      )}
                    </Space>
                  )}
                  <Table
                    rowKey="id"
                    size="small"
                    loading={staffLoading}
                    pagination={false}
                    dataSource={inspectors}
                    columns={[
                      { title: '姓名', dataIndex: ['user', 'realName'] },
                      { title: '用户名', dataIndex: ['user', 'username'] },
                      ...(canManageInspectors
                        ? [
                            {
                              title: '操作',
                              width: 100,
                              render: (_: unknown, r: SiteMemberItem) => (
                                <Popconfirm
                                  title="确认解聘？不影响其在其他网格的任职"
                                  onConfirm={async () => {
                                    if (!staffSite) return;
                                    await removeSiteMember(staffSite.id, r.userId);
                                    message.success('已解聘');
                                    await loadStaff(staffSite);
                                  }}
                                >
                                  <Button type="link" danger>
                                    解聘
                                  </Button>
                                </Popconfirm>
                              ),
                            },
                          ]
                        : []),
                    ]}
                  />
                </div>
              ),
            },
          ]}
        />
      </Modal>

      <Modal
        title={createKind === 'deputy' ? '新建副网格长并加入' : '新建工程师并加入'}
        open={createOpen}
        onCancel={() => setCreateOpen(false)}
        onOk={() => void submitCreateJoin()}
        confirmLoading={createSubmitting}
        okText="创建并加入本网格"
        afterOpenChange={(visible) => {
          if (visible) createForm.resetFields();
        }}
      >
        <Typography.Paragraph type="secondary" style={{ marginBottom: 12 }}>
          将创建登录账号并立即加入「{staffSite?.name || ''}」。
          {createKind === 'deputy'
            ? '副网格长可登电脑管理后台。'
            : '工程师请用「手机作业端」(/m/login) 登录，不能进电脑管理后台。'}
        </Typography.Paragraph>
        <Form form={createForm} layout="vertical">
          <Form.Item
            name="username"
            label="用户名"
            rules={[{ required: true, message: '请输入用户名' }]}
          >
            <Input />
          </Form.Item>
          <Form.Item
            name="password"
            label="密码"
            rules={[{ required: true, min: 6, message: '至少6位' }]}
          >
            <Input.Password />
          </Form.Item>
          <Form.Item
            name="realName"
            label="真实姓名"
            rules={[{ required: true, message: '请输入姓名' }]}
          >
            <Input />
          </Form.Item>
          <Form.Item
            name="employeeNo"
            label="工号"
            rules={[
              { required: true, message: '请输入工号' },
              { min: 2, max: 32, message: '工号 2-32 位' },
            ]}
          >
            <Input placeholder="不可重复" />
          </Form.Item>
          <Form.Item
            name="phone"
            label="手机号"
            rules={[
              { required: true, message: '请输入手机号' },
              { pattern: /^1\d{10}$/, message: '手机号格式不正确' },
            ]}
          >
            <Input />
          </Form.Item>
        </Form>
      </Modal>
    </div>
  );
}
