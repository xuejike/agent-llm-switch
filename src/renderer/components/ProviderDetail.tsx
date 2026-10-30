// Provider 详情容器（主界面中栏 / antd Layout.Content 内容）
//
// 职责：展示当前选中 Provider 的详情头部，并作为中栏各功能区的「容器与插槽宿主」。
// 本任务（12.1）只做：
// - 详情头部：Provider 名称 + 副标题（配置真相）+「Test connection」按钮占位
// - 为后续任务预留清晰的占位区域（PlaceholderSlot），各区域由对应任务独立填充：
//     · 12.2 API 配置表单（name/baseUrl/timeout/proxy + API Key 掩码输入）
//     · 12.4 模型发现、探测与筛选（fetchModels / probeModels + Table 筛选）
//     · 12.5 分发预览 Diff 与分发报告（preview / distribute 结果）
//   —— 12.3 的 Add Provider 弹窗由 App 层挂载（非中栏常驻区域），此处不占位。
//
// 一律使用 antd 现成组件：头部用 antd `Typography` + `Button`（图标取 `@ant-design/icons`），
// 布局用 antd `Space`/`Flex` 容器。布局参照 ui.pen 主界面画布中栏（DetailHeader + 配置卡 + 模型卡）。
//
// 本组件为受控组件：当前 Provider 由上层 App 以 props 注入；无选中时展示空态引导。

import { useCallback, useState } from 'react';
import { App as AntApp, Button, Empty, Flex, Space, Typography } from 'antd';
import { ApiOutlined } from '@ant-design/icons';
import type { ProviderConfig } from '@shared/types';
import { ipcClient } from '../ipc/client';
import { useTranslation } from '../i18n';
import { PlaceholderSlot } from './PlaceholderSlot';
import { ProviderForm } from './ProviderForm';
import { ModelDiscoveryPanel } from './ModelDiscoveryPanel';

const { Title, Text } = Typography;

/** ProviderDetail 组件属性 */
export interface ProviderDetailProps {
  /** 当前选中的 Provider（可空：无选中时展示空态） */
  provider?: ProviderConfig;
  /**
   * Provider 中立字段变更回调：由中栏 API 配置表单（12.2）在编辑时透传上来，
   * 供上层 App 合并进 AppState 并持久化。回传对象不含明文密钥。
   */
  onProviderChange?: (next: ProviderConfig) => void;
}

/**
 * 中栏 Provider 详情容器。
 * - 无选中 Provider：整栏展示空态引导
 * - 有选中 Provider：头部 + 三个功能区占位（待 12.2 / 12.4 / 12.5 填充）
 */
export function ProviderDetail({ provider, onProviderChange }: ProviderDetailProps): React.JSX.Element {
  // 从 antd App 上下文取 message 实例：确保 toast 能在正确的上下文中弹出（与中栏其他面板一致）
  const { message } = AntApp.useApp();
  const { t } = useTranslation();
  // 「测试连接」进行态：驱动按钮 loading 与禁用，避免重复点击
  const [testing, setTesting] = useState<boolean>(false);

  // 测试连接：复用 fetchModels 探测 baseUrl 可达性与鉴权连通性。
  // 成功返回（无论是否支持列表 API）即视为连接通；抛错则视为连接失败。
  const handleTestConnection = useCallback(async () => {
    if (!provider) {
      return;
    }
    setTesting(true);
    try {
      const result = await ipcClient.fetchModels(provider);
      if (!result.supportsListing) {
        // 端点可达但该 provider 不提供列表 API：连接本身是通的，给出中性提示
        message.success(t('providerDetail.testOkNoListing'));
      } else if (result.warning) {
        // 连接可达但拉取存在问题（鉴权/格式等）：以警告形式提示，便于排查
        message.warning(t('providerDetail.testReachableWithWarning', { warning: result.warning }));
      } else {
        message.success(t('providerDetail.testOkWithModels', { count: result.models.length }));
      }
    } catch (err) {
      message.error(t('providerDetail.testFailed', { detail: err instanceof Error ? err.message : String(err) }));
    } finally {
      setTesting(false);
    }
  }, [provider, message, t]);

  // 空态：尚未选中任何 Provider
  if (!provider) {
    return (
      <Flex align="center" justify="center" style={{ height: '100%' }}>
        <Empty description={t('providerDetail.emptyHint')} />
      </Flex>
    );
  }

  return (
    <Flex vertical gap={16} style={{ padding: 24, height: '100%', overflowY: 'auto' }}>
      {/* 详情头部：名称 + 副标题 + Test connection 按钮（连接测试逻辑待后续任务接入） */}
      <Flex align="center" justify="space-between">
        <Space direction="vertical" size={0}>
          <Title level={4} style={{ margin: 0 }}>
            {provider.name}
          </Title>
          <Text type="secondary">{t('providerDetail.subtitle')}</Text>
        </Space>
        {/* 测试连接：调用探测端点验证 baseUrl/鉴权连通性，结果以 toast 反馈成功/警告/失败 */}
        <Button
          icon={<ApiOutlined />}
          loading={testing}
          onClick={() => void handleTestConnection()}
        >
          {t('providerDetail.testConnection')}
        </Button>
      </Flex>

      {/* 12.2：API 配置表单（name/baseUrl/timeout/proxy + API Key 掩码输入，明文不进入 React 状态）。
          key 绑定 provider.id：切换 Provider 时重建表单实例，避免残留上一个 Provider 的输入态。 */}
      <ProviderForm key={provider.id} provider={provider} onChange={onProviderChange} />

      {/* 12.4：模型发现、探测与筛选（获取模型清单 / 探测可用性 / available-only|all 筛选）。
          勾选、筛选、探测结果经 onProviderChange 回写 models / candidateModels / modelSelection
          并由上层持久化。未提供 onProviderChange 时退化为占位（只读场景）。 */}
      {onProviderChange ? (
        <ModelDiscoveryPanel provider={provider} onProviderChange={onProviderChange} />
      ) : (
        <PlaceholderSlot
          title={t('providerDetail.modelsSlotTitle')}
          description={t('providerDetail.modelsSlotDesc')}
        />
      )}

      {/* TODO(12.5): 用「分发预览 Diff / 分发报告」组件替换此占位（通常以 Modal/Drawer 呈现，
          此处保留一个中栏入口/摘要区占位） —— preview 的 maskedDiff 与 distribute 的 ApplyReport */}
      <PlaceholderSlot
        title={t('providerDetail.distSlotTitle')}
        description={t('providerDetail.distSlotDesc')}
      />
    </Flex>
  );
}
