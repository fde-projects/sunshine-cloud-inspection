"use client";

import { useEffect, useState } from 'react';
import {
  Card,
  Form,
  Input,
  Button,
  Tabs,
  message,
  Descriptions,
  Tag,
  Upload,
  Space,
  Image,
} from 'antd';
import { UploadOutlined, DeleteOutlined } from '@ant-design/icons';
import { useAuthStore } from '../../stores/auth';
import { brandMarkText, useBrandingStore } from '../../stores/branding';
import { updateProfileApi, changePasswordApi } from '../../api/auth';
import { updateSystemBranding } from '../../api/system';
import { uploadImage } from '../../api/upload';
import { ROLE_LABEL } from '../../types';
import { isAntValidateError } from '../../utils/ant-form';

function ProfileTab() {
  const { user, fetchMe } = useAuthStore();
  const [form] = Form.useForm();
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    if (!user) return;
    form.setFieldsValue({ realName: user.realName, phone: user.phone });
  }, [user, form]);

  const save = async () => {
    try {
      const values = await form.validateFields();
      setSaving(true);
      await updateProfileApi(values);
      await fetchMe();
      message.success('资料已更新');
    } catch (error) {
      if (isAntValidateError(error)) return;
      message.error(error instanceof Error ? error.message : '资料保存失败');
    } finally {
      setSaving(false);
    }
  };

  return (
    <Card>
      <Form form={form} layout="vertical" style={{ maxWidth: 480 }}>
        <Form.Item name="realName" label="姓名" rules={[{ required: true }]}>
          <Input />
        </Form.Item>
        <Form.Item name="phone" label="手机号" rules={[{ required: true }]}>
          <Input />
        </Form.Item>
        <Button type="primary" loading={saving} onClick={() => void save()}>
          保存资料
        </Button>
      </Form>
    </Card>
  );
}

function PasswordTab() {
  const [form] = Form.useForm();
  const [saving, setSaving] = useState(false);

  const save = async () => {
    try {
      const values = await form.validateFields();
      if (values.newPassword !== values.confirmPassword) {
        message.error('两次输入的新密码不一致');
        return;
      }
      setSaving(true);
      await changePasswordApi(values.oldPassword, values.newPassword);
      message.success('密码已修改，请妥善保管');
      form.resetFields();
    } catch (error) {
      if (isAntValidateError(error)) return;
      message.error(error instanceof Error ? error.message : '密码修改失败');
    } finally {
      setSaving(false);
    }
  };

  return (
    <Card>
      <Form form={form} layout="vertical" style={{ maxWidth: 480 }}>
        <Form.Item
          name="oldPassword"
          label="原密码"
          rules={[{ required: true, message: '请输入原密码' }]}
        >
          <Input.Password />
        </Form.Item>
        <Form.Item
          name="newPassword"
          label="新密码"
          rules={[{ required: true, min: 6, message: '至少 6 位' }]}
        >
          <Input.Password />
        </Form.Item>
        <Form.Item
          name="confirmPassword"
          label="确认新密码"
          rules={[{ required: true, message: '请再次输入' }]}
        >
          <Input.Password />
        </Form.Item>
        <Button type="primary" loading={saving} onClick={() => void save()}>
          修改密码
        </Button>
      </Form>
    </Card>
  );
}

function BrandingTab() {
  const branding = useBrandingStore((s) => s.branding);
  const setBranding = useBrandingStore((s) => s.setBranding);
  const [form] = Form.useForm();
  const [saving, setSaving] = useState(false);
  const [uploadingLogo, setUploadingLogo] = useState(false);
  const [logoPreview, setLogoPreview] = useState<string | null>(branding.logoUrl);

  useEffect(() => {
    setLogoPreview(branding.logoUrl);
    form.setFieldsValue({
      systemName: branding.systemName,
      subtitle: branding.subtitle || '',
    });
  }, [branding.logoUrl, branding.systemName, branding.subtitle, form]);

  const save = async () => {
    try {
      const values = await form.validateFields();
      setSaving(true);
      const next = await updateSystemBranding({
        systemName: values.systemName,
        subtitle: values.subtitle || '',
        logoUrl: logoPreview || '',
      });
      setBranding({
        systemName: next.systemName?.trim() || values.systemName,
        subtitle: next.subtitle ?? values.subtitle ?? '',
        logoUrl: next.logoUrl || logoPreview || null,
        updatedAt: next.updatedAt || new Date().toISOString(),
      });
      message.success('系统品牌已更新');
    } catch (error) {
      if (isAntValidateError(error)) return;
      message.error(error instanceof Error ? error.message : '品牌保存失败');
    } finally {
      setSaving(false);
    }
  };

  return (
    <Card>
      <Form form={form} layout="vertical" style={{ maxWidth: 520 }}>
        <Form.Item
          name="systemName"
          label="系统名称"
          rules={[{ required: true, message: '请输入系统名称' }, { max: 64 }]}
        >
          <Input placeholder="例如：阳光运维系统" maxLength={64} showCount />
        </Form.Item>
        <Form.Item name="subtitle" label="副标题" rules={[{ max: 64 }]}>
          <Input placeholder="例如：阳光运维平台" maxLength={64} showCount />
        </Form.Item>
        <Form.Item
          label="系统 Logo"
          extra="建议正方形 PNG/JPG。保存后用于侧栏、登录页；浏览器标签图标经同源接口刷新（若未变可硬刷新标签页）。"
        >
          <Space align="start" size={16} wrap>
            <div
              style={{
                width: 72,
                height: 72,
                borderRadius: 16,
                overflow: 'hidden',
                display: 'grid',
                placeItems: 'center',
                background: 'linear-gradient(145deg, #31c48d, #16835f)',
                color: '#fff',
                fontWeight: 800,
                fontSize: 28,
                boxShadow: '0 8px 20px rgba(31,196,141,.22)',
              }}
            >
              {logoPreview ? (
                <Image
                  src={logoPreview}
                  width={72}
                  height={72}
                  preview={false}
                  style={{ objectFit: 'cover', display: 'block' }}
                />
              ) : (
                brandMarkText(branding.systemName)
              )}
            </div>
            <Space direction="vertical">
              <Upload
                accept="image/png,image/jpeg,image/webp,image/gif"
                showUploadList={false}
                beforeUpload={(file) => {
                  setUploadingLogo(true);
                  void (async () => {
                    try {
                      const res = await uploadImage(file as File);
                      setLogoPreview(res.url);
                      message.success('Logo 已上传，请点击保存');
                    } catch (error) {
                      message.error(error instanceof Error ? error.message : 'Logo 上传失败');
                    } finally {
                      setUploadingLogo(false);
                    }
                  })();
                  return false;
                }}
              >
                <Button icon={<UploadOutlined />} loading={uploadingLogo}>
                  上传 Logo
                </Button>
              </Upload>
              {logoPreview ? (
                <Button icon={<DeleteOutlined />} onClick={() => setLogoPreview(null)}>
                  清除 Logo
                </Button>
              ) : null}
            </Space>
          </Space>
        </Form.Item>
        <Button type="primary" loading={saving} onClick={() => void save()}>
          保存品牌设置
        </Button>
      </Form>
    </Card>
  );
}

/** 系统设置：个人资料 + 修改密码 +（超管）品牌设置 */
export default function SettingsPage() {
  const user = useAuthStore((s) => s.user);
  const isSuperAdmin = user?.role === 'super_admin';

  const tabItems = [
    {
      key: 'profile',
      label: '个人资料',
      forceRender: true,
      children: <ProfileTab />,
    },
    {
      key: 'password',
      label: '修改密码',
      forceRender: true,
      children: <PasswordTab />,
    },
    ...(isSuperAdmin
      ? [
          {
            key: 'branding',
            label: '系统品牌',
            forceRender: true,
            children: <BrandingTab />,
          },
        ]
      : []),
  ];

  return (
    <div>
      <Card size="small" style={{ marginBottom: 16 }}>
        <Descriptions column={3} size="small">
          <Descriptions.Item label="用户名">{user?.username}</Descriptions.Item>
          <Descriptions.Item label="角色">
            <Tag>{user?.role ? ROLE_LABEL[user.role] : '-'}</Tag>
          </Descriptions.Item>
          <Descriptions.Item label="账号状态">
            {user?.status === 'active' ? '正常' : '停用'}
          </Descriptions.Item>
        </Descriptions>
      </Card>

      <Tabs items={tabItems} />
    </div>
  );
}
