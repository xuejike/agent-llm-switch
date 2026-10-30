// 模型发现、探测与筛选视图（主界面中栏「模型」区 / 替换 12.1 预留的占位插槽）
//
// 职责（本任务 12.4）：
// - 「获取模型清单」：调用 ipcClient.fetchModels；当 supportsListing=false 时回退为手动输入模型 id
// - 「探测可用性」：调用 ipcClient.probeModels，展示 availability / 延迟 / 错误，并回写候选模型探测状态
// - 模型筛选：available-only / all（对应 ProviderConfig.modelSelection，并据此过滤表格展示）
// - 勾选模型：rowSelection 的勾选集合即「已选分发集合」ProviderConfig.models
// - 以上对候选清单 / 已选集合 / 筛选策略的变更，均通过 onProviderChange 上抛，由上层经
//   ipcClient.saveAppState 持久化（本组件不直接持有 AppState，保持与 12.1 的编排约定一致）
//
// 一律使用 antd 现成组件、不自行手写：
// - 模型表格用 antd `Table`（`rowSelection` 勾选、`Tag` 语义色显示 available/unavailable/unknown、延迟列）
// - 动作用 `Button`（含 loading 态）；筛选用 `Segmented`
// - 手动输入回退用 `Select mode="tags"`（无列表 API 时录入模型 id）
//
// 布局参照 ui.pen 主界面画布的模型卡与表格。
//
// 安全约束：本组件只处理不含明文密钥的数据——fetchModels / probeModels 的入参 config 仅携带
// apiKeyRef（引用），其回传结果（ModelInfo[] / ModelProbeResult[]）由主进程保证不含明文；
// UI 侧不触碰明文密钥。

import { useCallback, useMemo, useState } from 'react';
import {
  App as AntApp,
  Button,
  Card,
  Empty,
  Flex,
  Segmented,
  Select,
  Space,
  Table,
  Tag,
  Tooltip,
  Typography,
} from 'antd';
import type { ColumnsType } from 'antd/es/table';
import {
  CloudDownloadOutlined,
  ExperimentOutlined,
  WarningOutlined,
} from '@ant-design/icons';
import type {
  ModelAvailability,
  ModelInfo,
  ModelProbeResult,
  ProviderConfig,
} from '@shared/types';
import { ipcClient } from '../ipc/client';
import { useTranslation, type TKey } from '../i18n';

const { Text, Paragraph } = Typography;

/** 分发筛选策略：与 ProviderConfig.modelSelection 对齐（缺省视为 "all"） */
type ModelSelection = NonNullable<ProviderConfig['modelSelection']>;

/** ModelDiscoveryPanel 组件属性 */
export interface ModelDiscoveryPanelProps {
  /** 当前选中的 Provider（配置真相） */
  provider: ProviderConfig;
  /**
   * 向上抛出对 Provider 的变更（candidateModels / models / modelSelection）。
   * 由上层合入 AppState 并经 ipcClient.saveAppState 持久化。
   */
  onProviderChange: (next: ProviderConfig) => void;
}

/** 可用性 → antd Tag 语义色与文案 i18n key 的映射（success=绿 / error=红 / default=灰） */
const AVAILABILITY_TAG: Record<ModelAvailability, { color: string; textKey: TKey }> = {
  available: { color: 'success', textKey: 'modelDiscovery.availabilityAvailable' },
  unavailable: { color: 'error', textKey: 'modelDiscovery.availabilityUnavailable' },
  unknown: { color: 'default', textKey: 'modelDiscovery.availabilityUnknown' },
};

/**
 * 中栏「模型」区：模型发现、探测与筛选。
 * 本组件为受控组件：候选清单与已选集合均来自 provider，交互经 onProviderChange 上抛。
 */
export function ModelDiscoveryPanel({
  provider,
  onProviderChange,
}: ModelDiscoveryPanelProps): React.JSX.Element {
  const { message } = AntApp.useApp();
  const { t } = useTranslation();

  // 「获取模型清单」/「探测可用性」的进行态（驱动按钮 loading 与禁用）
  const [fetching, setFetching] = useState<boolean>(false);
  const [probing, setProbing] = useState<boolean>(false);
  // 当前 provider 是否不支持列表 API（获取后得知）：true 时展示手动输入回退
  const [manualFallback, setManualFallback] = useState<boolean>(false);

  // 候选模型清单（未获取过时为空数组）
  const candidateModels = useMemo<ModelInfo[]>(
    () => provider.candidateModels ?? [],
    [provider.candidateModels],
  );
  // 当前筛选策略（缺省按 "all" 处理）
  const selection = useMemo<ModelSelection>(
    () => provider.modelSelection ?? 'all',
    [provider.modelSelection],
  );
  // 已选用于分发的模型 id 集合
  const selectedIds = useMemo<string[]>(() => provider.models ?? [], [provider.models]);

  // available-only 筛选下仅展示 available 的候选；all 展示全部
  const visibleModels = useMemo<ModelInfo[]>(() => {
    if (selection === 'available-only') {
      return candidateModels.filter((m) => m.availability === 'available');
    }
    return candidateModels;
  }, [candidateModels, selection]);

  // 「获取模型清单」：调用 fetchModels；supportsListing=false 时切换到手动输入回退
  const handleFetchModels = useCallback(async () => {
    setFetching(true);
    try {
      const result = await ipcClient.fetchModels(provider);
      if (!result.supportsListing) {
        // 该 provider 不支持列表 API：回退到手动输入模型 id
        setManualFallback(true);
        message.info(t('modelDiscovery.notSupported'));
        return;
      }
      setManualFallback(false);
      if (result.warning) {
        // 拉取部分失败（鉴权失败、端点不可达、格式非预期等）：提示但不阻断
        message.warning(result.warning);
      }
      // 合并拉取结果与既有候选：以新拉取为准，保留既有手动项中未被覆盖的条目
      const merged = mergeCandidates(candidateModels, result.models);
      // 已选集合收敛为仍存在于候选中的 id（移除已消失的模型）
      const nextSelected = selectedIds.filter((id) => merged.some((m) => m.id === id));
      onProviderChange({
        ...provider,
        candidateModels: merged,
        models: nextSelected,
      });
      message.success(t('modelDiscovery.fetched', { count: result.models.length }));
    } catch (err) {
      message.error(t('modelDiscovery.fetchFailed', { detail: toErrorMessage(err) }));
    } finally {
      setFetching(false);
    }
  }, [provider, candidateModels, selectedIds, onProviderChange, message, t]);

  // 「探测可用性」：对候选模型批量探测，并把结果回写到候选清单的探测字段
  const handleProbeModels = useCallback(async () => {
    const ids = candidateModels.map((m) => m.id);
    if (ids.length === 0) {
      message.info(t('modelDiscovery.probeEmpty'));
      return;
    }
    setProbing(true);
    try {
      const results = await ipcClient.probeModels(provider, ids);
      // 把探测结果按 modelId 合并回候选清单（availability / 延迟 / 错误 / 时间戳）
      const merged = applyProbeResults(candidateModels, results);
      onProviderChange({ ...provider, candidateModels: merged });
      const availableCount = results.filter((r) => r.availability === 'available').length;
      message.success(t('modelDiscovery.probeDone', { available: availableCount, total: results.length }));
    } catch (err) {
      message.error(t('modelDiscovery.probeFailed', { detail: toErrorMessage(err) }));
    } finally {
      setProbing(false);
    }
  }, [provider, candidateModels, onProviderChange, message, t]);

  // 手动输入模型 id（回退路径）：把用户录入的 id 归一化为 source="manual" 的候选
  const handleManualChange = useCallback(
    (ids: string[]) => {
      // 去重并保留既有候选的探测状态（同 id 复用，新 id 置 unknown）
      const uniqueIds = Array.from(new Set(ids.map((s) => s.trim()).filter(Boolean)));
      const next: ModelInfo[] = uniqueIds.map((id) => {
        const existing = candidateModels.find((m) => m.id === id);
        return (
          existing ?? {
            id,
            source: 'manual',
            availability: 'unknown',
          }
        );
      });
      // 已选集合收敛为仍存在的 id
      const nextSelected = selectedIds.filter((id) => next.some((m) => m.id === id));
      onProviderChange({ ...provider, candidateModels: next, models: nextSelected });
    },
    [provider, candidateModels, selectedIds, onProviderChange],
  );

  // 切换筛选策略：写回 modelSelection；切到 available-only 时同步收敛已选集合为 available 子集
  const handleSelectionChange = useCallback(
    (value: ModelSelection) => {
      if (value === 'available-only') {
        const availableIds = new Set(
          candidateModels.filter((m) => m.availability === 'available').map((m) => m.id),
        );
        const nextSelected = selectedIds.filter((id) => availableIds.has(id));
        onProviderChange({ ...provider, modelSelection: value, models: nextSelected });
      } else {
        onProviderChange({ ...provider, modelSelection: value });
      }
    },
    [provider, candidateModels, selectedIds, onProviderChange],
  );

  // 勾选变化：rowSelection 的选中集合即「已选分发集合」models
  const handleRowSelectionChange = useCallback(
    (keys: React.Key[]) => {
      const nextSelected = keys.map((k) => String(k));
      onProviderChange({ ...provider, models: nextSelected });
    },
    [provider, onProviderChange],
  );

  // 表格列定义：模型 id / 来源 / 可用性（Tag 语义色）/ 延迟
  const columns = useMemo<ColumnsType<ModelInfo>>(
    () => [
      {
        title: t('modelDiscovery.colId'),
        dataIndex: 'id',
        key: 'id',
        ellipsis: true,
        render: (id: string) => <Text strong>{id}</Text>,
      },
      {
        title: t('modelDiscovery.colSource'),
        dataIndex: 'source',
        key: 'source',
        width: 88,
        render: (source: ModelInfo['source']) => (
          <Tag bordered={false}>
            {source === 'fetched' ? t('modelDiscovery.sourceFetched') : t('modelDiscovery.sourceManual')}
          </Tag>
        ),
      },
      {
        title: t('modelDiscovery.colAvailability'),
        dataIndex: 'availability',
        key: 'availability',
        width: 128,
        render: (availability: ModelAvailability, record) => {
          const meta = AVAILABILITY_TAG[availability];
          const tag = <Tag color={meta.color}>{t(meta.textKey)}</Tag>;
          // 不可用/未知且带错误信息时，用 Tooltip 展示原因
          return record.error ? (
            <Tooltip title={record.error}>
              <Space size={4}>
                {tag}
                <WarningOutlined style={{ color: '#faad14' }} />
              </Space>
            </Tooltip>
          ) : (
            tag
          );
        },
      },
      {
        title: t('modelDiscovery.colLatency'),
        dataIndex: 'latencyMs',
        key: 'latencyMs',
        width: 96,
        render: (latencyMs?: number) =>
          typeof latencyMs === 'number' ? (
            <Text type="secondary">{latencyMs} ms</Text>
          ) : (
            <Text type="secondary">—</Text>
          ),
      },
    ],
    [t],
  );

  // 已选集合中落在当前筛选视图内的 key（用于 rowSelection 受控展示）
  const checkedKeys = useMemo<React.Key[]>(
    () => selectedIds.filter((id) => visibleModels.some((m) => m.id === id)),
    [selectedIds, visibleModels],
  );

  return (
    <Card
      size="small"
      title={t('modelDiscovery.cardTitle')}
      extra={
        <Space>
          {/* 筛选：available-only / all（对应 modelSelection） */}
          <Segmented<ModelSelection>
            size="small"
            value={selection}
            onChange={handleSelectionChange}
            options={[
              { label: t('modelDiscovery.filterAll'), value: 'all' },
              { label: t('modelDiscovery.filterAvailableOnly'), value: 'available-only' },
            ]}
          />
          {/* 获取模型清单（loading 态） */}
          <Button
            size="small"
            icon={<CloudDownloadOutlined />}
            loading={fetching}
            disabled={probing}
            onClick={() => void handleFetchModels()}
          >
            {t('modelDiscovery.fetchList')}
          </Button>
          {/* 探测可用性（loading 态） */}
          <Button
            size="small"
            type="primary"
            icon={<ExperimentOutlined />}
            loading={probing}
            disabled={fetching || candidateModels.length === 0}
            onClick={() => void handleProbeModels()}
          >
            {t('modelDiscovery.probe')}
          </Button>
        </Space>
      }
    >
      <Flex vertical gap={12}>
        {/* 手动输入回退：provider 不支持列表 API 时出现，录入模型 id */}
        {manualFallback ? (
          <Flex vertical gap={4}>
            <Text type="secondary" style={{ fontSize: 12 }}>
              {t('modelDiscovery.manualHint')}
            </Text>
            <Select
              mode="tags"
              style={{ width: '100%' }}
              placeholder={t('modelDiscovery.manualPlaceholder')}
              value={candidateModels.map((m) => m.id)}
              onChange={handleManualChange}
              tokenSeparators={[',', ' ']}
            />
          </Flex>
        ) : null}

        {/* 模型表格：勾选即「已选分发集合」，展示可用性 Tag 与延迟 */}
        {candidateModels.length === 0 ? (
          <Empty
            image={Empty.PRESENTED_IMAGE_SIMPLE}
            description={
              <Text type="secondary">{t('modelDiscovery.empty')}</Text>
            }
          />
        ) : (
          <Table<ModelInfo>
            size="small"
            rowKey="id"
            columns={columns}
            dataSource={visibleModels}
            pagination={false}
            scroll={{ y: 280 }}
            rowSelection={{
              selectedRowKeys: checkedKeys,
              onChange: handleRowSelectionChange,
              // 勾选集合即「已选分发集合」；筛选为仅可用时仅能勾选 available 项
              preserveSelectedRowKeys: true,
            }}
          />
        )}

        {/* 已选摘要：提示将分发的模型数量与当前筛选策略 */}
        <Paragraph type="secondary" style={{ margin: 0, fontSize: 12 }}>
          {t('modelDiscovery.selectedSummary', { count: selectedIds.length })}
          {selection === 'available-only'
            ? t('modelDiscovery.selectedSuffixAvailableOnly')
            : t('modelDiscovery.selectedSuffixAll')}
        </Paragraph>
      </Flex>
    </Card>
  );
}

/**
 * 合并既有候选与新拉取清单：以新拉取为主，保留既有同 id 条目的探测状态（availability/延迟等）。
 * 新拉取中不存在的旧手动项不保留（获取清单意味着以远端清单为准）。
 */
function mergeCandidates(existing: ModelInfo[], fetched: ModelInfo[]): ModelInfo[] {
  return fetched.map((f) => {
    const prev = existing.find((e) => e.id === f.id);
    if (!prev) {
      return f;
    }
    // 同 id：沿用既有探测状态（避免获取清单后丢失上一轮探测结论），但来源更新为 fetched
    return {
      ...f,
      availability: prev.availability,
      latencyMs: prev.latencyMs,
      error: prev.error,
      probedAt: prev.probedAt,
    };
  });
}

/**
 * 把探测结果按 modelId 合并回候选清单，更新 availability / 延迟 / 错误 / 探测时间。
 * 未在结果中出现的候选项保持原状。
 */
function applyProbeResults(
  candidates: ModelInfo[],
  results: ModelProbeResult[],
): ModelInfo[] {
  const byId = new Map<string, ModelProbeResult>(results.map((r) => [r.modelId, r]));
  return candidates.map((m) => {
    const r = byId.get(m.id);
    if (!r) {
      return m;
    }
    return {
      ...m,
      availability: r.availability,
      latencyMs: r.latencyMs,
      error: r.error,
      probedAt: r.probedAt,
    };
  });
}

/** 把未知错误安全地转为可展示的字符串 */
function toErrorMessage(err: unknown): string {
  if (err instanceof Error) {
    return err.message;
  }
  return String(err);
}
