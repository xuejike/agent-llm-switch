// Provider 列表（主界面左栏 / antd Layout.Sider 内容）
//
// 职责：展示所有 Provider，支持选中切换；顶部有分区标题与「Add Provider」入口。
// 一律使用 antd 现成组件：
// - 列表用 antd `List`（`List.Item` 承载每条 Provider）
// - 选中态用背景高亮（accent-soft）
// - 连接/可用状态点用 antd `Badge`（status 语义色），本地 provider 额外用 `Tag` 标注「local」
// - 标题/副标题用 antd `Typography`
// - 新增入口用 antd `Button`（图标取自 `@ant-design/icons`）
//
// 布局参照 ui.pen 主界面画布左栏（PROVIDERS 标题 + 加号、列表项含状态点/名称/主机/local 徽标）。
//
// 本组件为受控组件：数据与选中项由上层 App 通过 props 注入，交互经回调上抛，
// 不在此持有 AppState 或发起 IPC（加载/保存 AppState 的编排集中在 App）。

import { Badge, Button, List, Space, Tag, Typography } from 'antd';
import { CloudServerOutlined, PlusOutlined } from '@ant-design/icons';
import type { ProviderConfig } from '@shared/types';
import { getProviderStatusView } from './providerStatus';
import { useTranslation } from '../i18n';

const { Text } = Typography;

/** ProviderList 组件属性 */
export interface ProviderListProps {
  /** 全部 Provider 配置 */
  providers: ProviderConfig[];
  /** 当前选中的 Provider id（可空：无选中时） */
  activeProviderId?: string;
  /** 选中某个 Provider 时回调 */
  onSelect: (providerId: string) => void;
  /** 点击「Add Provider」时回调（新增流程由 12.3 的弹窗实现） */
  onAddProvider: () => void;
}

/**
 * 左栏 Provider 列表。
 * 空列表时给出引导文案；非空时逐条渲染状态点 + 名称 + 主机 + 本地徽标。
 */
export function ProviderList({
  providers,
  activeProviderId,
  onSelect,
  onAddProvider,
}: ProviderListProps): React.JSX.Element {
  const { t } = useTranslation();
  return (
    <div style={{ display: 'flex', flexDirection: 'column', height: '100%' }}>
      {/* 左栏头部：分区标题 + 新增入口 */}
      <div
        style={{
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'space-between',
          padding: '12px 16px',
          borderBottom: '1px solid #f0f0f0',
        }}
      >
        <Text type="secondary" style={{ fontSize: 11, letterSpacing: 1 }}>
          {t('providerList.sectionTitle')}
        </Text>
        {/* 新增 Provider：点击触发 12.3 的平台预设选择弹窗 */}
        <Button
          size="small"
          type="text"
          icon={<PlusOutlined />}
          aria-label={t('providerList.addProviderAria')}
          onClick={onAddProvider}
        />
      </div>

      {/* Provider 列表主体：可纵向滚动 */}
      <div style={{ flex: 1, overflowY: 'auto' }}>
        <List<ProviderConfig>
          dataSource={providers}
          locale={{ emptyText: t('providerList.empty') }}
          renderItem={(provider) => {
            const status = getProviderStatusView(provider);
            const selected = provider.id === activeProviderId;
            return (
              <List.Item
                // 选中项高亮背景（对应设计稿 accent-soft #E6F4FF）
                style={{
                  padding: '10px 16px',
                  cursor: 'pointer',
                  backgroundColor: selected ? '#e6f4ff' : undefined,
                }}
                onClick={() => onSelect(provider.id)}
              >
                <Space align="start" size={10} style={{ width: '100%' }}>
                  {/* 连接/可用状态点：antd Badge 语义色 */}
                  <Badge status={status.level} title={t(status.textKey)} />
                  <div style={{ display: 'flex', flexDirection: 'column', minWidth: 0 }}>
                    <Space size={6} align="center">
                      <Text strong style={{ fontSize: 13 }}>
                        {provider.name}
                      </Text>
                      {/* 本地 provider 徽标 */}
                      {provider.isLocal ? (
                        <Tag icon={<CloudServerOutlined />} bordered={false} style={{ fontSize: 9 }}>
                          {t('providerList.localBadge')}
                        </Tag>
                      ) : null}
                    </Space>
                    {/* 主机地址（取 baseUrl 的 host 部分展示，解析失败则回退完整串） */}
                    <Text type="secondary" style={{ fontSize: 11 }}>
                      {formatHost(provider.baseUrl)}
                    </Text>
                  </div>
                </Space>
              </List.Item>
            );
          }}
        />
      </div>
    </div>
  );
}

/**
 * 从 baseUrl 中提取 host（含端口）用于列表副标题展示；
 * 解析失败（非法 URL）时回退为原始字符串，避免渲染异常。
 */
function formatHost(baseUrl: string): string {
  try {
    return new URL(baseUrl).host;
  } catch {
    return baseUrl;
  }
}
