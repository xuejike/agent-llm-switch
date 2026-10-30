// 跨进程 IPC channel 名称常量（进程边界协议的一部分）
//
// 这些 channel 名是主进程 ipcMain.handle 与预加载脚本 ipcRenderer.invoke 之间的「约定协议」，
// 天然属于跨进程共享契约，因此与 IpcApi 契约一起放在 src/shared，供主进程（handlers）与
// 预加载脚本（preload）从同一处引用，保证两端严格对应、不因各自手写字符串而漂移。
//
// 本文件只含纯常量与由其派生的类型，无任何运行时副作用，便于主进程与预加载脚本共同安全引用。

/**
 * IpcApi 各方法对应的 IPC channel 名称。
 *
 * 集中声明为常量：主进程按这些名字注册 ipcMain.handle，预加载脚本据同一组名字做
 * ipcRenderer.invoke 桥接，保证两端严格对应、不因手写字符串而漂移。命名用「域:动作」
 * 风格（如 "appState:load"），便于按域归类与调试。
 */
export const IPC_CHANNELS = {
  loadAppState: "appState:load",
  saveAppState: "appState:save",
  saveSecret: "secret:save",
  getMaskedSecret: "secret:getMasked",
  detectAgents: "agents:detect",
  preview: "distribute:preview",
  distribute: "distribute:apply",
  listAgents: "agents:list",
  fetchModels: "models:fetch",
  probeModels: "models:probe",
} as const;

/** IPC channel 名称联合类型（由上面的常量派生） */
export type IpcChannel = (typeof IPC_CHANNELS)[keyof typeof IPC_CHANNELS];
