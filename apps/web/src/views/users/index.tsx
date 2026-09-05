"use client";

import { useCallback, useEffect, useRef, useState } from 'react';
import { useRouter } from 'next/navigation';
import {
  Alert,
  Button,
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
import { PlusOutlined, EditOutlined } from '@ant-design/icons';
import type { ColumnsType } from 'antd/es/table';
import {
  fetchStaffingUsers,
  createUser,
  updateUser,
  updateUserStatus,
  resetUserPassword,
} from '../../api/user';
import { roleTagsOf } from '../../lib/staffing-roles';
import { useAuthStore } from '../../stores/auth';
import type { UserInfo, UserRole, CommonStatus } from '../../types';
import { isAntValidateError } from '../../utils/ant-form';
import { chineseErrorMessage } from '../../utils/displayLabels';
import FillTable, { listTablePagination } from '../../components/FillTable';

/** 账号管理：只管登录身份；网格编制在「网格管理 → 人员」 */
export default function UsersPage() {
  const router = useRouter();
  const currentUser = useAuthStore((s) => s.user);
  const isAdmin = currentUser?.role === 'super_admin';

  useEffect(() => {
    if (currentUser && !isAdmin) router.replace('/sites');
  }, [currentUser, isAdmin, router]);

  const [loading, setLoading] = useState(false);
  const [data, setData] = useState<UserInfo[]>([]);
  const [total, setTotal] = useState(0);
  const [page, setPage] = useState(1);
  const [pageSize, setPageSize] = useState(20);
  const [keyword, setKeyword] = useState('');
  const [dutyFilter, setDutyFilter] = useState<'primary' | 'deputy' | 'inspector' | 'plain' | undefined>();

  const [modalOpen, setModalOpen] = useState(false);
  const [editing, setEditing] = useState<UserInfo | null>(null);
  const [form] = Form.useForm();
  const pendingFormValues = useRef<Record<string, unknown> | null>(null);

  const [pwdOpen, setPwdOpen] = useState(false);
  const [pwdUser, setPwdUser] = useState<UserInfo | null>(null);
  const [pwdForm] = Form.useForm();

  const canStaffAccounts = isAdmin;

  const loadList = useCallback(async () => {
    setLoading(true);
    try {
      const res = await fetchStaffingUsers({
        page: dutyFilter ? 1 : page,
        limit: dutyFilter ? 500 : pageSize,
        keyword: keyword || undefined,
      });
      let list = res.list;
      if (dutyFilter === 'primary') list = list.filter((u) => u.duties?.primary);
      else if (dutyFilter === 'deputy') list = list.filter((u) => u.duties?.deputy);
      else if (dutyFilter === 'inspector') list = list.filter((u) => u.duties?.inspector);
      else if (dutyFilter === 'plain') {
        list = list.filter((u) => !u.duties?.primary && !u.duties?.deputy && !u.duties?.inspector);
      }
      setData(list);
      setTotal(dutyFilter ? list.length : res.total);
    } catch (error) {
      const shown = chineseErrorMessage(error instanceof Error ? error.message : error);
      if (shown) message.error(shown);
    } finally {
      setLoading(false);
    }
  }, [page, pageSize, keyword, dutyFilter]);

  useEffect(() => {
    void loadList();
  }, [loadList]);

  const openCreate = () => {
    if (!canStaffAccounts) {
      message.info('仅管理员可开设平台账号');
      return;
    }
    setEditing(null);
    pendingFormValues.current = {};
    setModalOpen(true);
  };

  const openEdit = (record: UserInfo) => {
    setEditing(record);
    pendingFormValues.current = { ...record };
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
      if (editing) {
        await updateUser(editing.id, {
          realName: values.realName,
          employeeNo: values.employeeNo,
          phone: values.phone,
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
        });
        message.success('普通账号已创建。任职请到「网格管理 → 人员」勾选。');
      }
      setModalOpen(false);
      void loadList();
    } catch (error) {
      const shown = chineseErrorMessage(error instanceof Error ? error.message : error);
      if (shown.includes('用户名')) {
        form.setFields([{ name: 'username', errors: [shown] }]);
      }
      if (shown.includes('工号')) {
        form.setFields([{ name: 'employeeNo', errors: [shown] }]);
      }
      message.error(shown || '操作失败');
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
          duties: r.duties,
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
        message="账号只负责登录。此处统开普通账号；正长 / 副长 / 工程师请到「网格管理 → 人员」勾选。"
      />

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
          placeholder="任职"
          className="admin-toolbar__select"
          value={dutyFilter}
          onChange={(v) => {
            setPage(1);
            setDutyFilter(v);
          }}
          options={[
            { value: 'primary', label: '正网格长' },
            { value: 'deputy', label: '副网格长' },
            { value: 'inspector', label: '工程师' },
            { value: 'plain', label: '普通账号' },
          ]}
        />
        {canStaffAccounts ? (
          <Button type="primary" icon={<PlusOutlined />} onClick={openCreate}>
            新增账号
          </Button>
        ) : (
          <Typography.Text type="secondary">账号由管理员统开</Typography.Text>
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
            duties: record.duties,
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
                extra="登录名全局唯一，不能和其他账号重复"
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
          <Typography.Paragraph type="secondary" style={{ marginBottom: 0 }}>
            账号只用于登录。正长 / 副长 / 工程师请到「网格管理 → 人员」勾选。
          </Typography.Paragraph>
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
