// 分发报告弹窗（Distribution Report Modal）
//
// 职责：调用 ipcClient.distribute 对「启用的 agent 集合」执行分发（写盘），并展示返回的
// ApplyReport —— 整体结论、成功/失败/跳过计数、每个 agent 的明细（状态、备份路径、原因）。
//
// 一律使用 antd 现成组件、不自行手写：
//   · 弹窗用 antd `Modal`
//   · 整体结论用 `Result`；计数用 `Statistic`；状态用 `Tag`（语义色）
//   · 每个 agent 明细用 `List`，展示备份路径 / 跳过或失败原因
//   · 加载态用 `Spin`，失败提示用 `Alert`
// 布局参照 ui.pen 的分发报告弹窗画布（RHead + SummaryCounts + ReportList + RFoot）。
//
// 安全约束：ApplyReport 由主进程生成，不含明文密钥；本组件只做展示。

import { useCallback, useEffect, useState } from 'react';
import {
  Alert,
  App as AntApp,
  Button,
  List,
  Modal,
  Result,
  Space,
  Spin,
  Statistic,
  Tag,
  Typography,
} from 'antd';
import {
  CheckCircleOutlined,
  CloseCircleOutlined,
  MinusCircleOutlined,
} from '@ant-design/icons';
import type { ApplyEntry, ApplyReport, ProviderConfig } from '@shared/types';
import { ipcClient } from '../ipc/client';
import { useTranslation, type TKey } from '../i18n';

const { Text } = Typography;

/** DistributeReportModal 组件属性 */
export interface DistributeReportModalProps {
  /** 是否打开弹窗 */
  open: boolean;
  /** 当前要分发的 Provider 配置（含 apiKeyRef，不含明文） */
  provider?: ProviderConfig;
  /** 启用的目标 agentId 集合（来自右栏启用勾选） */
  agentIds: string[];
  /** 关闭弹窗回调 */
  onClose: () => void;
}

/** 分发状态 → antd Tag 颜色 */
const STATUS_TAG_COLOR: Record<ApplyEntry['status'], string> = {
  success: 'success',
  failed: 'error',
  skipped: 'default',
};

/** 分发状态 → 文案 i18n key（由组件用 t() 翻译） */
const STATUS_TEXT_KEY: Record<ApplyEntry['status'], TKey> = {
  success: 'report.statusSuccess',
  failed: 'report.statusFailed',
  skipped: 'report.statusSkipped',
};

/**
 * 分发报告弹窗：打开时执行 distribute，展示 ApplyReport。
 */
export function DistributeReportModal({
  open,
  provider,
  agentIds,
  onClose,
}: DistributeReportModalProps): React.JSX.Element {
  const { message } = AntApp.useApp();
  const { t } = useTranslation();

  // 分发报告（distribute 的返回）
  const [report, setReport] = useState<ApplyReport | null>(null);
  // 加载态：执行 distribute 期间展示 Spin
  const [loading, setLoading] = useState<boolean>(false);
  // 分发过程中的致命错误（整体失败，非单 agent 失败）
  const [fatalError, setFatalError] = useState<string>('');

  // 执行分发：供打开时自动触发，也供「重试」手动触发
  const runDistribute = useCallback(async () => {
    if (!provider) {
      return;
    }
    setLoading(true);
    setFatalError('');
    try {
      const rep = await ipcClient.distribute(provider, agentIds);
      setReport(rep);
    } catch (err) {
      setReport(null);
      setFatalError(toErrorMessage(err));
      message.error(t('report.distributeFailed', { detail: toErrorMessage(err) }));
    } finally {
      setLoading(false);
    }
  }, [provider, agentIds, message, t]);

  // 弹窗打开时触发分发；关闭时清空状态
  useEffect(() => {
    if (!open) {
      setReport(null);
      setFatalError('');
      return;
    }
    void runDistribute();
  }, [open, runDistribute]);

  // 整体结论：全部成功=success；有失败=error；否则（仅成功+跳过）=info
  const resultStatus: 'success' | 'error' | 'info' = (() => {
    if (!report) {
      return 'info';
    }
    if (report.summary.failed > 0) {
      return 'error';
    }
    return 'success';
  })();

  return (
    <Modal
      open={open}
      onCancel={onClose}
      width={720}
      title={t('report.title')}
      footer={[
        report && report.summary.failed > 0 ? (
          <Button key="retry" onClick={runDistribute} loading={loading}>
            {t('report.retryFailed', { count: report.summary.failed })}
          </Button>
        ) : null,
        <Button key="done" type="primary" onClick={onClose}>
          {t('report.done')}
        </Button>,
      ]}
    >
      {loading ? (
        <Spin tip={t('report.distributing')}>
          <div style={{ padding: 48 }} />
        </Spin>
      ) : fatalError ? (
        <Alert type="error" showIcon message={t('report.fatalTitle')} description={fatalError} />
      ) : report ? (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
          {/* 整体结论 + 计数摘要 */}
          <Result
            status={resultStatus}
            title={resultStatus === 'error' ? t('report.resultTitlePartial') : t('report.resultTitle')}
            subTitle={`${formatTimestamp(report.timestamp)}`}
            style={{ padding: '12px 0' }}
          />

          {/* 成功 / 失败 / 跳过 计数 */}
          <Space size={48} style={{ justifyContent: 'center', width: '100%' }}>
            <Statistic
              title={t('report.statSuccess')}
              value={report.summary.success}
              valueStyle={{ color: '#389e0d' }}
            />
            <Statistic
              title={t('report.statFailed')}
              value={report.summary.failed}
              valueStyle={{ color: '#cf1322' }}
            />
            <Statistic
              title={t('report.statSkipped')}
              value={report.summary.skipped}
              valueStyle={{ color: 'rgba(0,0,0,0.45)' }}
            />
          </Space>

          {/* 每个 agent 的分发明细 */}
          <List
            size="small"
            dataSource={report.entries}
            locale={{ emptyText: t('report.emptyEntries') }}
            renderItem={(entry) => <ReportEntryItem entry={entry} />}
          />
        </div>
      ) : (
        <Alert type="info" showIcon message={t('report.noReport')} />
      )}
    </Modal>
  );
}

/** 单条 agent 分发结果的列表项 */
function ReportEntryItem({ entry }: { entry: ApplyEntry }): React.JSX.Element {
  const { t } = useTranslation();
  const icon = STATUS_ICON[entry.status];
  return (
    <List.Item>
      <List.Item.Meta
        avatar={icon}
        title={
          <Space>
            <Text strong>{entry.agentId}</Text>
            <Tag color={STATUS_TAG_COLOR[entry.status]}>{t(STATUS_TEXT_KEY[entry.status])}</Tag>
          </Space>
        }
        description={
          <Space direction="vertical" size={2}>
            {/* 跳过原因 / 失败错误信息 */}
            {entry.message ? <Text type="secondary">{entry.message}</Text> : null}
            {/* 成功写入时的备份路径（供回溯/手动回滚） */}
            {entry.backupPath ? (
              <Text type="secondary" code style={{ fontSize: 12 }}>
                {t('report.backup', { path: entry.backupPath })}
              </Text>
            ) : null}
          </Space>
        }
      />
    </List.Item>
  );
}

/** 分发状态 → 状态图标（语义色） */
const STATUS_ICON: Record<ApplyEntry['status'], React.JSX.Element> = {
  success: <CheckCircleOutlined style={{ color: '#52c41a', fontSize: 18 }} />,
  failed: <CloseCircleOutlined style={{ color: '#ff4d4f', fontSize: 18 }} />,
  skipped: <MinusCircleOutlined style={{ color: 'rgba(0,0,0,0.25)', fontSize: 18 }} />,
};

/** 把 ISO 时间戳格式化为本地可读字符串（失败时原样返回） */
function formatTimestamp(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) {
    return iso;
  }
  return d.toLocaleString();
}

/** 把未知错误安全地转为可展示的字符串 */
function toErrorMessage(err: unknown): string {
  if (err instanceof Error) {
    return err.message;
  }
  return String(err);
}
