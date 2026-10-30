// Agent 分发面板（主界面右栏 / antd Layout.Sider 内容）
//
// 职责：作为「目标 Agent 启用开关 + 安装/探测状态 + 分发摘要」的宿主区域。
// 本次（12.5 最小接入）在右栏内落地「启用 agent 勾选」最小实现，向上层提供
// 启用的 agentIds，供顶部栏的「预览 / 一键分发」入口作为分发目标集合：
//   · 经 ipcClient.listAgents 拉取可管理的 agent 列表
//   · 经 ipcClient.detectAgents 探测各 agent 的安装/配置文件状态（展示 Badge）
//   · 每个 agent 一个 Switch 启用开关，勾选集合经 onEnabledChange 上报给 App
// —— 预览/分发的触发按钮在顶部栏（App 的 Layout.Header），此处只负责「选谁」。
//
// 一律使用 antd 现成组件：列表用 antd `List`，启用开关用 `Switch`，安装/探测状态用 `Badge`，
// 加载态用 `Spin`，图标取 `@ant-design/icons`。布局参照 ui.pen 主界面画布右栏
// （RightHeader + AgentItems + DistSummary）。
//
// 安全约束：本组件只处理 agent 的启用态与安装探测结果（不含任何明文密钥）。

import { useCallback, useEffect, useMemo, useState } from 'react';
import { App as AntApp, Badge, List, Spin, Switch, Tooltip, Typography } from 'antd';
import { ipcClient } from '../ipc/client';
import type { DetectResult } from '@shared/types';
import { useTranslation, type TKey } from '../i18n';

const { Text } = Typography;

/** 可管理 agent 的元信息（来自 ipcClient.listAgents） */
interface AgentMeta {
  /** agent 唯一标识 */
  id: string;
  /** 展示名 */
  displayName: string;
}

/** AgentPanel 组件属性 */
export interface AgentPanelProps {
  /**
   * 启用集合变化回调：把当前勾选启用的 agentId 列表上报给上层（App），
   * 供顶部栏「预览 / 一键分发」作为分发目标集合（preview/distribute 的 agentIds）。
   */
  onEnabledChange?: (enabledAgentIds: string[]) => void;
}

/**
 * 右栏 Agent 分发面板：列出可管理 agent，提供启用勾选与安装/探测状态展示，
 * 并把启用集合上报给上层以驱动预览/分发。
 */
export function AgentPanel({ onEnabledChange }: AgentPanelProps): React.JSX.Element {
  const { message } = AntApp.useApp();
  const { t } = useTranslation();

  // 可管理的 agent 列表（来自主进程注册表）
  const [agents, setAgents] = useState<AgentMeta[]>([]);
  // 各 agent 的探测结果（安装/配置文件存在性），键为 agentId
  const [detectMap, setDetectMap] = useState<Record<string, DetectResult>>({});
  // 启用集合（勾选参与分发的 agentId）
  const [enabledIds, setEnabledIds] = useState<Set<string>>(new Set());
  // 列表加载态：仅覆盖 listAgents（很快）；列表就绪即关闭，让列表先显示
  const [loading, setLoading] = useState<boolean>(true);
  // 探测进行态：detect 可能较慢（个别 CLI 版本命令达十余秒），独立展示「探测中」而不阻塞列表
  const [probing, setProbing] = useState<boolean>(false);

  // 启动时拉取 agent 列表并探测其安装/配置状态
  useEffect(() => {
    let cancelled = false;
    void (async () => {
      let ids: string[] = [];
      // 1. 先拉列表：很快，列表就绪即关闭 loading 让其先显示（探测随后独立进行）
      try {
        const list = await ipcClient.listAgents();
        if (cancelled) {
          return;
        }
        setAgents(list);
        ids = list.map((a) => a.id);
      } catch (err) {
        if (!cancelled) {
          message.error(t('agentPanel.listFailed', { detail: toErrorMessage(err) }));
        }
        return;
      } finally {
        if (!cancelled) {
          setLoading(false);
        }
      }

      // 2. 再探测安装/版本/配置状态：可能较慢（个别 CLI 版本命令达十余秒），
      //    用 probing 态独立展示而不阻塞列表显示
      if (ids.length === 0) {
        return;
      }
      setProbing(true);
      try {
        const results = await ipcClient.detectAgents(ids);
        if (!cancelled) {
          const map: Record<string, DetectResult> = {};
          ids.forEach((id, i) => {
            const r = results[i];
            if (r) {
              map[id] = r;
            }
          });
          setDetectMap(map);
        }
      } catch (err) {
        if (!cancelled) {
          message.warning(t('agentPanel.detectFailed', { detail: toErrorMessage(err) }));
        }
      } finally {
        if (!cancelled) {
          setProbing(false);
        }
      }
    })();
    return () => {
      cancelled = true;
    };
    // 仅在挂载时拉取一次 agent 列表与探测；t 变化（切换语言）无需重拉，故不纳入依赖
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [message]);

  // 切换某个 agent 的启用态，并把最新启用集合上报给上层
  const handleToggle = useCallback(
    (agentId: string, enabled: boolean) => {
      setEnabledIds((prev) => {
        const next = new Set(prev);
        if (enabled) {
          next.add(agentId);
        } else {
          next.delete(agentId);
        }
        // 上报：保持与 agents 列表一致的稳定顺序
        onEnabledChange?.(Array.from(next));
        return next;
      });
    },
    [onEnabledChange],
  );

  // 启用计数（供头部摘要展示）
  const enabledCount = useMemo(() => enabledIds.size, [enabledIds]);

  return (
    <div style={{ display: 'flex', flexDirection: 'column', height: '100%' }}>
      {/* 右栏头部：分区标题 + 启用计数 */}
      <div
        style={{
          padding: '12px 16px',
          borderBottom: '1px solid #f0f0f0',
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'space-between',
        }}
      >
        <Text type="secondary" style={{ fontSize: 11, letterSpacing: 1 }}>
          {t('agentPanel.sectionTitle')}
        </Text>
        <Text type="secondary" style={{ fontSize: 12, display: 'flex', alignItems: 'center', gap: 6 }}>
          {/* 探测进行中时显示小 Spin，提示安装/版本状态仍在加载（探测可能较慢） */}
          {probing ? <Spin size="small" /> : null}
          {t('agentPanel.enabledCount', { enabled: enabledCount, total: agents.length })}
        </Text>
      </div>

      {/* Agent 列表：每项为启用开关 + 名称 + 安装/配置状态 Badge */}
      <div style={{ flex: 1, overflowY: 'auto', padding: 16 }}>
        {loading ? (
          <Spin tip={t('agentPanel.loading')}>
            <div style={{ padding: 32 }} />
          </Spin>
        ) : (
          <List
            size="small"
            dataSource={agents}
            locale={{ emptyText: t('agentPanel.empty') }}
            renderItem={(agent) => {
              const detect = detectMap[agent.id];
              const status = getAgentStatusView(detect);
              return (
                <List.Item
                  actions={[
                    <Switch
                      key="enable"
                      size="small"
                      checked={enabledIds.has(agent.id)}
                      onChange={(checked) => handleToggle(agent.id, checked)}
                    />,
                  ]}
                >
                  <List.Item.Meta
                    title={
                      <Tooltip title={detect?.configPath ?? t('agentPanel.configPathUnknown')}>
                        <Badge status={status.level} text={agent.displayName} />
                      </Tooltip>
                    }
                    description={
                      <Text type="secondary">
                        {t(status.textKey, { version: status.version })}
                      </Text>
                    }
                  />
                </List.Item>
              );
            }}
          />
        )}
      </div>
    </div>
  );
}

/** 探测状态 → Badge 语义级别 */
type BadgeLevel = 'success' | 'warning' | 'error' | 'default';

/** 由探测结果归一化出 Badge 语义色与文案 i18n key（含版本插值变量） */
function getAgentStatusView(detect?: DetectResult): {
  level: BadgeLevel;
  textKey: TKey;
  version: string;
} {
  if (!detect) {
    // 尚未探测或探测失败
    return { level: 'default', textKey: 'agentPanel.statusUnknown', version: '' };
  }
  if (!detect.installed) {
    // 未安装：分发时会被跳过
    return { level: 'default', textKey: 'agentPanel.statusNotInstalled', version: '' };
  }
  // 已安装：若探测到版本则在文案里带上（如「 v1.19.0」）
  const version = detect.version ? ` v${detect.version}` : '';
  if (detect.fileExists) {
    // 已安装且已有配置文件：将做字段级合并
    return { level: 'success', textKey: 'agentPanel.statusInstalledHasConfig', version };
  }
  // 已安装但尚无配置文件：将创建新配置
  return { level: 'warning', textKey: 'agentPanel.statusInstalledWillCreate', version };
}

/** 把未知错误安全地转为可展示的字符串 */
function toErrorMessage(err: unknown): string {
  if (err instanceof Error) {
    return err.message;
  }
  return String(err);
}
