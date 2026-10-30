// 占位插槽组件（为 12.2~12.5 预留的扩展点）
//
// 职责：在整体三栏布局搭好后，为后续任务要填充的区域提供「清晰可见、语义明确」的占位，
// 使 12.2（API 配置表单）、12.4（模型发现/探测/筛选）、12.5（分发预览/报告）能各自
// 独立填充各自区域，而无需改动本任务确立的布局骨架。
//
// 一律使用 antd 现成组件：用 antd `Card` 承载区域、`Empty` 展示占位说明。
// 后续任务填充时：把对应 PlaceholderSlot 替换为真实组件即可（布局不变）。

import { Card, Empty, Typography } from 'antd';

const { Text } = Typography;

/** 占位插槽属性 */
export interface PlaceholderSlotProps {
  /** 卡片标题（标明该区域将由哪个任务填充） */
  title: string;
  /** 占位说明文案 */
  description: string;
}

/**
 * 通用占位插槽：以 antd Card + Empty 呈现一块「待填充」区域。
 * 仅用于 12.1 阶段标识扩展点，后续任务会以真实组件替换。
 */
export function PlaceholderSlot({ title, description }: PlaceholderSlotProps): React.JSX.Element {
  return (
    <Card size="small" title={title} style={{ width: '100%' }}>
      <Empty
        image={Empty.PRESENTED_IMAGE_SIMPLE}
        description={<Text type="secondary">{description}</Text>}
      />
    </Card>
  );
}
