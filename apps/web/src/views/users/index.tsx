"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  Alert,
  Button,
  Checkbox,
  Form,
  Input,
  Modal,
  Popconfirm,
  Select,
  Space,
  Tag,
  Typography,
  message,
} from 'antd';
import { PlusOutlined, EditOutlined, MobileOutlined } from '@ant-design/icons';
import type { ColumnsType } from 'antd/es/table';
import {
  fetchStaffingUsers,
  fetchStaffingAppointments,
  createUser,
  updateUser,
  updateUserStatus,
  resetUserPassword,
  enableMyInspector,
} from '../../api/user';
import { fetchMyStaffSites, syncPrimaryManagerInspector } from '../../api/site';
import { roleTagsOf, userRolesOf, type StaffingAppointment } from '../../lib/staffing-roles';
import { useAuthStore } from '../../stores/auth';
import type { UserInfo, UserRole, CommonStatus } from '../../types';
import { isAntValidateError } from '../../utils/ant-form';
import { chineseErrorMessage } from '../../utils/displayLabels';
import FillTable, { listTablePagination } from '../../components/FillTable';

/** 账号管理：只管登录身份；网格编制在「网格管理 → 人员」 */
export default function UsersPage() {
  const currentUser = useAuthStore((s) => s.user);
  const isAdmin = currentUser?.role === 'super_admin';
  const isSiteManager = currentUser?.role === 'site_manager';

  const [loading, setLoading] = useState(false);
  const [data, setData] = useState<UserInfo[]>([]);
  const [appointments, setAppointments] = useState<Record<string, StaffingAppointment>>({});
  const [total, setTotal] = useState(0);
  const [page, setPage] = useState(1);
  const [pageSize, setPageSize] = useState(20);
  const [keyword, setKeyword] = useState('');
  const [role, setRole] = useState<UserRole | undefined>(undefined);

  const [modalOpen, setModalOpen] = useState(false);
  const [editing, setEditing] = useState<UserInfo | null>(null);
  const [form] = Form.useForm();
  const pendingFormValues = useRef<Record<string, unknown> | null>(null);

  const [pwdOpen, setPwdOpen] = useState(false);
  const [pwdUser, setPwdUser] = useState<UserInfo | null>(null);
  const [pwdForm] = Form.useForm();

  const [isPrimaryManager, setIsPrimaryManager] = useState(false);
  const [isDeputyManager, setIsDeputyManager] = useState(false);

  const canStaffAsManager = isSiteManager && (isPrimaryManager || isDeputyManager);
  const canStaffAccounts = isAdmin || canStaffAsManager;
  /** 副长只能开工程师号；正长可开副长+工程师；管理员账号页只开待任命网格长 */
  const deputyOnly = isSiteManager && isDeputyManager && !isPrimaryManager;

  const editingSelf = Boolean(editing && editing.id === currentUser?.id);

  const roleOptions = useMemo(() => {
    if (isAdmin) {
      return [{ value: 'site_manager', label: '网格长登录账号（待任命）' }];
    }
    if (editingSelf) {
      return [
        {
          value: 'site_manager',
          label: isPrimaryManager
            ? '正网格长（本账号）'
            : isDeputyManager
              ? '副网格长（本账号）'
              : '网格长（本账号）',
          disabled: true,
        },
        { value: 'inspector', label: '工程师（可登 H5）' },
      ];
    }
    if (deputyOnly) {
      return [{ value: 'inspector', label: '工程师（可登 H5）' }];
    }
    return [
      { value: 'site_manager', label: '副网格长登录账号（PC）' },
      { value: 'inspector', label: '工程师（可登 H5）' },
    ];
  }, [
    isAdmin,
    editingSelf,
    isPrimaryManager,
    isDeputyManager,
    deputyOnly,
  ]);

  const loadStaffFlags = useCallback(async () => {
    if (!isSiteManager || !currentUser?.id) {
      setIsPrimaryManager(false);
      setIsDeputyManager(false);
      return;
    }
    const staff = await fetchMyStaffSites(currentUser.id);
    setIsPrimaryManager(staff.isPrimary);
    setIsDeputyManager(staff.isDeputy);
  }, [isSiteManager, currentUser?.id]);

  useEffect(() => {
    void loadStaffFlags();
  }, [loadStaffFlags]);

  /** 正网格长开通工程师后，自动写入所管站工程师编制 */
  const syncSelfPrimaryInspector = async (userId: string) => {
    const staff = await fetchMyStaffSites(userId);
    let created = 0;
    for (const site of staff.list) {
      if (site.managerId !== userId) continue;
      const r = await syncPrimaryManagerInspector(site.id, userId, true);
      if (r === 'created') created += 1;
    }
    return created;
  };

  const loadList = useCallback(async () => {
    setLoading(true);
    try {
      const res = await fetchStaffingUsers({
        page,
        limit: pageSize,
        keyword: keyword || undefined,
        role,
      });
      setData(res.list);
      setTotal(res.total);
      const appt = await fetchStaffingAppointments(res.list.map((u) => u.id));
      setAppointments(appt);
    } catch (error) {
      const shown = chineseErrorMessage(error instanceof Error ? error.message : error);
      if (shown) message.error(shown);
    } finally {
      setLoading(false);
    }
  }, [page, pageSize, keyword, role]);

  useEffect(() => {
    void loadList();
  }, [loadList]);

  const iAmInspector = Boolean(
    currentUser?.roles?.includes('inspector') || currentUser?.role === 'inspector',
  );

  const openCreate = () => {
    if (!canStaffAccounts) {
      message.info('请先被任命为正网格长或副网格长');
      return;
    }
    setEditing(null);
    pendingFormValues.current = {
      roles: isAdmin ? ['site_manager'] : deputyOnly ? ['inspector'] : ['inspector'],
    };
    setModalOpen(true);
  };

  const openEdit = (record: UserInfo) => {
    setEditing(record);
    const list = userRolesOf(record);
    const isSelf = record.id === currentUser?.id;
    pendingFormValues.current = {
      ...record,
      roles: isAdmin
        ? ['site_manager']
        : isSelf
          ? list.includes('inspector')
            ? ['site_manager', 'inspector']
            : ['site_manager']
          : deputyOnly
            ? ['inspector']
            : list,
    };
    setModalOpen(true);
  };

  const submitUser = async () => {
    let values: Record<string, unknown> & {
      username?: string;
      phone?: string;
      roles?: UserRole[];
      realName?: string;
      employeeNo?: string;
      password?: string;
    };
    try {
      values = await form.validateFields();
    } catch (error) {
      if (isAntValidateError(error)) return;
      throw error;
    }
    try {
      if (
        !editing &&
        isSiteManager &&
        (values.username === currentUser?.username || values.phone === currentUser?.phone)
      ) {
        message.warning(
          '用户名或手机号与当前登录账号相同。新建下属工程师请换用不同的用户名和手机号；给自己开通 H5 请点页面上方「开通工程师身份」。',
        );
        return;
      }

      if (editing && editing.id === currentUser?.id && !isAdmin) {
        const nextRoles: UserRole[] = ['site_manager'];
        if (values.roles?.includes('inspector')) nextRoles.push('inspector');
        await updateUser(editing.id, {
          realName: values.realName,
          employeeNo: values.employeeNo,
          phone: values.phone,
          roles: nextRoles,
        });
        let synced = 0;
        if (nextRoles.includes('inspector')) {
          synced = await syncSelfPrimaryInspector(editing.id);
        }
        await useAuthStore.getState().fetchMe();
        message.success(
          nextRoles.includes('inspector')
            ? synced > 0
              ? `已更新，并同步写入 ${synced} 个正管网格编制`
              : deputyOnly
                ? '已更新；请到「网格管理 → 人员」点「聘用本人」加入编制'
                : '已更新；工程师身份已保留/开通。编制请到「网格管理 → 人员」'
            : '已更新（未勾选工程师则无法登录 H5）',
        );
        setModalOpen(false);
        void loadList();
        return;
      }

      const roles: UserRole[] = isAdmin
        ? ['site_manager']
        : deputyOnly
          ? ['inspector']
          : values.roles?.length
            ? values.roles
            : [values.role as UserRole].filter(Boolean);
      if (editing) {
        await updateUser(editing.id, {
          realName: values.realName,
          employeeNo: values.employeeNo,
          phone: values.phone,
          roles,
          role: roles.includes('site_manager') ? 'site_manager' : roles[0],
        });
        message.success('账号已更新');
        if (editing.id === currentUser?.id) await useAuthStore.getState().fetchMe();
      } else {
        await createUser({
          username: values.username,
          password: values.password,
          realName: values.realName,
          employeeNo: values.employeeNo,
          phone: values.phone,
          roles,
          role: roles.includes('site_manager') ? 'site_manager' : roles[0],
        });
        message.success(
          isAdmin
            ? '登录账号已创建（待任命）。请到「网格管理」任命为正网格长后才算正网格长'
            : deputyOnly
              ? '工程师账号已创建，请到「网格管理 → 人员」加入编制'
              : '账号已创建，请到「网格管理 → 人员」加入编制（或「新建并加入」）',
        );
      }
      setModalOpen(false);
      void loadList();
    } catch (error) {
      const shown = chineseErrorMessage(error instanceof Error ? error.message : error);
      message.error(shown || '操作失败');
    }
  };

  const onEnableMyInspector = async () => {
    try {
      await enableMyInspector();
      let synced = 0;
      if (currentUser?.id) synced = await syncSelfPrimaryInspector(currentUser.id);
      await useAuthStore.getState().fetchMe();
      message.success(
        synced > 0
          ? `已开通工程师，并同步写入 ${synced} 个正管网格编制`
          : deputyOnly
            ? '已开通工程师身份；请到「网格管理 → 人员」点「聘用本人」加入编制后登录 H5'
            : '已开通工程师身份；请到「网格管理 → 人员」加入编制后登录 H5',
      );
      void loadList();
    } catch (error) {
      const shown = chineseErrorMessage(error instanceof Error ? error.message : error);
      message.error(shown || '开通失败');
    }
  };

  const toggleStatus = async (record: UserInfo) => {
    try {
      const next: CommonStatus = record.status === 'active' ? 'inactive' : 'active';
      await updateUserStatus(record.id, next);
      message.success(next === 'active' ? '已启用' : '已停用');
      void loadList();
    } catch (error) {
      const shown = chineseErrorMessage(error instanceof Error ? error.message : error);
      message.error(shown || '操作失败');
    }
  };

  const submitPwd = async () => {
    let values: { newPassword?: string };
    try {
      values = await pwdForm.validateFields();
    } catch (error) {
      if (isAntValidateError(error)) return;
      throw error;
    }
    if (!pwdUser) return;
    try {
      await resetUserPassword(pwdUser.id, values.newPassword!);
      message.success('密码已重置');
      setPwdOpen(false);
    } catch (error) {
      const shown = chineseErrorMessage(error instanceof Error ? error.message : error);
      message.error(shown || '重置失败');
    }
  };

  const listColumns: ColumnsType<UserInfo> = [
    { title: '用户名', dataIndex: 'username', width: 120 },
    { title: '工号', dataIndex: 'employeeNo', width: 110, render: (v) => v || '-' },
    { title: '姓名', dataIndex: 'realName', width: 100 },
    { title: '手机号', dataIndex: 'phone', width: 130 },
    {
      title: '身份',
      dataIndex: 'roles',
      width: 200,
      render: (_roles: UserRole[] | undefined, r) => {
        const tags = roleTagsOf(r, {
          appointment: appointments[r.id] || 'none',
          currentUserId: currentUser?.id,
        });
        return (
          <Space size={[4, 4]} wrap>
            {tags.map((t) => (
              <Tag
                key={t}
                color={
                  t === '工程师'
                    ? 'blue'
                    : t === '超级管理员'
                      ? 'gold'
                      : t.includes('待任命')
                        ? 'default'
                        : 'green'
                }
              >
                {t}
              </Tag>
            ))}
          </Space>
        );
      },
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
      width: 260,
      fixed: 'right',
      render: (_, record) => {
        if (!canStaffAccounts) {
          return <Typography.Text type="secondary">只读</Typography.Text>;
        }
        return (
          <Space wrap>
            <Button type="link" icon={<EditOutlined />} onClick={() => openEdit(record)}>
              编辑
            </Button>
            <Button
              type="link"
              onClick={() => {
                setPwdUser(record);
                pwdForm.resetFields();
                setPwdOpen(true);
              }}
            >
              重置密码
            </Button>
            <Popconfirm
              title={`确认${record.status === 'active' ? '停用' : '启用'}该账号？`}
              onConfirm={() => void toggleStatus(record)}
            >
              <Button type="link" danger={record.status === 'active'}>
                {record.status === 'active' ? '停用' : '启用'}
              </Button>
            </Popconfirm>
          </Space>
        );
      },
    },
  ];

  return (
    <div className="admin-fill-page">
      <Alert
        type="info"
        showIcon
        style={{ marginBottom: 12 }}
        message={
          isAdmin
            ? '账号管理：在此创建「网格长登录账号（待任命）」。成为正网格长请到「网格管理 → 正网格长」任命；编制可到「人员」代配。'
            : canStaffAsManager
              ? deputyOnly
                ? '账号管理：副网格长只能开工程师登录账号。聘用/解聘请到「网格管理 → 人员」（不可设置副网格长）。'
                : '账号管理：正网格长可开副网格长/工程师登录账号。上岗请到「网格管理 → 人员」（支持新建并加入）。'
              : isSiteManager
                ? '当前账号尚未任命到任何电站，只能查看。请让管理员在「网格管理」任命为正网格长，或由正网格长添加为副网格长。'
                : '请先被任命为正网格长或副网格长后，再管理下属账号。'
        }
      />

      {canStaffAsManager && !iAmInspector && (
        <Alert
          type="success"
          showIcon
          style={{ marginBottom: 12 }}
          message="本账号尚未开通工程师身份"
          description={
            isPrimaryManager
              ? '开通后可用同一用户名登录 H5；正管电站将自动写入工程师编制。'
              : '开通后可用同一用户名登录 H5；请再到「网格管理 → 人员」点「聘用本人」加入编制。'
          }
          action={
            <Button type="primary" icon={<MobileOutlined />} onClick={() => void onEnableMyInspector()}>
              开通工程师身份
            </Button>
          }
        />
      )}

      <Space className="admin-toolbar" style={{ marginBottom: 16 }} wrap>
        <Input.Search
          placeholder="搜索用户名/姓名/手机"
          allowClear
          onSearch={(v) => {
            setPage(1);
            setKeyword(v);
          }}
          className="admin-toolbar__search"
        />
        <Select
          allowClear
          placeholder="身份"
          className="admin-toolbar__select"
          value={role}
          onChange={(v) => {
            setPage(1);
            setRole(v);
          }}
          options={
            isAdmin
              ? [{ value: 'site_manager', label: '网格长账号' }]
              : deputyOnly
                ? [{ value: 'inspector', label: '工程师' }]
                : [
                    { value: 'site_manager', label: '副网格长账号' },
                    { value: 'inspector', label: '工程师' },
                  ]
          }
        />
        {canStaffAccounts ? (
          <Button type="primary" icon={<PlusOutlined />} onClick={openCreate}>
            新增账号
          </Button>
        ) : (
          isSiteManager && (
            <Typography.Text type="secondary">先完成任命后再新增账号</Typography.Text>
          )
        )}
      </Space>

      <FillTable
        rowKey="id"
        loading={loading}
        columns={listColumns}
        dataSource={data}
        scroll={{ x: 960 }}
        mobileCard={(record, _i, { closeSheet }) => {
          const tags = roleTagsOf(record, {
            appointment: appointments[record.id] || 'none',
            currentUserId: currentUser?.id,
          });
          const title = record.realName || record.username;
          const showCode = Boolean(record.username && record.username !== title);
          return (
            <>
              <div className="admin-mobile-card__head">
                <div>
                  <strong>{title}</strong>
                  {showCode ? <span className="admin-mobile-card__code">{record.username}</span> : null}
                </div>
                <Tag color={record.status === 'active' ? 'green' : 'default'}>
                  {record.status === 'active' ? '启用' : '停用'}
                </Tag>
              </div>
              <div className="admin-mobile-card__meta">
                {record.employeeNo ? <span>工号 {record.employeeNo}</span> : null}
                {record.phone ? <span>{record.phone}</span> : null}
                {tags.length ? (
                  <span className="admin-mobile-card__tags">
                    {tags.map((t) => (
                      <Tag
                        key={t}
                        color={
                          t === '工程师'
                            ? 'blue'
                            : t === '超级管理员'
                              ? 'gold'
                              : t.includes('待任命')
                                ? 'default'
                                : 'green'
                        }
                      >
                        {t}
                      </Tag>
                    ))}
                  </span>
                ) : null}
              </div>
              <div className="admin-mobile-card__actions">
                {canStaffAccounts ? (
                  <>
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
                      onClick={() => {
                        closeSheet();
                        setPwdUser(record);
                        pwdForm.resetFields();
                        setPwdOpen(true);
                      }}
                    >
                      重置密码
                    </Button>
                    <Popconfirm
                      title={`确认${record.status === 'active' ? '停用' : '启用'}该账号？`}
                      onConfirm={() => void toggleStatus(record)}
                    >
                      <Button size="middle" danger={record.status === 'active'}>
                        {record.status === 'active' ? '停用' : '启用'}
                      </Button>
                    </Popconfirm>
                  </>
                ) : (
                  <Typography.Text type="secondary">只读</Typography.Text>
                )}
              </div>
            </>
          );
        }}
        pagination={listTablePagination({
          current: page,
          total,
          pageSize,
          onChange: (p, ps) => {
            setPage(p);
            setPageSize(ps);
          },
        })}
      />

      <Modal
        title={editing ? '编辑账号' : '新增账号'}
        open={modalOpen}
        onCancel={() => setModalOpen(false)}
        onOk={() => void submitUser()}
        destroyOnHidden
        afterOpenChange={(open) => {
          if (!open) return;
          const values = pendingFormValues.current;
          if (!values) return;
          pendingFormValues.current = null;
          form.resetFields();
          form.setFieldsValue(values);
        }}
      >
        <Form form={form} layout="vertical">
          {!editing && (
            <>
              <Form.Item
                name="username"
                label="用户名"
                rules={[{ required: true, message: '请输入用户名' }]}
                extra={
                  isSiteManager
                    ? '须与您的登录名不同；给自己开通 H5 请点页面上方「开通工程师身份」。'
                    : undefined
                }
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
            </>
          )}
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
            <Input placeholder="员工工号，不可重复" />
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
          <Form.Item
            name="roles"
            label={isAdmin || deputyOnly ? '登录身份' : '登录身份（可多选）'}
            rules={[{ required: true, type: 'array', min: 1, message: '请选择身份' }]}
            extra={
              isAdmin
                ? '此处只开登录账号，不会自动成为正网格长；请到「网格管理」任命。'
                : editingSelf
                  ? isPrimaryManager
                    ? '本账号可开通工程师以登录 H5；正管电站会自动同步工程师编制。'
                    : '本账号可开通工程师以登录 H5；开通后请到「人员」点「聘用本人」。'
                  : deputyOnly
                    ? '副网格长只能开工程师账号；上岗请到「人员」。'
                    : '此处只开账号。加入哪座电站请到「网格管理 → 人员」。'
            }
          >
            <Checkbox.Group options={roleOptions} />
          </Form.Item>
        </Form>
      </Modal>

      <Modal
        title={`重置密码 - ${pwdUser?.realName || ''}`}
        open={pwdOpen}
        onCancel={() => setPwdOpen(false)}
        onOk={() => void submitPwd()}
      >
        <Form form={pwdForm} layout="vertical">
          <Form.Item
            name="newPassword"
            label="新密码"
            rules={[{ required: true, min: 6, message: '至少6位' }]}
          >
            <Input.Password />
          </Form.Item>
        </Form>
      </Modal>
    </div>
  );
}
