// 跨进程共享的类型与常量入口
// 主进程与渲染进程均从此处导入共享的 TypeScript 类型定义与跨进程常量。
// 全部核心类型在 ./types 中声明，IPC channel 常量在 ./ipcChannels 中声明，此处统一重新导出。

// 跨进程 IPC channel 名称常量（主进程 handlers 与预加载脚本共用，保证两端不漂移）
export { IPC_CHANNELS } from "./ipcChannels";
export type { IpcChannel } from "./ipcChannels";

export type {
  // 数据驱动声明类型
  ConfigFormat,
  FormatMapping,
  CredentialForm,
  CredentialMapping,
  AuthInjection,
  ModelListingResponseMapping,
  ModelListingConfig,
  ModelProbeConfig,
  ProbeOptions,
  FetchModelsResult,
  // 模型发现与探测
  ModelAvailability,
  ModelSource,
  ModelInfo,
  ModelProbeResult,
  // Provider 配置
  ProxyConfig,
  ProviderConfig,
  // 平台 / 探测 / 渲染 / 报告 / 状态
  PlatformContext,
  DetectResult,
  RenderResult,
  ApplyEntry,
  ApplyReport,
  PreviewResult,
  AgentState,
  AppState,
  // IPC 契约
  IpcApi,
} from "./types";
