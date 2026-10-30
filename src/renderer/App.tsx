// 应用根组件：确立主界面整体三栏布局骨架（Header + 左/中/右三栏）
//
// 职责（本任务 12.1）：
// - 用 antd `Layout`（`Header` + `Sider` 左 + `Content` 中 + `Sider` 右）搭建主界面三栏骨架
// - 左栏 Provider 列表（ProviderList）、中栏详情容器（ProviderDetail）、右栏分发面板占位（AgentPanel）
// - 经渲染进程 IPC 客户端（ipcClient）加载/保存 AppState：启动时 loadAppState，选中项变化时保存
// - 顶部栏放置「Preview / Distribute」主操作按钮占位（逻辑待 12.5 接入）
// - 为 12.3 的「Add Provider」弹窗预留触发入口（本任务仅弹出提示占位）
//
// 一律使用 antd 现成组件；全局消息用 antd `App.useApp()` 的 message（在 ConfigProvider 下生效）。
// 布局参照 ui.pen 主界面画布（TopBar + ProviderList + ProviderDetail + AgentPanel）。
//
// 安全约束：本组件只处理 AppState（不含明文密钥）与选中态；密钥输入在 12.2，明文绝不进入 React 状态。

import { useCallback, useEffect, useMemo, useState } from 'react';
import { App as AntApp, Button, Layout, Segmented, Space, Spin, Typography } from 'antd';
import { EyeOutlined, SendOutlined, GlobalOutlined } from '@ant-design/icons';
import type { AppState, ProviderConfig } from '@shared/types';
import { ipcClient } from './ipc/client';
import { useTranslation, type LocaleCode } from './i18n';
import { ProviderList } from './components/ProviderList';
import { ProviderDetail } from './components/ProviderDetail';
import { AgentPanel } from './components/AgentPanel';
import { AddProviderModal } from './components/AddProviderModal';
import { PreviewDiffModal } from './components/PreviewDiffModal';
import { DistributeReportModal } from './components/DistributeReportModal';

const { Header, Sider, Content } = Layout;
const { Title, Text } = Typography;

/** 空的初始 AppState：loadAppState 之前的占位，避免渲染空引用 */
const EMPTY_APP_STATE: AppState = { providers: [], agents: [] };

export function App(): React.JSX.Element {
  // 全局消息实例（在 ConfigProvider 作用域内生效）
  const { message } = AntApp.useApp();
  const { t } = useTranslation();

  // 应用全局状态（不含明文密钥），来源于主进程 ConfigStore
  const [appState, setAppState] = useState<AppState>(EMPTY_APP_STATE);
  // 首次加载态：加载 AppState 期间展示 Spin
  const [loading, setLoading] = useState<boolean>(true);
  // Add Provider 弹窗开合态（12.3）：由左栏「+」入口触发
  const [addProviderOpen, setAddProviderOpen] = useState<boolean>(false);

  // 右栏启用勾选的目标 agentId 集合（分发预览/分发的目标集合来源）
  const [enabledAgentIds, setEnabledAgentIds] = useState<string[]>([]);
  // 分发预览 Diff 弹窗开关
  const [previewOpen, setPreviewOpen] = useState<boolean>(false);
  // 分发报告弹窗开关
  const [reportOpen, setReportOpen] = useState<boolean>(false);

  // 启动时加载 AppState（经 IPC）
  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const state = await ipcClient.loadAppState();
        if (!cancelled) {
          setAppState(state);
        }
      } catch (err) {
        // 加载失败：保留空状态并提示（不中断界面）
        message.error(t('common.loadConfigFailed', { detail: toErrorMessage(err) }));
      } finally {
        if (!cancelled) {
          setLoading(false);
        }
      }
    })();
    return () => {
      cancelled = true;
    };
    // 仅在挂载时加载一次配置；t 变化（切换语言）无需重新加载，故不纳入依赖
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [message]);

  // 当前选中的 Provider（由 activeProviderId 解析而来）
  const activeProvider = useMemo<ProviderConfig | undefined>(
    () => appState.providers.find((p) => p.id === appState.activeProviderId),
    [appState.providers, appState.activeProviderId],
  );

  // 选中某个 Provider：更新 activeProviderId 并持久化 AppState
  const handleSelectProvider = useCallback(
    (providerId: string) => {
      setAppState((prev) => {
        const next: AppState = { ...prev, activeProviderId: providerId };
        // 仅在选中项真正变化时保存，避免无谓写盘
        if (prev.activeProviderId !== providerId) {
          void ipcClient.saveAppState(next).catch((err) => {
            message.error(t('common.saveConfigFailed', { detail: toErrorMessage(err) }));
          });
        }
        return next;
      });
    },
    [message, t],
  );

  // 编辑当前 Provider 的中立字段（来自 12.2 的 API 配置表单回传，不含明文密钥）：
  // 以 id 定位替换 providers 中对应项，并持久化 AppState。
  const handleProviderChange = useCallback(
    (next: ProviderConfig) => {
      setAppState((prev) => {
        const providers = prev.providers.map((p) => (p.id === next.id ? next : p));
        const updated: AppState = { ...prev, providers };
        void ipcClient.saveAppState(updated).catch((err) => {
          message.error(t('common.saveConfigFailed', { detail: toErrorMessage(err) }));
        });
        return updated;
      });
    },
    [message, t],
  );

  // 新增 Provider：打开平台预设选择弹窗（12.3）
  const handleAddProvider = useCallback(() => {
    setAddProviderOpen(true);
  }, []);

  // 弹窗创建成功：把新 Provider 追加到状态、选中它并持久化 AppState
  const handleCreateProvider = useCallback(
    (provider: ProviderConfig) => {
      setAppState((prev) => {
        const next: AppState = {
          ...prev,
          providers: [...prev.providers, provider],
          activeProviderId: provider.id,
        };
        void ipcClient.saveAppState(next).catch((err) => {
          message.error(t('common.saveConfigFailed', { detail: toErrorMessage(err) }));
        });
        return next;
      });
    },
    [message, t],
  );

  // 预览：校验已选中 Provider 且右栏已勾选启用 agent，再打开预览 Diff 弹窗
  const handlePreview = useCallback(() => {
    if (!activeProvider) {
      message.warning(t('app.selectProviderFirst'));
      return;
    }
    if (enabledAgentIds.length === 0) {
      message.warning(t('app.enableAgentFirst'));
      return;
    }
    setPreviewOpen(true);
  }, [activeProvider, enabledAgentIds, message, t]);

  // 一键分发：校验同上，再打开分发报告弹窗（弹窗内执行 distribute 并展示 ApplyReport）
  const handleDistribute = useCallback(() => {
    if (!activeProvider) {
      message.warning(t('app.selectProviderFirst'));
      return;
    }
    if (enabledAgentIds.length === 0) {
      message.warning(t('app.enableAgentFirst'));
      return;
    }
    setReportOpen(true);
  }, [activeProvider, enabledAgentIds, message, t]);

  // 首次加载态：居中 Spin
  if (loading) {
    return (
      <Layout style={{ height: '100vh' }}>
        <div
          style={{
            flex: 1,
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
          }}
        >
          <Spin size="large" tip={t('header.loadingConfig')}>
            <div style={{ padding: 48 }} />
          </Spin>
        </div>
      </Layout>
    );
  }

  return (
    <Layout style={{ height: '100vh' }}>
      {/* 顶部栏：品牌标题 + 主操作（预览/分发）占位 */}
      <Header
        style={{
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'space-between',
          background: '#fff',
          borderBottom: '1px solid #f0f0f0',
          paddingInline: 16,
        }}
      >
        <Space align="center" size={10}>
          <Title level={5} style={{ margin: 0 }}>
            {t('header.title')}
          </Title>
          <Text type="secondary" style={{ fontSize: 12 }}>
            {t('header.subtitle')}
          </Text>
        </Space>
        <Space size={12}>
          {/* 语言切换：中文 / English，切换即持久化到 localStorage */}
          <GlobalOutlined style={{ color: 'rgba(0,0,0,0.45)' }} />
          <LanguageSwitch />
          <Button icon={<EyeOutlined />} onClick={handlePreview}>
            {t('header.preview')}
          </Button>
          <Button type="primary" icon={<SendOutlined />} onClick={handleDistribute}>
            {t('header.distribute')}
          </Button>
        </Space>
      </Header>

      {/* 主体三栏 */}
      <Layout>
        {/* 左栏：Provider 列表 */}
        <Sider width={264} theme="light" style={{ borderRight: '1px solid #f0f0f0' }}>
          <ProviderList
            providers={appState.providers}
            activeProviderId={appState.activeProviderId}
            onSelect={handleSelectProvider}
            onAddProvider={handleAddProvider}
          />
        </Sider>

        {/* 中栏：Provider 详情容器（含 12.2/12.4/12.5 的占位插槽） */}
        <Content style={{ background: '#fff' }}>
          <ProviderDetail provider={activeProvider} onProviderChange={handleProviderChange} />
        </Content>

        {/* 右栏：Agent 分发面板（启用勾选，向上提供分发目标 agentIds） */}
        <Sider width={300} theme="light" style={{ borderLeft: '1px solid #f0f0f0' }}>
          <AgentPanel onEnabledChange={setEnabledAgentIds} />
        </Sider>
      </Layout>

      {/* Add Provider 平台预设选择弹窗（12.3）：创建结果经 onCreate 持久化到 AppState */}
      <AddProviderModal
        open={addProviderOpen}
        existingIds={appState.providers.map((p) => p.id)}
        onClose={() => setAddProviderOpen(false)}
        onCreate={handleCreateProvider}
      />

      {/* 分发预览 Diff 弹窗：调用 preview 展示掩码差异；确认后转交分发报告弹窗 */}
      <PreviewDiffModal
        open={previewOpen}
        provider={activeProvider}
        agentIds={enabledAgentIds}
        onClose={() => setPreviewOpen(false)}
        onConfirmDistribute={() => setReportOpen(true)}
      />

      {/* 分发报告弹窗：打开时执行 distribute 并展示 ApplyReport（成功/失败/跳过/备份/原因） */}
      <DistributeReportModal
        open={reportOpen}
        provider={activeProvider}
        agentIds={enabledAgentIds}
        onClose={() => setReportOpen(false)}
      />
    </Layout>
  );
}

/**
 * 顶部语言切换控件：在「简体中文 / English」间切换，选择经 localStorage 持久化。
 */
function LanguageSwitch(): React.JSX.Element {
  const { locale, setLocale, t } = useTranslation();
  return (
    <Segmented<LocaleCode>
      size="small"
      value={locale}
      onChange={(value) => setLocale(value)}
      options={[
        { label: t('language.zh'), value: 'zh-CN' },
        { label: t('language.en'), value: 'en-US' },
      ]}
      // 用地球图标点明这是语言切换
      // （antd Segmented 不直接支持整体前缀图标，这里以 title 提供无障碍说明）
      title={t('language.label')}
    />
  );
}

/** 把未知错误安全地转为可展示的字符串 */
function toErrorMessage(err: unknown): string {
  if (err instanceof Error) {
    return err.message;
  }
  return String(err);
}
