// 轻量 i18n 基础设施（无第三方依赖）
//
// 提供：
// - LocaleProvider：挂在应用根部，持有当前语言（locale）与切换方法，并经 localStorage 持久化。
// - useTranslation()：返回 t(key, vars) 翻译函数与当前 locale / setLocale。
// - t(key, vars)：按点分路径取文案（如 'header.title'），并把 {name} 占位符用 vars 插值。
// - antdLocale：把当前 locale 映射到 antd 的语言包，供 main.tsx 的 ConfigProvider 同步。
//
// 设计取舍：语言偏好属纯 UI 偏好、不涉及「配置真相」，故用渲染进程本地的 localStorage 持久化，
// 启动即同步可读、零闪烁，且不改动跨进程 AppState 契约。

import React, { createContext, useCallback, useContext, useMemo, useState } from 'react';
import type { Locale as AntdLocale } from 'antd/es/locale';
import zhCN from 'antd/locale/zh_CN';
import enUS from 'antd/locale/en_US';
import { zh, type Messages } from './locales/zh';
import { en } from './locales/en';

/** 支持的界面语言 */
export type LocaleCode = 'zh-CN' | 'en-US';

/** localStorage 持久化键 */
const STORAGE_KEY = 'llm-switch.locale';

/** 语言资源表 */
const MESSAGES: Record<LocaleCode, Messages> = {
  'zh-CN': zh,
  'en-US': en,
};

/** 对应的 antd 语言包 */
const ANTD_LOCALES: Record<LocaleCode, AntdLocale> = {
  'zh-CN': zhCN,
  'en-US': enUS,
};

// ---------------------------------------------------------------------------
// 翻译键类型：由 Messages 结构递归推导出的「点分路径」联合，保证 t() 的 key 类型安全。
// ---------------------------------------------------------------------------
type DotPaths<T, Prefix extends string = ''> = {
  [K in keyof T & string]: T[K] extends string
    ? `${Prefix}${K}`
    : DotPaths<T[K], `${Prefix}${K}.`>;
}[keyof T & string];

/** 所有合法翻译键（如 'header.title' | 'providerForm.name' | ...） */
export type TKey = DotPaths<Messages>;

/** 插值变量：键为占位符名，值为字符串或数字 */
export type TVars = Record<string, string | number>;

// ---------------------------------------------------------------------------
// 运行时取值与插值
// ---------------------------------------------------------------------------

/** 按点分路径从消息表取字符串；缺失时返回 key 本身（便于定位漏翻） */
function lookup(messages: Messages, key: string): string {
  const parts = key.split('.');
  let cur: unknown = messages;
  for (const p of parts) {
    if (cur && typeof cur === 'object' && p in (cur as Record<string, unknown>)) {
      cur = (cur as Record<string, unknown>)[p];
    } else {
      return key;
    }
  }
  return typeof cur === 'string' ? cur : key;
}

/** 把模板中的 {name} 占位符替换为 vars.name（未提供的占位符原样保留） */
function interpolate(template: string, vars?: TVars): string {
  if (!vars) {
    return template;
  }
  return template.replace(/\{(\w+)\}/g, (match, name: string) =>
    name in vars ? String(vars[name]) : match,
  );
}

// ---------------------------------------------------------------------------
// Context
// ---------------------------------------------------------------------------

interface LocaleContextValue {
  /** 当前语言 */
  locale: LocaleCode;
  /** 切换语言（并持久化） */
  setLocale: (next: LocaleCode) => void;
  /** 翻译函数 */
  t: (key: TKey, vars?: TVars) => string;
}

const LocaleContext = createContext<LocaleContextValue | null>(null);

/** 从 localStorage 读取初始语言；无则按浏览器语言推断，默认中文 */
function resolveInitialLocale(): LocaleCode {
  try {
    const saved = window.localStorage.getItem(STORAGE_KEY);
    if (saved === 'zh-CN' || saved === 'en-US') {
      return saved;
    }
  } catch {
    // localStorage 不可用时忽略，走默认推断
  }
  // 按运行环境语言推断：以 zh 开头用中文，其余用英文
  const nav = typeof navigator !== 'undefined' ? navigator.language : 'zh-CN';
  return nav.toLowerCase().startsWith('zh') ? 'zh-CN' : 'en-US';
}

/**
 * i18n Provider：持有当前语言并提供 t()。
 * 子树（含 antd ConfigProvider）可据 locale 同步切换 antd 语言包。
 */
export function LocaleProvider({ children }: { children: React.ReactNode }): React.JSX.Element {
  const [locale, setLocaleState] = useState<LocaleCode>(resolveInitialLocale);

  const setLocale = useCallback((next: LocaleCode) => {
    setLocaleState(next);
    try {
      window.localStorage.setItem(STORAGE_KEY, next);
    } catch {
      // 持久化失败不影响当前会话切换
    }
  }, []);

  const t = useCallback(
    (key: TKey, vars?: TVars): string => interpolate(lookup(MESSAGES[locale], key), vars),
    [locale],
  );

  const value = useMemo<LocaleContextValue>(() => ({ locale, setLocale, t }), [locale, setLocale, t]);

  return <LocaleContext.Provider value={value}>{children}</LocaleContext.Provider>;
}

/** 消费 i18n：返回 t / locale / setLocale。必须在 LocaleProvider 内使用。 */
export function useTranslation(): LocaleContextValue {
  const ctx = useContext(LocaleContext);
  if (!ctx) {
    throw new Error('useTranslation 必须在 LocaleProvider 内使用');
  }
  return ctx;
}

/** 取当前 locale 对应的 antd 语言包（供 ConfigProvider.locale 使用） */
export function getAntdLocale(locale: LocaleCode): AntdLocale {
  return ANTD_LOCALES[locale];
}
