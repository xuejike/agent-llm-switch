// 分发预览 Diff 弹窗（Preview Diff Modal）
//
// 职责：调用 ipcClient.preview 对「启用的 agent 集合」生成合并预览，并以等宽文本容器
// 展示各 agent 的 maskedDiff（API Key 已掩码 / 采用 env/secrets 引用时只显示引用占位，
// 明文绝不出现在 UI）。用户在此审阅变更，可确认后触发分发。
//
// 一律使用 antd 现成组件、不自行手写：
//   · 弹窗用 antd `Modal`
//   · 多 agent 切换用 `Tabs`（每个启用 agent 一个页签，显示配置路径）
//   · Diff 用等宽文本容器（`<pre>` + `Typography.Text`），按行首 +/- 用语义色标注增删
//   · 加载态用 `Spin`，未安装/空结果用 `Empty`/`Alert`
// 布局参照 ui.pen 的 Preview Diff 弹窗画布（MHead + AgentTabs + DiffBody + MFoot）。
//
// 安全约束：本组件只展示 IPC 回传的 maskedDiff（不含明文）；不接触任何明文密钥。

import { useEffect, useMemo, useState } from 'react';
import { Alert, App as AntApp, Button, Empty, Modal, Spin, Tabs, Tag, Typography } from 'antd';
import { EyeOutlined, SendOutlined } from '@ant-design/icons';
import type { PreviewResult, ProviderConfig } from '@shared/types';
import { ipcClient } from '../ipc/client';
import { useTranslation } from '../i18n';

const { Text } = Typography;

/** PreviewDiffModal 组件属性 */
export interface PreviewDiffModalProps {
  /** 是否打开弹窗 */
  open: boolean;
  /** 当前要预览分发的 Provider 配置（含 apiKeyRef，不含明文） */
  provider?: ProviderConfig;
  /** 启用的目标 agentId 集合（来自右栏启用勾选） */
  agentIds: string[];
  /** 关闭弹窗回调 */
  onClose: () => void;
  /**
   * 「确认并分发」回调：由上层打开分发报告弹窗（执行 distribute）。
   * 预览弹窗本身不写盘，仅做只读预览。
   */
  onConfirmDistribute?: () => void;
}

/**
 * 分发预览 Diff 弹窗：按启用 agent 切换展示掩码后的合并差异。
 */
export function PreviewDiffModal({
  open,
  provider,
  agentIds,
  onClose,
  onConfirmDistribute,
}: PreviewDiffModalProps): React.JSX.Element {
  const { message } = AntApp.useApp();
  const { t } = useTranslation();

  // 预览结果（每个启用 agent 一条）
  const [results, setResults] = useState<PreviewResult[]>([]);
  // 加载态：调用 preview 期间展示 Spin
  const [loading, setLoading] = useState<boolean>(false);
  // 当前选中的 agent 页签
  const [activeKey, setActiveKey] = useState<string>('');

  // 弹窗打开时触发预览；关闭时清空结果，避免残留旧数据
  useEffect(() => {
    if (!open) {
      setResults([]);
      setActiveKey('');
      return;
    }
    if (!provider) {
      return;
    }
    let cancelled = false;
    setLoading(true);
    void (async () => {
      try {
        const res = await ipcClient.preview(provider, agentIds);
        if (!cancelled) {
          setResults(res);
          // 默认选中第一个 agent 页签
          setActiveKey(res[0]?.agentId ?? '');
        }
      } catch (err) {
        if (!cancelled) {
          message.error(t('preview.genFailed', { detail: toErrorMessage(err) }));
        }
      } finally {
        if (!cancelled) {
          setLoading(false);
        }
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [open, provider, agentIds, message, t]);

  // 由预览结果构造 Tabs 的 items（每个启用 agent 一个页签）
  const tabItems = useMemo(
    () =>
      results.map((r) => ({
        key: r.agentId,
        label: r.agentId,
        children: <PreviewDiffPane result={r} />,
      })),
    [results],
  );

  // 是否存在可分发目标（有启用 agent 且已生成预览）
  const hasTargets = agentIds.length > 0;

  return (
    <Modal
      open={open}
      onCancel={onClose}
      width={760}
      title={
        <span>
          <EyeOutlined style={{ marginRight: 8 }} />
          {t('preview.title')}
          <Text type="secondary" style={{ fontSize: 12, marginLeft: 8, fontWeight: 'normal' }}>
            {t('preview.subtitle')}
          </Text>
        </span>
      }
      footer={[
        <Button key="cancel" onClick={onClose}>
          {t('preview.cancel')}
        </Button>,
        <Button
          key="confirm"
          type="primary"
          icon={<SendOutlined />}
          disabled={!hasTargets || results.length === 0}
          onClick={() => {
            onClose();
            onConfirmDistribute?.();
          }}
        >
          {t('preview.confirm')}
        </Button>,
      ]}
    >
      {!hasTargets ? (
        <Alert
          type="info"
          showIcon
          message={t('preview.noTargetTitle')}
          description={t('preview.noTargetDesc')}
        />
      ) : loading ? (
        <Spin tip={t('preview.generating')}>
          <div style={{ padding: 48 }} />
        </Spin>
      ) : results.length === 0 ? (
        <Empty description={t('preview.empty')} />
      ) : (
        <Tabs activeKey={activeKey} onChange={setActiveKey} items={tabItems} />
      )}
    </Modal>
  );
}

/**
 * 单个 agent 的预览面板：配置路径 + 安装状态 + 掩码 Diff 容器。
 */
function PreviewDiffPane({ result }: { result: PreviewResult }): React.JSX.Element {
  const { t } = useTranslation();
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
      {/* 配置路径 + 安装状态标签 */}
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
        <Tag color={result.installed ? 'green' : 'default'}>
          {result.installed ? t('preview.installed') : t('preview.notInstalled')}
        </Tag>
        <Text type="secondary" code style={{ fontSize: 12 }}>
          {result.configPath}
        </Text>
      </div>

      {/* 掩码 Diff：等宽文本容器，按行首 +/- 用语义色标注增删 */}
      <MaskedDiffView diff={result.maskedDiff} />
    </div>
  );
}

/** diff 单行的语义类别 */
type DiffLineKind = 'add' | 'remove' | 'context';

/** diff 行的颜色与背景（antd 语义色系） */
const DIFF_LINE_STYLE: Record<DiffLineKind, { color: string; background: string }> = {
  add: { color: '#389e0d', background: '#f6ffed' },
  remove: { color: '#cf1322', background: '#fff1f0' },
  context: { color: 'rgba(0,0,0,0.65)', background: 'transparent' },
};

/**
 * 掩码 Diff 展示容器：用 `<pre>` 等宽容器逐行渲染 maskedDiff，
 * 行首 `+`/`-` 分别标注新增/删除行并着色，其余为上下文行。
 */
function MaskedDiffView({ diff }: { diff: string }): React.JSX.Element {
  // 按行拆分；保留空行以忠实呈现差异结构
  const lines = diff.length > 0 ? diff.split('\n') : [];
  return (
    <pre
      style={{
        margin: 0,
        padding: 12,
        maxHeight: 420,
        overflow: 'auto',
        background: '#fafafa',
        border: '1px solid #f0f0f0',
        borderRadius: 6,
        fontFamily:
          "'SFMono-Regular', Consolas, 'Liberation Mono', Menlo, Courier, monospace",
        fontSize: 12,
        lineHeight: 1.6,
      }}
    >
      {lines.map((line, idx) => {
        const kind = classifyDiffLine(line);
        const style = DIFF_LINE_STYLE[kind];
        return (
          <div
            key={idx}
            style={{
              color: style.color,
              background: style.background,
              whiteSpace: 'pre-wrap',
              wordBreak: 'break-all',
            }}
          >
            {line.length > 0 ? line : '\u00a0'}
          </div>
        );
      })}
    </pre>
  );
}

/** 依据行首字符判定 diff 行类别（忽略统一 diff 的 @@/+++/--- 头，视为上下文） */
function classifyDiffLine(line: string): DiffLineKind {
  // 统一 diff 的文件头/块头不作为增删行着色
  if (line.startsWith('+++') || line.startsWith('---') || line.startsWith('@@')) {
    return 'context';
  }
  if (line.startsWith('+')) {
    return 'add';
  }
  if (line.startsWith('-')) {
    return 'remove';
  }
  return 'context';
}

/** 把未知错误安全地转为可展示的字符串 */
function toErrorMessage(err: unknown): string {
  if (err instanceof Error) {
    return err.message;
  }
  return String(err);
}
