// Electron 预加载脚本
//
// 本脚本运行在「预加载环境」——它与渲染页面上下文隔离（contextIsolation=true），
// 但能访问受限的 Electron API（如 ipcRenderer）。它的唯一职责是经 contextBridge
// 把一组「白名单」方法暴露到渲染进程的 window 上，使渲染进程只能通过这些受控方法
// 与主进程通信，而无法直接触达文件系统 / Node 能力 / 任意 ipcRenderer（对应需求 3.1 / 3.3 / 3.4）。
//
// 安全约束：
// - 仅暴露 IpcApi 契约声明的白名单方法，绝不把原始 ipcRenderer（或 require/process/fs 等）
//   挂到 window 上；渲染进程因此只能发起这些预定义调用，无法越权执行任意 IPC 或 Node 操作。
// - 每个方法都是对主进程某个 channel 的薄转调：ipcRenderer.invoke(channel, ...args)，
//   把渲染进程的调用一一映射到主进程已注册的 ipcMain.handle 处理器。
// - channel 名复用跨进程共享的 IPC_CHANNELS 常量（@shared/ipcChannels，主进程 handlers 亦从此引用），
//   保证两端严格对应、不因手写字符串而漂移（契约与实现同源）。
//
// 运行格式约束：主窗口开启了 sandbox=true，沙箱下预加载脚本必须为 CommonJS；
// electron-vite 已将本脚本打包输出为 dist/preload/index.cjs（见 electron.vite.config.ts
// 与主进程 webPreferences.preload 的路径约定）。

import { contextBridge, ipcRenderer } from "electron";

import { IPC_CHANNELS } from "@shared/ipcChannels";
import type {
  AppState,
  ApplyReport,
  DetectResult,
  FetchModelsResult,
  IpcApi,
  ModelProbeResult,
  PreviewResult,
  ProbeOptions,
  ProviderConfig,
} from "@shared/types";

/**
 * 暴露给渲染进程的白名单 API 实现。
 *
 * 每个方法严格匹配 IpcApi 契约的形状（参数与返回类型），内部仅做一件事：
 * 用 ipcRenderer.invoke 转调 IPC_CHANNELS 中对应的 channel，并把渲染进程传入的参数原样透传。
 * 由于主进程 ipcMain.handle 返回的是 Promise，这里的返回值天然为 Promise<...>，与契约一致。
 *
 * 显式以 `satisfies IpcApi` 校验：若将来契约新增/变更方法而此处遗漏，编译期即报错，
 * 从而保证「暴露的 API 形状严格匹配 IpcApi 契约」这一约束不被破坏。
 */
const ipcApi = {
  /** 读取应用全局状态 */
  loadAppState(): Promise<AppState> {
    return ipcRenderer.invoke(IPC_CHANNELS.loadAppState);
  },

  /** 保存应用全局状态（不含明文密钥） */
  saveAppState(state: AppState): Promise<void> {
    return ipcRenderer.invoke(IPC_CHANNELS.saveAppState, state);
  },

  /** 保存密钥：明文由渲染进程输入后立即交主进程存入凭据管理器（主进程用后即弃） */
  saveSecret(keyRef: string, apiKey: string): Promise<void> {
    return ipcRenderer.invoke(IPC_CHANNELS.saveSecret, keyRef, apiKey);
  },

  /** 返回用于 UI 展示的掩码串，从不回传明文；keyRef 不存在时返回 null */
  getMaskedSecret(keyRef: string): Promise<string | null> {
    return ipcRenderer.invoke(IPC_CHANNELS.getMaskedSecret, keyRef);
  },

  /** 探测一组 agent 的安装与配置文件状态 */
  detectAgents(agentIds: string[]): Promise<DetectResult[]> {
    return ipcRenderer.invoke(IPC_CHANNELS.detectAgents, agentIds);
  },

  /** 仅预览：对启用的 agent 生成合并结果与掩码差异，不写盘 */
  preview(config: ProviderConfig, agentIds: string[]): Promise<PreviewResult[]> {
    return ipcRenderer.invoke(IPC_CHANNELS.preview, config, agentIds);
  },

  /** 执行分发：写盘并返回报告（报告不含明文） */
  distribute(config: ProviderConfig, agentIds: string[]): Promise<ApplyReport> {
    return ipcRenderer.invoke(IPC_CHANNELS.distribute, config, agentIds);
  },

  /** 列出所有已注册适配器（用于 UI 展示可管理的 agent 列表） */
  listAgents(): Promise<{ id: string; displayName: string }[]> {
    return ipcRenderer.invoke(IPC_CHANNELS.listAgents);
  },

  /**
   * 自动获取某 provider 的模型清单。
   * 只传 config（含 apiKeyRef，不含明文）；主进程内部解析明文请求端点，结果不含明文。
   */
  fetchModels(config: ProviderConfig): Promise<FetchModelsResult> {
    return ipcRenderer.invoke(IPC_CHANNELS.fetchModels, config);
  },

  /** 批量探测模型可用性，返回与 modelIds 对应的结果（不含明文） */
  probeModels(
    config: ProviderConfig,
    modelIds: string[],
    options?: ProbeOptions,
  ): Promise<ModelProbeResult[]> {
    return ipcRenderer.invoke(IPC_CHANNELS.probeModels, config, modelIds, options);
  },
} satisfies IpcApi;

/**
 * 经 contextBridge 把白名单 API 暴露到渲染进程的 window.ipcApi。
 *
 * contextBridge 会在隔离的世界之间做安全的深拷贝桥接：渲染进程拿到的是方法引用，
 * 既无法触碰 ipcRenderer 本身，也无法借此访问 Node/文件系统。暴露名 "ipcApi" 与
 * 渲染进程 IPC 客户端（任务 11.3，经 window.ipcApi 类型安全调用）约定一致。
 */
contextBridge.exposeInMainWorld("ipcApi", ipcApi);
