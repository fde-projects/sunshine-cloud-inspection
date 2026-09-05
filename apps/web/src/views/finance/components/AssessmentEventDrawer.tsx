"use client";

import { useEffect, useMemo, useState } from 'react';
import { Button, Drawer, Form, Input, InputNumber, Modal, Select, Table, Tag, message } from 'antd';
import {
  createAssessmentEvent,
  deleteAssessmentEvent,
  fetchAssessmentEventCatalog,
  fetchAssessmentEvents,
} from '../../../api/finance';
import type { AssessmentEventCatalogItem, AssessmentEventRow } from '../../../types/finance';
import { useMobileDrawer } from '../../../hooks/useDrawerWidth';

export type AssessmentEventAssignee = {
  id: string;
  realName: string;
};

export type AssessmentEventDrawerProps = {
  open: boolean;
  onClose: () => void;
  month: string;
  /** 单人场景直接传入；多人场景可留空，改用 assignees */
  userId?: string;
  userName?: string;
  /** 案例在派工程师列表；多人时必须先选扣罚对象 */
  assignees?: AssessmentEventAssignee[];
  /** 关联案例：本抽屉只登记/删除本案例事件 */
  serviceCaseId?: string;
  caseLabel?: string;
  onChanged?: () => void;
};

export default function AssessmentEventDrawer({
  open,
  onClose,
  month,
  userId,
  userName,
  assignees,
  serviceCaseId,
  caseLabel,
  onChanged,
}: AssessmentEventDrawerProps) {
  const caseMode = Boolean(serviceCaseId);
  const [catalog, setCatalog] = useState<AssessmentEventCatalogItem[]>([]);
  const [events, setEvents] = useState<AssessmentEventRow[]>([]);
  const [loading, setLoading] = useState(false);
  const [form] = Form.useForm();

  const people = useMemo(() => {
    if (assignees?.length) return assignees;
    if (userId) return [{ id: userId, realName: userName || userId }];
    return [];
  }, [assignees, userId, userName]);

  const multiPerson = people.length > 1;
  const drawerProps = useMobileDrawer(720);
  const selectedCatalogId = Form.useWatch('catalogId', form);
  const selectedCatalog = useMemo(
    () => catalog.find((item) => item.id === selectedCatalogId),
    [catalog, selectedCatalogId],
  );

  const reload = async () => {
    if (!serviceCaseId && !people[0]?.id) return;
    setLoading(true);
    try {
      setEvents(
        await fetchAssessmentEvents(
          month,
          caseMode ? undefined : people[0]?.id,
          serviceCaseId,
        ),
      );
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    if (!open) return;
    void fetchAssessmentEventCatalog().then(setCatalog).catch(() => setCatalog([]));
    form.resetFields();
    form.setFieldsValue({
      qty: 1,
      userId: multiPerson ? undefined : people[0]?.id,
    });
    void reload();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, month, serviceCaseId, people.map((p) => p.id).join(',')]);

  const submitEvent = async () => {
    const values = await form.validateFields();
    const targetUserId = String(values.userId || people[0]?.id || '');
    if (!targetUserId) {
      message.warning('请选择要扣罚的工程师');
      return;
    }
    try {
      await createAssessmentEvent({
        month,
        userId: targetUserId,
        catalogId: values.catalogId,
        qty: values.qty,
        amount: values.amount,
        remark: values.remark,
        ...(caseMode && serviceCaseId ? { serviceCaseId } : {}),
      });
      message.success(caseMode ? '本案例事件扣罚已登记' : '月度补录已登记');
      form.resetFields();
      form.setFieldsValue({
        qty: 1,
        userId: multiPerson ? undefined : people[0]?.id,
      });
      await reload();
      onChanged?.();
    } catch (error) {
      message.error(error instanceof Error ? error.message : '登记失败');
    }
  };

  const removeEvent = (row: AssessmentEventRow) => {
    if (!caseMode && row.serviceCaseId) {
      message.warning('案例关联的扣罚请到结算审核删除');
      return;
    }
    Modal.confirm({
      title: '删除该事件扣罚？',
      content: caseMode
        ? '删除后本案例与月度汇总会同步更新。'
        : '仅删除月度补录；案例关联记录不受影响。',
      onOk: async () => {
        await deleteAssessmentEvent(row.id, caseMode ? 'case' : 'monthly');
        await reload();
        onChanged?.();
        message.success('已删除');
      },
    });
  };

  const title = caseMode
    ? `本案例事件扣罚 · ${caseLabel || ''}`
    : `本月事件汇总 · ${userName || people[0]?.realName || ''}`;

  const tip = caseMode
    ? multiPerson
      ? `多人案例请先选择扣罚对象。归属月按案例完工日（当前按 ${month}）计入月结；此处只登记本案例，考核管理里会只读展示。`
      : `审单时登记本案例扣罚。归属月按案例完工日（当前按 ${month}）计入月结；考核管理可查看但不可在那边删除。`
    : `本月汇总（含结算审核已挂案例的扣罚 + 下方月度补录）。有案例请到结算审核登记；此处仅补录无案例的月度扣罚，避免两边重复计。`;

  return (
    <Drawer {...drawerProps} open={open} onClose={onClose} title={title}>
      <div style={{ marginBottom: 12, color: '#666' }}>{tip}</div>
      <Form form={form} layout="vertical" initialValues={{ qty: 1 }}>
        <Form.Item
          name="userId"
          label="扣罚对象"
          rules={[{ required: true, message: '请选择要扣罚的工程师' }]}
        >
          <Select
            placeholder={multiPerson ? '选择本次扣罚的工程师' : undefined}
            options={people.map((p) => ({
              value: p.id,
              label: p.realName || p.id,
            }))}
            disabled={!multiPerson && people.length === 1}
          />
        </Form.Item>
        <Form.Item name="catalogId" label="考核细则" rules={[{ required: true, message: '请选择细则' }]}>
          <Select
            showSearch
            optionFilterProp="label"
            options={catalog.map((item) => ({
              value: item.id,
              label: `${item.category}｜${item.content}（${item.unitAmount == null ? '自定义金额' : `${item.unitAmount}元/${item.unit}`}）`,
            }))}
          />
        </Form.Item>
        <Form.Item name="qty" label="次数/天数" rules={[{ required: true }]}>
          <InputNumber min={0.01} style={{ width: '100%' }} />
        </Form.Item>
        {selectedCatalog?.unitAmount == null && (
          <Form.Item name="amount" label="自定义扣罚金额" rules={[{ required: true, message: '请填写金额' }]}>
            <InputNumber min={0} style={{ width: '100%' }} />
          </Form.Item>
        )}
        <Form.Item name="remark" label="备注">
          <Input.TextArea rows={2} />
        </Form.Item>
        <Button type="primary" onClick={() => void submitEvent()}>
          {caseMode ? '登记本案例扣罚' : '登记月度补录'}
        </Button>
      </Form>
      <Table
        style={{ marginTop: 24 }}
        rowKey="id"
        size="small"
        loading={loading}
        dataSource={events}
        pagination={false}
        columns={[
          ...(caseMode || multiPerson
            ? [
                {
                  title: '工程师',
                  width: 100,
                  render: (_: unknown, row: AssessmentEventRow) =>
                    row.userName ||
                    people.find((p) => p.id === row.userId)?.realName ||
                    row.userId,
                },
              ]
            : []),
          { title: '类别', dataIndex: 'category', width: 120 },
          { title: '内容', dataIndex: 'content' },
          {
            title: '数量',
            width: 90,
            render: (_: unknown, row: AssessmentEventRow) => `${row.qty}${row.unit}`,
          },
          {
            title: '扣罚',
            dataIndex: 'amount',
            width: 90,
            render: (v: string) => `¥${Number(v).toFixed(2)}`,
          },
          ...(!caseMode
            ? [
                {
                  title: '来源',
                  width: 140,
                  render: (_: unknown, row: AssessmentEventRow) =>
                    row.serviceCaseId ? (
                      <Tag color="blue">案例 {row.gspCaseNo || '已关联'}</Tag>
                    ) : (
                      <Tag>月度补录</Tag>
                    ),
                },
              ]
            : []),
          {
            title: '操作',
            width: 100,
            render: (_: unknown, row: AssessmentEventRow) => {
              if (!caseMode && row.serviceCaseId) {
                return <span style={{ color: '#8c8c8c' }}>只读</span>;
              }
              return (
                <Button type="link" danger onClick={() => removeEvent(row)}>
                  删除
                </Button>
              );
            },
          },
        ]}
      />
    </Drawer>
  );
}
