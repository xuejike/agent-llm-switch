import type { ThemeConfig } from 'antd';

// 全局 antd 主题配置（design token）
// 与设计稿保持一致：主色 #1677ff、圆角 6px，沿用 antd 默认算法
// 所有页面统一在同一 ConfigProvider 下渲染，保证视觉一致
export const antdTheme: ThemeConfig = {
  token: {
    // 主色：品牌蓝，用于按钮、链接、选中态等
    colorPrimary: '#1677ff',
    // 全局圆角（像素）：按钮、输入框、卡片等组件统一圆角
    borderRadius: 6,
  },
};
