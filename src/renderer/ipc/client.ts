// 渲染进程 IPC 客户端封装
//
// 职责：对 preload 经 contextBridge 暴露的全局桥接对象 `window.ipcApi` 做一层
// 「薄的、类型安全的代理」，供 UI 组件统一调用，避免在各组件内直接散落 `window.ipcApi`。
//
// 设计约束：
// - 本模块只做类型安全转发，不加任何业务逻辑（不做缓存、重试、状态管理、数据改写等）。
// - 方法集合与签名严格对应 src/shared/types.ts 的 `IpcApi` 契约。
// - 约定的全局名为 `window.ipcApi`（与任务 11.2 preload 的 contextBridge 暴露键名一致）。
// - 所有经 IPC 回传的数据均不含明文密钥（由主进程保证），本层不改变该语义。

import type {
  AppState,
  DetectResult,
  FetchModelsResult,
  IpcApi,
  ModelProbeResult,
  PreviewResult,
  ProbeOptions,
  ProviderConfig,
  ApplyReport,
} from '@shared/types';

/**
 * 获取底层桥接对象。
 * 正常情况下 preload 会在渲染进程加载前注入 `window.ipcApi`；
 * 若未注入（如 preload 未就绪或被禁用），提前抛出清晰错误，便于定位。
 */
function getBridge(): IpcApi {
  const bridge = window.ipcApi;
  if (!bridge) {
    throw new Error('IPC 桥接未就绪：未在 window 上找到 ipcApi（请检查 preload 是否已加载）');
  }
  return bridge;
}

/**
 * 类型安全的 IPC 客户端：方法形状与 `IpcApi` 契约一一对应。
 * UI 组件只依赖本对象，不直接访问 `window.ipcApi`。
 */
export const ipcClient: IpcApi = {
  /** 读取应用全局状态 */
  loadAppState(): Promise<AppState> {
    return getBridge().loadAppState();
  },

  /** 保存应用全局状态（不含明文密钥） */
  saveAppState(state: AppState): Promise<void> {
    return getBridge().saveAppState(state);
  },

  /** 保存密钥：明文由渲染进程输入后立即交主进程存入凭据管理器 */
  saveSecret(keyRef: string, apiKey: string): Promise<void> {
    return getBridge().saveSecret(keyRef, apiKey);
  },

  /** 返回用于 UI 展示的掩码串，从不回传明文 */
  getMaskedSecret(keyRef: string): Promise<string | null> {
    return getBridge().getMaskedSecret(keyRef);
  },

  /** 探测一组 agent 的安装与配置文件状态 */
  detectAgents(agentIds: string[]): Promise<DetectResult[]> {
    return getBridge().detectAgents(agentIds);
  },

  /** 仅预览：对启用的 agent 生成合并结果与掩码差异，不写盘 */
  preview(config: ProviderConfig, agentIds: string[]): Promise<PreviewResult[]> {
    return getBridge().preview(config, agentIds);
  },

  /** 执行分发：写盘并返回报告 */
  distribute(config: ProviderConfig, agentIds: string[]): Promise<ApplyReport> {
    return getBridge().distribute(config, agentIds);
  },

  /** 列出所有已注册适配器（用于 UI 展示可管理的 agent 列表） */
  listAgents(): Promise<{ id: string; displayName: string }[]> {
    return getBridge().listAgents();
  },

  /** 自动获取某 provider 的模型清单（返回不含明文密钥） */
  fetchModels(config: ProviderConfig): Promise<FetchModelsResult> {
    return getBridge().fetchModels(config);
  },

  /** 批量探测模型可用性（返回不含明文密钥） */
  probeModels(
    config: ProviderConfig,
    modelIds: string[],
    options?: ProbeOptions,
  ): Promise<ModelProbeResult[]> {
    return getBridge().probeModels(config, modelIds, options);
  },
};

export type { IpcApi } from '@shared/types';
