"use client";

import { useCallback, useEffect, useState } from 'react';
import {
  Button,
  Checkbox,
  Form,
  Input,
  Modal,
  Popconfirm,
  Select,
  Space,
  Table,
  Tag,
  Typography,
  message,
} from 'antd';
import {
  PlusOutlined,
  EditOutlined,
  DeleteOutlined,
  TeamOutlined,
} from '@ant-design/icons';
import type { ColumnsType } from 'antd/es/table';
import {
  fetchSites,
  createSite,
  updateSite,
  deleteSite,
  fetchSiteStaff,
  upsertSiteStaff,
  isSiteCodeTaken,
  type SiteMemberItem,
} from '../../api/site';
import { fetchStaffingUsers } from '../../api/user';
import type { SiteDuty } from '../../lib/site-duties';
import type { SiteItem, UserInfo } from '../../types';
import SiteFormModal from './SiteFormModal';
import { composeFullAddress } from '../../utils/addressParse';
import { isAntValidateError } from '../../utils/ant-form';
import { chineseErrorMessage } from '../../utils/displayLabels';
import { useAuthStore } from '../../stores/auth';
import FillTable, { listTablePagination } from '../../components/FillTable';
import { useDrawerWidth } from '../../hooks/useDrawerWidth';

/** 网格管理：电站档案 + 编制（正/副网格长、工程师） */
export default function SitesPage() {
  const currentUser = useAuthStore((state) => state.user);
  const isAdmin = currentUser?.role === 'super_admin';
  const currentUserId = currentUser?.id;
  const modalWidth = useDrawerWidth(720);
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

  const [staffOpen, setStaffOpen] = useState(false);
  const [staffSite, setStaffSite] = useState<SiteItem | null>(null);
  const [staffMembers, setStaffMembers] = useState<SiteMemberItem[]>([]);
  const [staffCandidates, setStaffCandidates] = useState<UserInfo[]>([]);
  const [pickUserId, setPickUserId] = useState<string>();
  const [staffLoading, setStaffLoading] = useState(false);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const res = await fetchSites({
        page,
        limit: pageSize,
        keyword: keyword || undefined,
        province: province.trim() || undefined,
        city: city.trim() || undefined,
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

  const applyStaffResult = (
    site: { managerId?: string | null; manager?: SiteItem['manager'] },
    members: SiteMemberItem[],
  ) => {
    setStaffMembers(members);
    setStaffSite((prev) =>
      prev
        ? {
            ...prev,
            managerId: site.managerId ?? prev.managerId,
            manager: site.manager ?? prev.manager,
          }
        : prev,
    );
  };

  const loadStaff = async (site: SiteItem) => {
    setStaffLoading(true);
    try {
      const [staff, allUsers] = await Promise.all([
        fetchSiteStaff(site.id),
        fetchStaffingUsers({ status: 'active', limit: 500 }),
      ]);
      applyStaffResult(staff.site, staff.members);
      setStaffCandidates(
        allUsers.list.filter(
          (u) => !(u.roles?.length ? u.roles : [u.role]).includes('super_admin'),
        ),
      );
    } finally {
      setStaffLoading(false);
    }
  };

  const openStaff = async (record: SiteItem) => {
    setStaffSite(record);
    setPickUserId(undefined);
    setStaffOpen(true);
    await loadStaff(record);
  };

  const setMemberDuties = async (userId: string, roles: SiteDuty[]) => {
    if (!staffSite) return;
    const res = await upsertSiteStaff(staffSite.id, userId, roles);
    applyStaffResult(res.site, res.members);
  };

  const onAddMember = async () => {
    if (!staffSite || !pickUserId) {
      message.warning('请选择平台账号');
      return;
    }
    if (staffMembers.some((m) => m.userId === pickUserId)) {
      message.info('该账号已在本网格');
      return;
    }
    try {
      await setMemberDuties(pickUserId, ['inspector']);
      message.success('已加入本网格，可继续勾选任职');
      setPickUserId(undefined);
    } catch (error) {
      const shown = chineseErrorMessage(error instanceof Error ? error.message : error);
      message.error(shown || '加入失败');
    }
  };

  const hireSelfAsInspector = async () => {
    if (!staffSite || !currentUserId) return;
    const mine = staffMembers.find((m) => m.userId === currentUserId);
    const next = [...new Set<SiteDuty>([...(mine?.roles || []), 'inspector'])];
    try {
      await setMemberDuties(currentUserId, next);
      message.success('已将本人设为本网格工程师');
    } catch (error) {
      const shown = chineseErrorMessage(error instanceof Error ? error.message : error);
      message.error(shown || '操作失败');
    }
  };

  const regionHint = [province.trim() && `省「${province.trim()}」`, city.trim() && `市「${city.trim()}」`]
    .filter(Boolean)
    .join('、');

  const iAmPrimaryOnStaffSite =
    !!staffSite &&
    !!currentUserId &&
    (staffSite.managerId === currentUserId ||
      staffMembers.some(
        (m) => m.userId === currentUserId && m.roles.includes('primary_manager'),
      ));

  const iAmDeputyOnStaffSite = staffMembers.some(
    (m) => m.userId === currentUserId && m.roles.includes('deputy_manager'),
  );

  const canManageInspectors =
    !!staffSite &&
    !!currentUserId &&
    (isAdmin || iAmPrimaryOnStaffSite || iAmDeputyOnStaffSite);

  const canManageDeputies = !!staffSite && !!currentUserId && (isAdmin || iAmPrimaryOnStaffSite);

  const canManagePrimary = isAdmin;

  const iAmHiredInspector = staffMembers.some(
    (m) => m.userId === currentUserId && m.roles.includes('inspector'),
  );

  const selfCanQuickHire = canManageInspectors && !iAmHiredInspector && !!currentUserId;

  const poolOptions = staffCandidates
    .filter((u) => !staffMembers.some((m) => m.userId === u.id))
    .map((u) => ({
      value: u.id,
      label: `${u.realName}（${u.username}）`,
    }));

  const toggleDuty = async (row: SiteMemberItem, duty: SiteDuty, checked: boolean) => {
    let next = checked
      ? [...new Set<SiteDuty>([...row.roles, duty])]
      : row.roles.filter((r) => r !== duty);
    if (checked && duty === 'primary_manager') {
      next = next.filter((r) => r !== 'deputy_manager');
    }
    if (checked && duty === 'deputy_manager') {
      next = next.filter((r) => r !== 'primary_manager');
    }
    try {
      await setMemberDuties(row.userId, next);
    } catch (error) {
      const shown = chineseErrorMessage(error instanceof Error ? error.message : error);
      message.error(shown || '更新任职失败');
    }
  };

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
      width: 220,
      fixed: 'right',
      render: (_, record) => (
        <Space wrap>
          <Button type="link" icon={<EditOutlined />} onClick={() => openEdit(record)}>
            编辑
          </Button>
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
      <Space className="admin-toolbar" style={{ marginBottom: 16 }} wrap>
        <Input.Search
          placeholder="搜索名称/编码/地区"
          allowClear
          onSearch={(v) => {
            setPage(1);
            setKeyword(v.trim());
          }}
          className="admin-toolbar__search"
        />
        <Input
          placeholder="省份"
          allowClear
          value={province}
          onChange={(e) => {
            setPage(1);
            setProvince(e.target.value);
          }}
          className="admin-toolbar__region"
        />
        <Input
          placeholder="城市"
          allowClear
          value={city}
          onChange={(e) => {
            setPage(1);
            setCity(e.target.value);
          }}
          className="admin-toolbar__region"
        />
        <Select
          allowClear
          placeholder="状态"
          className="admin-toolbar__select"
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

      <Typography.Paragraph type="secondary" className="admin-page-hint" style={{ marginBottom: 12 }}>
        {regionHint
          ? `当前筛选：${regionHint} → 共 ${total} 个网格`
          : '正长 / 副长 / 工程师在「人员」中勾选；同一人可兼工程师，正长与副长互斥。'}
      </Typography.Paragraph>

      <FillTable
        rowKey="id"
        loading={loading}
        columns={columns}
        dataSource={data}
        scroll={{ x: 1100 }}
        mobileCard={(record, _i, { closeSheet }) => (
          <>
            <div className="admin-mobile-card__head">
              <div>
                <strong>{record.name}</strong>
                <span className="admin-mobile-card__code">{record.code}</span>
              </div>
              <Tag color={record.status === 'active' ? 'green' : 'default'}>
                {record.status === 'active' ? '启用' : '停用'}
              </Tag>
            </div>
            <div className="admin-mobile-card__meta">
              <span>
                {record.province}
                {record.city}
                {record.district}
              </span>
              <span>正网格长：{record.manager?.realName || '未任命'}</span>
              {record.address ? <span>{record.address}</span> : null}
            </div>
            <div className="admin-mobile-card__actions">
              <Button
                size="middle"
                icon={<EditOutlined />}
                onClick={() => {
                  closeSheet();
                  openEdit(record);
                }}
              >
                编辑
              </Button>
              <Button
                size="middle"
                icon={<TeamOutlined />}
                onClick={() => {
                  closeSheet();
                  void openStaff(record);
                }}
              >
                人员
              </Button>
              {isAdmin && (
                <Popconfirm title="确认删除该网格？有设备时将失败" onConfirm={() => onDelete(record.id)}>
                  <Button size="middle" danger icon={<DeleteOutlined />}>
                    删除
                  </Button>
                </Popconfirm>
              )}
            </div>
          </>
        )}
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
        title={`网格人员 - ${staffSite?.name || ''}`}
        open={staffOpen}
        onCancel={() => setStaffOpen(false)}
        footer={null}
        width={modalWidth}
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
            {staffSite?.manager &&
              staffMembers.some(
                (item) => item.userId === staffSite.manager?.id && item.roles.includes('inspector'),
              ) && <Tag color="blue" style={{ margin: 0 }}>兼任工程师</Tag>}
          </Space>
        </div>
        <Typography.Paragraph type="secondary" style={{ marginBottom: 12 }}>
          {isAdmin
            ? '从平台账号池加人，勾选正长 / 副长 / 工程师。账号请到「账号管理」统开，此处不再新建账号。'
            : canManageDeputies
              ? '从平台账号池加人。可勾选副长与工程师；正长仅管理员可改。同一人可兼工程师。'
              : canManageInspectors
                ? '副网格长只能勾选工程师，不能改正长/副长。账号由管理员统开。'
                : '当前账号未任职本网格编制管理；请联系正网格长或管理员。'}
        </Typography.Paragraph>
        {canManageInspectors && (
          <Space style={{ marginBottom: 12 }} wrap>
            <Select
              showSearch
              style={{ width: 280 }}
              placeholder="从平台账号池选择"
              value={pickUserId}
              onChange={setPickUserId}
              optionFilterProp="label"
              options={poolOptions}
              notFoundContent="没有可加入的账号，请让管理员先开号"
            />
            <Button type="primary" onClick={() => void onAddMember()}>
              加入
            </Button>
            {selfCanQuickHire && (
              <Button onClick={() => void hireSelfAsInspector()}>本人兼任工程师</Button>
            )}
          </Space>
        )}
        <Table
          rowKey="id"
          size="small"
          loading={staffLoading}
          pagination={false}
          dataSource={staffMembers}
          columns={[
            { title: '姓名', dataIndex: ['user', 'realName'] },
            { title: '用户名', dataIndex: ['user', 'username'] },
            {
              title: '正长',
              width: 70,
              align: 'center',
              render: (_: unknown, r: SiteMemberItem) => (
                <Checkbox
                  checked={r.roles.includes('primary_manager')}
                  disabled={!canManagePrimary}
                  onChange={(e) => void toggleDuty(r, 'primary_manager', e.target.checked)}
                />
              ),
            },
            {
              title: '副长',
              width: 70,
              align: 'center',
              render: (_: unknown, r: SiteMemberItem) => (
                <Checkbox
                  checked={r.roles.includes('deputy_manager')}
                  disabled={!canManageDeputies}
                  onChange={(e) => void toggleDuty(r, 'deputy_manager', e.target.checked)}
                />
              ),
            },
            {
              title: '工程师',
              width: 80,
              align: 'center',
              render: (_: unknown, r: SiteMemberItem) => (
                <Checkbox
                  checked={r.roles.includes('inspector')}
                  disabled={!canManageInspectors}
                  onChange={(e) => void toggleDuty(r, 'inspector', e.target.checked)}
                />
              ),
            },
            ...(canManageInspectors
              ? [
                  {
                    title: '操作',
                    width: 90,
                    render: (_: unknown, r: SiteMemberItem) => (
                      <Popconfirm
                        title="确认移出本网格？不影响其他网格任职"
                        onConfirm={async () => {
                          try {
                            await setMemberDuties(r.userId, []);
                            message.success('已移出');
                          } catch (error) {
                            const shown = chineseErrorMessage(
                              error instanceof Error ? error.message : error,
                            );
                            message.error(shown || '移出失败');
                          }
                        }}
                      >
                        <Button type="link" danger>
                          移出
                        </Button>
                      </Popconfirm>
                    ),
                  },
                ]
              : []),
          ]}
        />
      </Modal>
    </div>
  );
}
