// 适配器注册表（AdapterRegistry）
//
// 本模块实现 design.md 组件 1 的 AdapterRegistry：集中管理所有已注册的 Agent 适配器，
// 提供 register（注册）/ get（按 id 查询）/ list（列出全部）三项能力。新增 agent 支持时
// 只需在此注册一份适配器，核心分发逻辑（Distributor）无需改动（对应需求 8.1 / 8.2）。
//
// 扩展隔离（需求 8.2 / Property 5）：注册新适配器只向内部映射新增一个条目，不触碰也不改变
// 其它已注册适配器实例的状态与行为，从而保证「新增一个 agent 不影响其它 agent 的分发行为」。

import type { AgentAdapter } from "./base";

/**
 * 适配器注册表接口（参照 design.md 组件 1）。
 *
 * 职责：维护「agent id → 适配器」的集中映射，支持注册、按 id 查询与列出全部。
 */
export interface AdapterRegistry {
  /** 注册一个适配器（启动时或插件加载时调用） */
  register(adapter: AgentAdapter): void;
  /** 按 agent 唯一 id 获取适配器；不存在返回 undefined */
  get(agentId: string): AgentAdapter | undefined;
  /** 列出所有已注册适配器（用于 UI 展示可管理的 agent 列表） */
  list(): AgentAdapter[];
}

/**
 * AdapterRegistry 的默认内存实现。
 *
 * 以 Map 维护「id → 适配器」映射：register 以 adapter.id 为键写入，重复 id 覆盖旧条目
 * （便于热替换/升级同一 agent 的适配器）；get 按 id 读取；list 返回当前全部适配器的快照数组。
 */
export class InMemoryAdapterRegistry implements AdapterRegistry {
  /** 内部映射：agent id → 适配器实例 */
  private readonly adapters = new Map<string, AgentAdapter>();

  /**
   * 注册一个适配器。
   *
   * 以 adapter.id 作为键。若已存在同 id 适配器则覆盖——支持同一 agent 适配器的升级替换；
   * 该操作只影响该 id 自身，不改变其它已注册适配器（扩展隔离）。
   *
   * @param adapter 待注册的适配器实例
   */
  register(adapter: AgentAdapter): void {
    this.adapters.set(adapter.id, adapter);
  }

  /**
   * 按 agent 唯一 id 获取适配器。
   *
   * @param agentId agent 唯一标识
   * @returns 对应适配器实例；不存在时返回 undefined
   */
  get(agentId: string): AgentAdapter | undefined {
    return this.adapters.get(agentId);
  }

  /**
   * 列出所有已注册适配器。
   *
   * 返回内部映射值的浅拷贝数组，避免调用方直接改动注册表内部结构。
   *
   * @returns 当前全部已注册适配器的数组快照
   */
  list(): AgentAdapter[] {
    return Array.from(this.adapters.values());
  }
}

/**
 * 创建一个空的内存适配器注册表。
 *
 * 作为便捷工厂：启动注册点（见任务 9.2）可据此创建注册表并逐个 register 四个适配器。
 *
 * @returns 新建的空注册表
 */
export function createAdapterRegistry(): AdapterRegistry {
  return new InMemoryAdapterRegistry();
}
