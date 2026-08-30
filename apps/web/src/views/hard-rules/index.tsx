"use client";

import { useCallback, useEffect, useMemo, useState } from 'react';
import {
  Alert,
  Button,
  Card,
  Collapse,
  Form,
  Image,
  Input,
  Modal,
  Popconfirm,
  Select,
  Space,
  Switch,
  Table,
  Tag,
  Typography,
  Upload,
  message,
} from 'antd';
import {
  CloseOutlined,
  DeleteOutlined,
  EditOutlined,
  ExperimentOutlined,
  PlusOutlined,
  ReloadOutlined,
  ThunderboltOutlined,
} from '@ant-design/icons';
import type { ColumnsType } from 'antd/es/table';
import {
  fetchHardRules,
  fetchHardRuleCatalog,
  createHardRule,
  updateHardRule,
  deleteHardRule,
  resetHardRule,
  previewHardRule,
  draftHardRule,
  labelHardRuleSamples,
  type HardRuleItem,
  type HardRuleCatalogItem,
  type HardRuleEnforceMode,
  type HardRulePreviewResult,
  type HardRulePassView,
} from '../../api/hard-rule';
import { uploadImage } from '../../api/upload';
import {
  HARD_RULE_FAIL_SAMPLE_LIMIT,
  HARD_RULE_PASS_SAMPLE_LIMIT,
  HARD_RULE_TRIAL_PHOTO_LIMIT,
  HARD_RULE_VIEW_LABEL_MAX,
  bindingLabel,
  catalogEntryKey,
  matchHardRule,
  sanitizePassViews,
  sanitizeViewLabel,
} from '../../lib/hard-rule-match';
import { composeHardRulePrompt, hydrateCriteriaFromPrompt } from '../../lib/hard-rule-prompt';
import { displayPhotoUrl } from '../../utils/photo-url';
import { isAntValidateError } from '../../utils/ant-form';

const ENFORCE_MODE_LABEL: Record<string, string> = {
  strict: '严格（拿不准判不合格）',
  normal: '标准',
  off: '关闭（不套用）',
};

type EditorMode = 'create' | 'edit';

function catalogLabel(item: HardRuleCatalogItem) {
  return bindingLabel({
    entryName: item.entryName || item.name || '',
    templateName: item.templateName,
    productLineName: item.productLineName,
  });
}

function ruleTitleFromKeys(keys: string[], catalog: HardRuleCatalogItem[]) {
  const items = catalog.filter((item) => keys.includes(item.key));
  if (!items.length) return '';
  const first = items[0].entryName || items[0].name || '';
  return items.length === 1 ? first : `${first} 等${items.length}项`;
}

function keysForRule(row: HardRuleItem | null | undefined, catalog: HardRuleCatalogItem[]) {
  if (!row) return [];
  const fromBindings = (row.bindings || [])
    .map((item) => catalogEntryKey(item.templateId, item.entryId))
    .filter((key) => catalog.some((item) => item.key === key));
  if (fromBindings.length) return fromBindings;
  return catalog
    .filter((item) =>
      matchHardRule(row, {
        title: item.entryName || item.name || '',
        description: item.description,
        templateId: item.templateId,
        entryId: item.entryId,
      }),
    )
    .map((item) => item.key);
}

function collectCatalogPassSamples(
  keys: string[],
  catalog: HardRuleCatalogItem[],
  preferKey?: string,
) {
  const selected = catalog.filter((item) => keys.includes(item.key));
  const ordered = preferKey
    ? [
        ...selected.filter((item) => item.key === preferKey),
        ...selected.filter((item) => item.key !== preferKey),
      ]
    : selected;
  const urls: string[] = [];
  const seen = new Set<string>();
  for (const item of ordered) {
    for (const raw of item.samplePhotos || []) {
      const url = String(raw || '').trim();
      if (!url || seen.has(url)) continue;
      seen.add(url);
      urls.push(url);
      if (urls.length >= HARD_RULE_PASS_SAMPLE_LIMIT) return urls;
    }
  }
  return urls;
}

function bindingsFromKeys(keys: string[], catalog: HardRuleCatalogItem[]) {
  return catalog
    .filter((item) => keys.includes(item.key))
    .map((item) => ({
      templateId: item.templateId,
      entryId: item.entryId,
      templateName: item.templateName,
      entryName: item.entryName || item.name || '',
      productLineName: item.productLineName || '',
    }));
}

function SampleThumbs({
  urls,
  size = 64,
  onClear,
  onRemove,
}: {
  urls: string[];
  size?: number;
  onClear: () => void;
  onRemove?: (url: string) => void;
}) {
  if (!urls.length) return null;
  return (
    <Image.PreviewGroup>
      <Space wrap style={{ marginTop: 8 }}>
        {urls.map((url) => (
          <span key={url} style={{ position: 'relative', display: 'inline-block' }}>
            <Image
              src={displayPhotoUrl(url)}
              width={size}
              height={size}
              style={{ objectFit: 'cover', borderRadius: 6 }}
            />
            {onRemove ? (
              <Button
                type="text"
                size="small"
                aria-label="移除样张"
                icon={<CloseOutlined />}
                onClick={(event) => {
                  event.stopPropagation();
                  onRemove(url);
                }}
                style={{
                  position: 'absolute',
                  top: -8,
                  right: -8,
                  width: 18,
                  height: 18,
                  minWidth: 18,
                  padding: 0,
                  fontSize: 10,
                  background: '#fff',
                  boxShadow: '0 0 0 1px #d9d9d9',
                }}
              />
            ) : null}
          </span>
        ))}
        <Button type="link" onClick={onClear}>
          清空
        </Button>
      </Space>
    </Image.PreviewGroup>
  );
}

function PassSampleCards({
  items,
  labeling,
  onClear,
  onRemove,
  onLabelChange,
}: {
  items: HardRulePassView[];
  labeling?: boolean;
  onClear: () => void;
  onRemove: (url: string) => void;
  onLabelChange: (url: string, label: string) => void;
}) {
  if (!items.length) return null;
  return (
    <Image.PreviewGroup>
      <Space wrap align="start" style={{ marginTop: 8 }}>
        {items.map((item, index) => (
          <span key={item.url} style={{ display: 'inline-block', width: 96 }}>
            <span style={{ position: 'relative', display: 'inline-block' }}>
              <Image
                src={displayPhotoUrl(item.url)}
                width={72}
                height={72}
                style={{ objectFit: 'cover', borderRadius: 6 }}
              />
              <Button
                type="text"
                size="small"
                aria-label="移除样张"
                icon={<CloseOutlined />}
                onClick={(event) => {
                  event.stopPropagation();
                  onRemove(item.url);
                }}
                style={{
                  position: 'absolute',
                  top: -8,
                  right: -8,
                  width: 18,
                  height: 18,
                  minWidth: 18,
                  padding: 0,
                  fontSize: 10,
                  background: '#fff',
                  boxShadow: '0 0 0 1px #d9d9d9',
                }}
              />
            </span>
            <Input
              size="small"
              value={item.label}
              maxLength={HARD_RULE_VIEW_LABEL_MAX}
              placeholder={labeling ? '起名中…' : `视角${index + 1}`}
              disabled={labeling}
              onChange={(event) => onLabelChange(item.url, event.target.value)}
              style={{ marginTop: 6, width: 96 }}
            />
          </span>
        ))}
        <Button type="link" onClick={onClear} disabled={labeling}>
          清空
        </Button>
      </Space>
    </Image.PreviewGroup>
  );
}

/** 超管：AI 硬规则。选检查项 + 白话合格/不合格，保存前可试跑。 */
export default function HardRulesPage() {
  const [loading, setLoading] = useState(false);
  const [list, setList] = useState<HardRuleItem[]>([]);
  const [catalog, setCatalog] = useState<HardRuleCatalogItem[]>([]);
  const [editorOpen, setEditorOpen] = useState(false);
  const [editorMode, setEditorMode] = useState<EditorMode>('create');
  const [editing, setEditing] = useState<HardRuleItem | null>(null);
  const [saving, setSaving] = useState(false);
  const [form] = Form.useForm();
  const [trialUrls, setTrialUrls] = useState<string[]>([]);
  const [trialUploading, setTrialUploading] = useState(false);
  const [trialing, setTrialing] = useState(false);
  const [trialResult, setTrialResult] = useState<HardRulePreviewResult | null>(null);
  const [passSamples, setPassSamples] = useState<HardRulePassView[]>([]);
  const [failSampleUrls, setFailSampleUrls] = useState<string[]>([]);
  const [sampleUploading, setSampleUploading] = useState<'pass' | 'fail' | null>(null);
  const [sampleLabeling, setSampleLabeling] = useState(false);
  const [drafting, setDrafting] = useState(false);
  const [draftFromAi, setDraftFromAi] = useState(false);

  const passWatch = Form.useWatch('passCriteria', form);
  const failWatch = Form.useWatch('failCriteria', form);
  const enforceWatch = Form.useWatch('enforceMode', form);
  const entryKeyWatch = Form.useWatch('entryKey', form) as string | undefined;

  const generatedPrompt = useMemo(
    () =>
      composeHardRulePrompt({
        name: ruleTitleFromKeys(entryKeyWatch ? [entryKeyWatch] : [], catalog),
        passCriteria: passWatch,
        failCriteria: failWatch,
        enforceMode: enforceWatch,
      }),
    [entryKeyWatch, catalog, passWatch, failWatch, enforceWatch],
  );

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const [rules, items] = await Promise.all([fetchHardRules(), fetchHardRuleCatalog()]);
      setList(rules);
      setCatalog(items);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const resetTrial = () => {
    setTrialUrls([]);
    setTrialResult(null);
  };

  const applyPassLabels = async (views: HardRulePassView[], title?: string) => {
    if (!views.length) {
      setPassSamples([]);
      return;
    }
    setPassSamples(views);
    setSampleLabeling(true);
    try {
      const values = form.getFieldsValue();
      const selected = catalog.find((item) => item.key === values.entryKey);
      const result = await labelHardRuleSamples({
        title: title || selected?.entryName || String(values.name || '') || '检查项',
        views,
      });
      setPassSamples(
        views.map((item, index) => ({
          url: item.url,
          label: result.labels[index] || item.label || `视角${index + 1}`,
        })),
      );
    } catch {
      setPassSamples(
        views.map((item, index) => ({
          ...item,
          label: item.label || `视角${index + 1}`,
        })),
      );
    } finally {
      setSampleLabeling(false);
    }
  };

  const openCreate = () => {
    setEditorMode('create');
    setEditing(null);
    resetTrial();
    setPassSamples([]);
    setFailSampleUrls([]);
    setDraftFromAi(false);
    form.setFieldsValue({
      entryKey: undefined,
      passCriteria: '',
      failCriteria: '',
      enabled: true,
      enforceMode: 'strict',
      changeNote: '',
      failNote: '',
    });
    setEditorOpen(true);
  };

  const openEdit = (row: HardRuleItem) => {
    setEditorMode('edit');
    setEditing(row);
    resetTrial();
    const views = sanitizePassViews(row.samples?.pass).slice(0, HARD_RULE_PASS_SAMPLE_LIMIT);
    setPassSamples(views);
    setFailSampleUrls((row.samples?.fail || []).slice(0, HARD_RULE_FAIL_SAMPLE_LIMIT));
    setDraftFromAi(false);
    const parsed = hydrateCriteriaFromPrompt(row.promptText);
    const keys = keysForRule(row, catalog);
    form.setFieldsValue({
      entryKey: keys[0],
      passCriteria: parsed.passCriteria,
      failCriteria: parsed.failCriteria,
      enabled: row.enabled,
      enforceMode: row.enforceMode,
      changeNote: '',
      failNote: '',
    });
    setEditorOpen(true);
    if (views.some((item) => !item.label)) {
      void applyPassLabels(views, row.name);
    }
  };

  const handleSave = async () => {
    try {
      const values = await form.validateFields();
      setSaving(true);
      const enforceMode = values.enforceMode as HardRuleEnforceMode;
      const changeNote = String(values.changeNote || '').trim();

      const entryKeys = values.entryKey ? [String(values.entryKey)] : [];
      const bindings = bindingsFromKeys(entryKeys, catalog);
      const name = ruleTitleFromKeys(entryKeys, catalog);
      if (!name) {
        message.error('请选择检查项');
        return;
      }
      if (editorMode === 'create') {
        await createHardRule({
          name,
          bindings,
          passCriteria: values.passCriteria,
          failCriteria: values.failCriteria,
          passSampleViews: passSamples,
          failSampleUrls,
          enabled: values.enabled,
          enforceMode,
          changeNote: changeNote || '新建自定义硬规则',
        });
        message.success('已新增规则，新分析将自动匹配');
      } else if (editing) {
        await updateHardRule(editing.code, {
          name,
          bindings,
          passCriteria: values.passCriteria,
          failCriteria: values.failCriteria,
          passSampleViews: passSamples,
          failSampleUrls,
          enabled: values.enabled,
          enforceMode,
          changeNote: changeNote || '更新硬规则',
        });
        message.success('硬规则已保存，新分析将使用新版本');
      }
      setEditorOpen(false);
      setEditing(null);
      await load();
    } catch (e) {
      if (!isAntValidateError(e)) {
        /* interceptor */
      }
    } finally {
      setSaving(false);
    }
  };

  const handleReset = async (row: HardRuleItem) => {
    try {
      await resetHardRule(row.code, `恢复 ${row.code} 内置默认`);
      message.success('已恢复内置默认硬规则');
      await load();
    } catch {
      /* interceptor */
    }
  };

  const handleDelete = async (row: HardRuleItem) => {
    try {
      await deleteHardRule(row.code);
      message.success('已删除自定义规则');
      await load();
    } catch {
      /* interceptor */
    }
  };

  const handleSampleUpload = async (kind: 'pass' | 'fail', files: File[]) => {
    if (!files.length) return;
    const limit = kind === 'pass' ? HARD_RULE_PASS_SAMPLE_LIMIT : HARD_RULE_FAIL_SAMPLE_LIMIT;
    const used = kind === 'pass' ? passSamples.length : failSampleUrls.length;
    const room = Math.max(0, limit - used);
    if (!room) return;
    setSampleUploading(kind);
    try {
      const urls: string[] = [];
      for (const file of files.slice(0, room)) {
        const res = await uploadImage(file, { siteName: '硬规则样张', serialNumber: kind });
        urls.push(res.url);
      }
      if (kind === 'pass') {
        const next = [...passSamples, ...urls.map((url) => ({ url, label: '' }))].slice(0, limit);
        message.success(`已上传 ${urls.length} 张合格样，正在起名`);
        await applyPassLabels(next);
      } else {
        setFailSampleUrls((prev) => [...prev, ...urls].slice(0, limit));
        message.success(`已上传 ${urls.length} 张不合格样`);
      }
    } catch {
      message.error('样张上传失败');
    } finally {
      setSampleUploading(null);
    }
  };

  const handleImportPassFromCatalog = () => {
    const values = form.getFieldsValue();
    const keys = values.entryKey ? [String(values.entryKey)] : [];
    if (!keys.length) {
      message.error('请先选择检查项');
      return;
    }
    const imported = collectCatalogPassSamples(keys, catalog, keys[0]);
    if (!imported.length) {
      message.error('所选检查项在服务类型里还没有样本图');
      return;
    }
    const room = HARD_RULE_PASS_SAMPLE_LIMIT - passSamples.length;
    if (room <= 0) {
      message.info('合格样已满，请先删再导入');
      return;
    }
    const existing = new Set(passSamples.map((item) => item.url));
    const added = imported.filter((url) => !existing.has(url)).slice(0, room);
    if (!added.length) {
      message.info('这些样本图已经在合格样里');
      return;
    }
    const next = [...passSamples, ...added.map((url) => ({ url, label: '' }))].slice(0, HARD_RULE_PASS_SAMPLE_LIMIT);
    message.success(`已从服务类型导入 ${added.length} 张合格样，正在起名`);
    void applyPassLabels(next);
  };

  const handleDraftFromSamples = async () => {
    const values = form.getFieldsValue();
    const selected = catalog.find((item) => item.key === values.entryKey);
    if (!passSamples.length && !failSampleUrls.length) {
      message.error('请先上传合格或不合格样张');
      return;
    }
    setDrafting(true);
    try {
      const drafted = await draftHardRule({
        name: values.name,
        title: selected?.entryName || values.name,
        description: selected?.description || '',
        passPhotoUrls: passSamples.map((item) => item.url),
        failPhotoUrls: failSampleUrls,
        failNote: String(values.failNote || '').trim(),
      });
      form.setFieldsValue({
        passCriteria: drafted.passCriteria,
        failCriteria: drafted.failCriteria,
      });
      setDraftFromAi(true);
      message.success(drafted.provider === 'mock' ? '已生成本地草稿，请改后再保存' : '已生成草稿，请改后再保存');
    } catch {
      /* interceptor */
    } finally {
      setDrafting(false);
    }
  };

  const handleSplitLegacy = () => {
    if (!editing?.promptText) return;
    const parsed = hydrateCriteriaFromPrompt(editing.promptText);
    form.setFieldsValue({
      passCriteria: parsed.passCriteria,
      failCriteria: parsed.failCriteria,
    });
    setDraftFromAi(false);
    message.success('已把旧正文拆进两栏，请核对后保存');
  };

  const handleTrialUpload = async (files: File[]) => {
    if (!files.length) return;
    const room = Math.max(0, HARD_RULE_TRIAL_PHOTO_LIMIT - trialUrls.length);
    if (!room) return;
    setTrialUploading(true);
    try {
      const urls: string[] = [];
      for (const file of files.slice(0, room)) {
        const res = await uploadImage(file, { siteName: '硬规则试跑', serialNumber: 'trial' });
        urls.push(res.url);
      }
      setTrialUrls((prev) => [...prev, ...urls].slice(0, HARD_RULE_TRIAL_PHOTO_LIMIT));
      setTrialResult(null);
      message.success(`已上传 ${urls.length} 张`);
    } catch {
      message.error('照片上传失败');
    } finally {
      setTrialUploading(false);
    }
  };

  const handleUseSamplesAsTrial = () => {
    const urls = [...passSamples.map((item) => item.url), ...failSampleUrls].slice(0, HARD_RULE_TRIAL_PHOTO_LIMIT);
    if (!urls.length) {
      message.error('请先上传对照样张');
      return;
    }
    setTrialUrls(urls);
    setTrialResult(null);
    message.success('已用对照样张作为试跑照片');
  };

  const handleTrial = async () => {
    const values = form.getFieldsValue();
    const selected = catalog.find((item) => item.key === values.entryKey);
    if (!selected) {
      message.error('请先选择检查项，再试跑');
      return;
    }
    if (!trialUrls.length) {
      message.error('请先上传 1～4 张照片');
      return;
    }
    if (!String(values.passCriteria || '').trim() && !String(values.failCriteria || '').trim()) {
      message.error('请先填写合格或不合格标准');
      return;
    }
    setTrialing(true);
    try {
      const result = await previewHardRule({
        title: selected.entryName,
        description: selected.description || '',
        photoUrls: trialUrls,
        name: values.name,
        passCriteria: values.passCriteria,
        failCriteria: values.failCriteria,
        enforceMode: values.enforceMode,
        passSampleViews: passSamples,
        failSampleUrls,
      });
      setTrialResult(result);
    } catch {
      /* interceptor */
    } finally {
      setTrialing(false);
    }
  };

  const columns: ColumnsType<HardRuleItem> = [
    {
      title: '检查项',
      width: 320,
      render: (_, row) => {
        const items = catalog.filter((item) => keysForRule(row, catalog).includes(item.key));
        if (!items.length) {
          return (
            <Typography.Text type="secondary" style={{ fontSize: 12 }}>
              {row.matchPattern || '未绑定'}
            </Typography.Text>
          );
        }
        return (
          <Space size={[4, 4]} wrap>
            {items.slice(0, 4).map((item) => (
              <Tag key={item.key}>{catalogLabel(item)}</Tag>
            ))}
            {items.length > 4 ? <Tag>+{items.length - 4}</Tag> : null}
          </Space>
        );
      },
    },
    {
      title: '对照样张',
      width: 130,
      render: (_, row) => {
        const pass = row.samples?.pass?.length || 0;
        const fail = row.samples?.fail?.length || 0;
        if (!pass && !fail) {
          return <Typography.Text type="secondary">无</Typography.Text>;
        }
        return `合格 ${pass} · 不合格 ${fail}`;
      },
    },
    {
      title: '近30天符合',
      width: 130,
      render: (_, row) => {
        const reviewed = row.reviewStats?.reviewed || 0;
        const agreed = row.reviewStats?.agreed || 0;
        if (!reviewed) {
          return <Typography.Text type="secondary">暂无人工确认</Typography.Text>;
        }
        const rate = Math.round((agreed / reviewed) * 100);
        return (
          <Typography.Text type={rate < 70 ? 'warning' : undefined}>
            {agreed}/{reviewed}（{rate}%）
          </Typography.Text>
        );
      },
    },
    {
      title: '状态',
      width: 80,
      render: (_, row) =>
        row.enabled && row.enforceMode !== 'off' ? (
          <Tag color="success">启用</Tag>
        ) : (
          <Tag>停用</Tag>
        ),
    },
    {
      title: '校验强度',
      dataIndex: 'enforceMode',
      width: 160,
      render: (v: string) => ENFORCE_MODE_LABEL[v] || v,
    },
    {
      title: '版本',
      dataIndex: 'version',
      width: 70,
      render: (v: number) => `v${v}`,
    },
    {
      title: '最近变更',
      dataIndex: 'changeNote',
      ellipsis: true,
      render: (v: string | null) => v || '—',
    },
    {
      title: '操作',
      width: 260,
      fixed: 'right',
      render: (_, row) => (
        <Space wrap>
          <Button type="link" icon={<EditOutlined />} onClick={() => openEdit(row)}>
            编辑
          </Button>
          {row.hasDefault ? (
            <Popconfirm
              title="恢复上次备份的判定说明？"
              description="将覆盖当前合格/不合格与匹配配置"
              onConfirm={() => void handleReset(row)}
            >
              <Button type="link" icon={<ReloadOutlined />}>
                恢复备份
              </Button>
            </Popconfirm>
          ) : null}
          <Popconfirm
            title="删除这条规则？"
            description="删除后新分析不再匹配该规则"
            onConfirm={() => void handleDelete(row)}
          >
            <Button type="link" danger icon={<DeleteOutlined />}>
              删除
            </Button>
          </Popconfirm>
        </Space>
      ),
    },
  ];

  const selectedEntry = catalog.find((item) => item.key === entryKeyWatch);
  const passLabelDup = (() => {
    const names = passSamples.map((item) => item.label.trim()).filter(Boolean);
    return names.length >= 2 && new Set(names).size < names.length;
  })();
  const legacyMultiBound = Boolean(
    editing && keysForRule(editing, catalog).length > 1,
  );

  return (
    <div>
      <Card
        title="AI 硬规则"
        extra={
          <Space>
            <Button type="primary" icon={<PlusOutlined />} onClick={openCreate}>
              新增规则
            </Button>
            <Button onClick={() => void load()} loading={loading}>
              刷新
            </Button>
          </Space>
        }
      >
        <Typography.Paragraph type="secondary" style={{ marginTop: 0 }}>
          按检查项配置：选哪一项，就管哪一项。合格样最多 4 张，每张底下有短名字；挂几种，现场就要对上几种。不合格样最多 2 张。服务类型里有几张示范，现场就必须拍几张。人工确认后统计近 30 天符合率。改规则只影响<strong>新发起的分析</strong>。
        </Typography.Paragraph>
        <Table
          rowKey="code"
          loading={loading}
          columns={columns}
          dataSource={list}
          pagination={false}
          scroll={{ x: 1180 }}
        />
      </Card>

      <Modal
        title={
          editorMode === 'create'
            ? '新增 AI 规则'
            : `编辑 · ${ruleTitleFromKeys(keysForRule(editing, catalog), catalog) || editing?.name || '规则'}`
        }
        open={editorOpen}
        onCancel={() => {
          setEditorOpen(false);
          setEditing(null);
          setEditorMode('create');
        }}
        onOk={() => void handleSave()}
        confirmLoading={saving}
        width={760}
        okText="保存"
        destroyOnHidden
      >
        <Form form={form} layout="vertical">
          {legacyMultiBound ? (
            <Alert
              type="info"
              showIcon
              style={{ marginBottom: 16 }}
              message="这条以前绑了多项。现在一项一条，保存后只保留你选的这一项。"
            />
          ) : null}
          <Form.Item
            name="entryKey"
            label="检查项"
            rules={[{ required: true, message: '请选择检查项' }]}
            extra="一项一条规则。安装固定和交流侧标准不同，不要写在同一条里。要增删条目去「服务类型」。"
          >
            <Select
              allowClear
              showSearch
              optionFilterProp="label"
              placeholder="选择某个服务类型下的检查项"
              options={catalog.map((item) => ({
                value: item.key,
                label: catalogLabel(item),
              }))}
            />
          </Form.Item>
          <Card
            size="small"
            title="对照样张"
            style={{ marginBottom: 16 }}
            extra={
              <Typography.Text type="secondary" style={{ fontSize: 12 }}>
                挂几张就对照几张，保存后现场验图会带上
              </Typography.Text>
            }
          >
            <Space direction="vertical" style={{ width: '100%' }} size={12}>
              <div>
                <Typography.Text>合格样张（最多 {HARD_RULE_PASS_SAMPLE_LIMIT} 张）</Typography.Text>
                <div>
                  <Typography.Text type="secondary" style={{ fontSize: 12 }}>
                    上传后系统会给每张起个短名字，不对可以改。挂几种，现场就要对上几种。
                  </Typography.Text>
                </div>
                <div style={{ marginTop: 8 }}>
                  <Space wrap>
                    <Upload
                      accept="image/*"
                      multiple
                      showUploadList={false}
                      disabled={sampleUploading !== null || sampleLabeling || passSamples.length >= HARD_RULE_PASS_SAMPLE_LIMIT}
                      beforeUpload={(file, fileList) => {
                        if (file !== fileList[fileList.length - 1]) return false;
                        const files = fileList.filter(
                          (f) => f instanceof File && (f.type?.startsWith('image/') || !f.type),
                        ) as File[];
                        void handleSampleUpload('pass', files);
                        return false;
                      }}
                    >
                      <Button icon={<PlusOutlined />} loading={sampleUploading === 'pass' || sampleLabeling} disabled={passSamples.length >= HARD_RULE_PASS_SAMPLE_LIMIT}>
                        上传合格样
                      </Button>
                    </Upload>
                    <Button
                      disabled={sampleLabeling || passSamples.length >= HARD_RULE_PASS_SAMPLE_LIMIT}
                      onClick={handleImportPassFromCatalog}
                    >
                      从服务类型导入
                    </Button>
                    {passSamples.length ? (
                      <Button type="link" loading={sampleLabeling} onClick={() => void applyPassLabels(passSamples)}>
                        重新起名
                      </Button>
                    ) : null}
                  </Space>
                  {passLabelDup ? (
                    <Alert
                      type="warning"
                      showIcon
                      style={{ marginTop: 8 }}
                      message="有两张合格样名字一样，请改成能区分的，否则对号时分不清。"
                    />
                  ) : null}
                  <PassSampleCards
                    items={passSamples}
                    labeling={sampleLabeling}
                    onClear={() => setPassSamples([])}
                    onRemove={(url) => setPassSamples((prev) => prev.filter((item) => item.url !== url))}
                    onLabelChange={(url, label) =>
                      setPassSamples((prev) =>
                        prev.map((item) => (item.url === url ? { ...item, label: sanitizeViewLabel(label) } : item)),
                      )
                    }
                  />
                </div>
              </div>
              <div>
                <Typography.Text>不合格样张（最多 {HARD_RULE_FAIL_SAMPLE_LIMIT} 张）</Typography.Text>
                <div>
                  <Typography.Text type="secondary" style={{ fontSize: 12 }}>
                    只挂典型错误，不必再拍一套角度
                  </Typography.Text>
                </div>
                <div style={{ marginTop: 8 }}>
                  <Upload
                    accept="image/*"
                    multiple
                    showUploadList={false}
                    disabled={sampleUploading !== null || failSampleUrls.length >= HARD_RULE_FAIL_SAMPLE_LIMIT}
                    beforeUpload={(file, fileList) => {
                      if (file !== fileList[fileList.length - 1]) return false;
                      const files = fileList.filter(
                        (f) => f instanceof File && (f.type?.startsWith('image/') || !f.type),
                      ) as File[];
                      void handleSampleUpload('fail', files);
                      return false;
                    }}
                  >
                    <Button icon={<PlusOutlined />} loading={sampleUploading === 'fail'} disabled={failSampleUrls.length >= HARD_RULE_FAIL_SAMPLE_LIMIT}>
                      上传不合格样
                    </Button>
                  </Upload>
                  <SampleThumbs
                    urls={failSampleUrls}
                    onClear={() => setFailSampleUrls([])}
                    onRemove={(url) => setFailSampleUrls((prev) => prev.filter((item) => item !== url))}
                  />
                </div>
              </div>
              <Form.Item
                name="failNote"
                label="不合格原因（选填，有助于写准）"
                style={{ marginBottom: 0 }}
              >
                <Input placeholder="例如：只拍到机箱，看不清抱箍和螺栓" />
              </Form.Item>
              <Button
                type="primary"
                ghost
                icon={<ThunderboltOutlined />}
                loading={drafting}
                onClick={() => void handleDraftFromSamples()}
              >
                生成合格/不合格草稿
              </Button>
            </Space>
          </Card>

          {draftFromAi ? (
            <Alert
              type="warning"
              showIcon
              style={{ marginBottom: 16 }}
              message="下面是 AI 草稿，请改完再保存。样张会随规则保存，现场验图会对照。"
            />
          ) : null}

          <Form.Item
            name="passCriteria"
            label="合格标准"
            rules={[
              ({ getFieldValue }) => ({
                validator() {
                  if (
                    String(getFieldValue('passCriteria') || '').trim() ||
                    String(getFieldValue('failCriteria') || '').trim()
                  ) {
                    return Promise.resolve();
                  }
                  return Promise.reject(new Error('请至少填写合格或不合格标准'));
                },
              }),
            ]}
            extra="用白话写：什么情况算合格"
          >
            <Input.TextArea rows={4} placeholder="例如：铭牌文字清晰可读，序列号完整无遮挡" />
          </Form.Item>
          <Form.Item
            name="failCriteria"
            label="不合格标准"
            extra="用白话写：什么情况必须判不合格。页签类检查请写清：只交一张、或一张图里只看见页签标题，都不算拍齐。"
          >
            <Input.TextArea
              rows={4}
              placeholder="例如：只交一张；两张都是同一页签；一张图里能看见两个页签标题但只点开了一页"
            />
          </Form.Item>
          {editing?.promptText && hydrateCriteriaFromPrompt(editing.promptText).source === 'legacy' ? (
            <Alert
              type="info"
              showIcon
              style={{ marginBottom: 16 }}
              message="已尽量从旧版正文拆进上面两栏。可再点一次重拆，或用样张重新生成。"
              action={
                <Button size="small" onClick={handleSplitLegacy}>
                  从旧正文再拆一次
                </Button>
              }
            />
          ) : null}

          <Space size="large" wrap>
            <Form.Item name="enabled" label="启用" valuePropName="checked">
              <Switch checkedChildren="开" unCheckedChildren="关" />
            </Form.Item>
            <Form.Item name="enforceMode" label="校验强度" rules={[{ required: true }]}>
              <Select
                style={{ width: 240 }}
                options={[
                  { value: 'strict', label: '严格（拿不准判不合格）' },
                  { value: 'normal', label: '标准' },
                  { value: 'off', label: '关闭（不套用）' },
                ]}
              />
            </Form.Item>
          </Space>

          <Form.Item name="changeNote" label="变更说明（选填）">
            <Input placeholder="例如：补充铭牌反光不合格" maxLength={500} />
          </Form.Item>

          <Collapse
            ghost
            items={[
              {
                key: 'preview',
                label: '将发给 AI 的说明（自动生成）',
                children: (
                  <Typography.Paragraph
                    style={{
                      whiteSpace: 'pre-wrap',
                      fontFamily: 'ui-monospace, monospace',
                      fontSize: 12,
                      marginBottom: 0,
                    }}
                  >
                    {generatedPrompt || '填写合格/不合格后在这里预览'}
                  </Typography.Paragraph>
                ),
              },
            ]}
          />

          <Card
            size="small"
            title="试跑"
            style={{ marginTop: 8 }}
            extra={
              <Typography.Text type="secondary" style={{ fontSize: 12 }}>
                用当前合格/不合格标准，并对照上面的样张
              </Typography.Text>
            }
          >
            <Typography.Paragraph type="secondary" style={{ marginBottom: 12 }}>
              {selectedEntry
                ? `按「${catalogLabel(selectedEntry)}」试跑`
                : '请先在上方选择检查项'}
              {passSamples.length >= 2
                ? `。上面挂了 ${passSamples.length} 种合格样，试跑也请拍齐 ${passSamples.length} 种不同的图；同一种拍两张会不合格。`
                : ''}
            </Typography.Paragraph>
            <Space direction="vertical" style={{ width: '100%' }} size={12}>
              <Upload
                accept="image/*"
                multiple
                showUploadList={false}
                disabled={trialUploading || trialUrls.length >= HARD_RULE_TRIAL_PHOTO_LIMIT}
                beforeUpload={(file, fileList) => {
                  if (file !== fileList[fileList.length - 1]) return false;
                  const files = fileList.filter(
                    (f) => f instanceof File && (f.type?.startsWith('image/') || !f.type),
                  ) as File[];
                  void handleTrialUpload(files);
                  return false;
                }}
              >
                <Button icon={<PlusOutlined />} loading={trialUploading} disabled={trialUrls.length >= HARD_RULE_TRIAL_PHOTO_LIMIT}>
                  上传照片（最多 {HARD_RULE_TRIAL_PHOTO_LIMIT} 张）
                </Button>
              </Upload>
              <SampleThumbs
                urls={trialUrls}
                size={72}
                onClear={() => {
                  resetTrial();
                }}
                onRemove={(url) => {
                  setTrialUrls((prev) => prev.filter((item) => item !== url));
                  setTrialResult(null);
                }}
              />
              <Space wrap>
                <Button
                  disabled={!passSamples.length && !failSampleUrls.length}
                  onClick={handleUseSamplesAsTrial}
                >
                  用上面的样张试跑
                </Button>
                <Button
                  type="primary"
                  ghost
                  icon={<ExperimentOutlined />}
                  loading={trialing}
                  onClick={() => void handleTrial()}
                >
                  开始试跑
                </Button>
              </Space>
              {trialResult ? (
                <Alert
                  type={
                    trialResult.status === 'pass'
                      ? 'success'
                      : trialResult.status === 'error'
                        ? 'error'
                        : 'warning'
                  }
                  showIcon
                  message={
                    trialResult.status === 'pass'
                      ? `合格 · 置信度 ${Math.round((trialResult.confidence || 0) * 100)}%`
                      : trialResult.status === 'error'
                        ? '试跑失败'
                        : `不合格 · 置信度 ${Math.round((trialResult.confidence || 0) * 100)}%`
                  }
                  description={trialResult.reason}
                />
              ) : null}
            </Space>
          </Card>
        </Form>
      </Modal>
    </div>
  );
}
