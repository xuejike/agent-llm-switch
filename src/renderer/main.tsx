import React from 'react';
import ReactDOM from 'react-dom/client';
import { App as AntApp, ConfigProvider } from 'antd';
import { App } from './App';
import { antdTheme } from './theme';
import { LocaleProvider, useTranslation, getAntdLocale } from './i18n';

// 渲染进程入口：把 React 根组件挂载到 index.html 的 #root 节点
//
// 分层：
// - LocaleProvider：最外层，持有界面语言（中/英）并提供 t()，经 localStorage 持久化。
// - ConfigProvider：antd 主题 + 语言包（随当前 locale 在 zh_CN / en_US 间切换）。
// - AntApp：使组件内可用 App.useApp() 的 message/notification/Modal。
const rootElement = document.getElementById('root');
if (!rootElement) {
  // 启动期异常（用户一般不可见），保留简洁英文提示
  throw new Error('Root mount node #root not found');
}

/**
 * 在 LocaleProvider 之下读取当前语言，驱动 antd ConfigProvider 的语言包同步切换。
 */
function ThemedApp(): React.JSX.Element {
  const { locale } = useTranslation();
  return (
    <ConfigProvider theme={antdTheme} locale={getAntdLocale(locale)}>
      <AntApp style={{ height: '100vh' }}>
        <App />
      </AntApp>
    </ConfigProvider>
  );
}

ReactDOM.createRoot(rootElement).render(
  <React.StrictMode>
    <LocaleProvider>
      <ThemedApp />
    </LocaleProvider>
  </React.StrictMode>,
);
