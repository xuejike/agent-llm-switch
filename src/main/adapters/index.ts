// 适配器启动注册点（集中 register 四个 Agent 适配器）
//
// 本模块是 design.md「示例 1：注册适配器（启动时，新增 agent 只在此处增加一行）」的落地：
// 集中创建 AdapterRegistry 并把 opencode、pi、workbuddy、codebuddy 四个适配器一次注册完成。
// 主进程/IPC 层（任务 11）在启动时调用 createRegisteredAdapters() 获得已注册好的注册表，
// 供 Distributor 与 listAgents 等使用。
//
// 扩展约定（需求 8.1 / 8.2 / Property 5）：新增一个 agent 只需在此追加一行 register(...)，
// 核心分发逻辑无需改动，且不影响其它已注册适配器的行为（注册彼此隔离）。

import { createAdapterRegistry, type AdapterRegistry } from "./registry";
import { OpencodeAdapter } from "./opencodeAdapter";
import { PiAdapter } from "./piAdapter";
import { WorkbuddyAdapter } from "./workbuddyAdapter";
import { CodebuddyAdapter } from "./codebuddyAdapter";

// 重新导出各适配器与其映射工厂，便于上层按需引用或定制
export * from "./opencodeAdapter";
export * from "./piAdapter";
export * from "./workbuddyAdapter";
export * from "./codebuddyAdapter";

/**
 * 创建一个已注册四个内置适配器的 AdapterRegistry。
 *
 * 启动注册点：集中实例化并注册 opencode / pi / workbuddy / codebuddy。每个适配器使用其
 * 默认 FormatMapping（含 CredentialMapping）——key 的 agent 差异一律在各自 render 内经
 * injectCredential 转换，不污染供应商中立的 ProviderConfig。
 *
 * @returns 已注册四个内置适配器的注册表
 */
export function createRegisteredAdapters(): AdapterRegistry {
  const registry = createAdapterRegistry();

  // 新增 agent 只需在此追加一行 register(...)
  registry.register(new OpencodeAdapter());
  registry.register(new PiAdapter());
  registry.register(new WorkbuddyAdapter());
  registry.register(new CodebuddyAdapter());

  return registry;
}
