// 渲染进程侧的全局类型声明：为 preload 经 contextBridge 暴露的桥接对象声明类型。
//
// 约定（与任务 11.2 preload 保持一致）：
//   预加载脚本通过 `contextBridge.exposeInMainWorld('ipcApi', <IpcApi 实现>)`
//   将白名单 IPC 接口暴露到渲染进程全局，访问入口为 `window.ipcApi`。
//   其形状严格等于 src/shared/types.ts 中的 `IpcApi` 契约。
//
// 说明：
// - 本文件只做「类型层」声明，不产生任何运行时代码。
// - 若 11.2 尚在并行开发，运行时以 `IpcApi` 契约与约定全局名 `window.ipcApi` 为准。
// - `verbatimModuleSyntax` 开启，故对仅用于类型的导入使用 `import type`。

import type { IpcApi } from '@shared/types';

declare global {
  interface Window {
    /**
     * 由 preload（contextBridge）注入的白名单 IPC 接口。
     * 渲染进程只能经此对象委托主进程执行敏感操作（文件系统、凭据、适配器、模型发现等），
     * 其方法集合与签名严格对应 `IpcApi`。
     */
    readonly ipcApi: IpcApi;
  }
}

export {};
