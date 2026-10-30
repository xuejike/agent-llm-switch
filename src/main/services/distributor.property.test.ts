// 分发编排器（Distributor）属性测试
//
// 本文件覆盖 tasks.md 任务 10.2，围绕 Distributor 的「报告完备」与「模型筛选」两类不变量，
// 用 fast-check 做基于属性的测试（每条属性 >= 100 次迭代，复用 @shared/testing/fcConfig）：
//
//   **Property 4: 报告完备**
//     随机 agentIds，断言 distribute 返回的 ApplyReport.entries 恰好覆盖每个 agentId 一次，
//     且 summary 的 success/failed/skipped 三类计数之和等于 entries 长度。
//
//   **Property 7: 仅分发可用模型**
//     随机带各种 availability 的 candidateModels，在 modelSelection="available-only" 模式下，
//     断言最终「分发集合」（实际传给适配器 render 的 config.models）为 candidateModels 中
//     availability="available" 的 id 集合的子集。
//
//   **Property 11: 候选到分发的包含关系**
//     candidateModels 非空时，断言「分发集合」中每个模型 id 都存在于候选 id 集合中。
//
// **Validates: Requirements 11.1, 8.6, 8.7 / Property 4, 7, 11**
//
// 测试替身约束：
//   - AdapterRegistry：复用真实 InMemoryAdapterRegistry，注册「捕获型」假适配器——其 render
//     不写盘，仅把收到的 config.models 记录下来，供 Property 7/11 断言「分发集合」；apply 不碰
//     真实文件系统。
//   - SecretStore：复用内存实现 InMemorySecretStore，预置所需 keyRef，绝不触碰 OS 凭据库。
//   - AtomicFileWriter：内存替身，backup/atomicWrite/restore 均为空操作，绝不触碰真实文件系统。
//   - PlatformContext：固定的 linux 平台上下文；readExisting：恒返回 null（既有文件不存在）。

import { describe, it, expect } from "vitest";
import fc from "fast-check";
import { fcAssert, fcAssertAsync } from "@shared/testing/fcConfig";
import type {
  ApplyEntry,
  DetectResult,
  ModelAvailability,
  ModelInfo,
  PlatformContext,
  ProviderConfig,
  RenderResult,
} from "@shared/types";
import type { AgentAdapter } from "../adapters/base";
import { InMemoryAdapterRegistry } from "../adapters/registry";
import { InMemorySecretStore } from "./secretStore";
import type { AtomicFileWriter } from "./atomicFileWriter";
import { createDistributor, applyModelSelection } from "./distributor";

// ---------------------------------------------------------------------------
// 测试替身：固定平台上下文、内存写入器、捕获型适配器
// ---------------------------------------------------------------------------

/** 固定的测试平台上下文（linux），适配器 detect/configPath 据此解析路径 */
const PLATFORM: PlatformContext = {
  os: "linux",
  homeDir: "/home/tester",
  env: { HOME: "/home/tester", XDG_CONFIG_HOME: "/home/tester/.config" },
};

/**
 * 内存版 AtomicFileWriter 替身：三个方法均为空操作，绝不触碰真实文件系统。
 *
 * 本测试关注的是「分发集合」与「报告完备」，不验证写盘字节，故写入器只需满足接口、
 * 不产生副作用即可——这样属性测试可安全跑上百次迭代而无任何磁盘 I/O。
 */
const noopFileWriter: AtomicFileWriter = {
  // 备份：返回 null 表示分发前无既有文件（写入器无副作用）
  async backup(): Promise<string | null> {
    return null;
  },
  // 原子写入：空操作（不写真实文件）
  async atomicWrite(): Promise<void> {
    // 故意不做任何事：本测试不校验写盘内容
  },
  // 回滚：空操作
  async restore(): Promise<void> {
    // 故意不做任何事
  },
};

/**
 * 捕获型假适配器。
 *
 * 作用：
 *   - detect 恒报「已安装」，使 distribute 进入 render/apply 路径（Property 7/11 需要走到 render）；
 *   - render 不写盘，只把本次收到的 config.models 原样记录到 capturedModels，供断言「分发集合」；
 *   - apply 直接返回 success（不碰文件系统）。
 *
 * 每个实例彼此独立、无共享可变状态，契合注册表的扩展隔离语义。
 */
class CapturingAdapter implements AgentAdapter {
  readonly id: string;
  readonly displayName: string;
  /** 最近一次 render 收到的 config.models（即实际「分发集合」的快照） */
  capturedModels: string[] | null = null;

  constructor(id: string) {
    this.id = id;
    this.displayName = id;
  }

  // 恒报已安装，使分发进入写盘前的 render 环节
  async detect(): Promise<DetectResult> {
    return {
      installed: true,
      configPath: `/home/tester/.config/${this.id}/config.json`,
      fileExists: false,
    };
  }

  configPath(): string {
    return `/home/tester/.config/${this.id}/config.json`;
  }

  // 捕获本次分发写入该 agent 的模型集合；返回一个不含明文的最小 RenderResult
  render(config: ProviderConfig): RenderResult {
    this.capturedModels = [...config.models];
    return {
      mergedContent: "{}",
      maskedDiff: "",
    };
  }

  // 应用：不碰文件系统，直接判成功
  async apply(): Promise<ApplyEntry> {
    return { agentId: this.id, status: "success" };
  }
}

/**
 * 组装一个「全部 agent 都可成功分发」的 Distributor 及其捕获型适配器映射。
 *
 * @param agentIds 需要注册适配器的 agent id 列表（去重）
 * @returns distributor 与「agentId → 捕获型适配器」映射
 */
function makeDistributor(agentIds: string[]): {
  distributor: ReturnType<typeof createDistributor>;
  adapters: Map<string, CapturingAdapter>;
} {
  const registry = new InMemoryAdapterRegistry();
  const adapters = new Map<string, CapturingAdapter>();
  for (const id of agentIds) {
    const adapter = new CapturingAdapter(id);
    registry.register(adapter);
    adapters.set(id, adapter);
  }

  // 内存密钥服务并预置一个可解析的 keyRef，供需要鉴权的 config 使用
  const secretStore = new InMemorySecretStore();
  // 预置密钥的调用放在构造函数外（异步），这里用同步可解析的方式：直接 saveSecret 返回的 Promise
  // 由各用例在需要时 await；本工厂返回 store 的引用供调用方按需 saveSecret。
  const distributor = createDistributor({
    registry,
    secretStore,
    fileWriter: noopFileWriter,
    platform: PLATFORM,
    // 既有文件恒不存在：render 从空对象起步（本测试用捕获型适配器，其实不解析既有内容）
    readExisting: async () => null,
  });

  return { distributor, adapters };
}

/**
 * 构造一个「本地无鉴权」的基础 ProviderConfig。
 *
 * 置 isLocal=true 使 distribute 的密钥解析走「无鉴权」分支（返回空串，不访问 SecretStore），
 * 从而把属性测试聚焦在报告完备与模型筛选上，不被密钥解析细节干扰。
 *
 * @param models          已选分发模型 id 列表
 * @param candidateModels 候选模型清单（可选）
 * @param modelSelection  模型筛选策略（可选）
 */
function makeLocalConfig(
  models: string[],
  candidateModels?: ModelInfo[],
  modelSelection?: "available-only" | "all",
): ProviderConfig {
  return {
    id: "p1",
    name: "local-provider",
    baseUrl: "http://localhost:11434",
    apiKeyRef: "",
    isLocal: true,
    models,
    candidateModels,
    modelSelection,
  };
}

// ---------------------------------------------------------------------------
// fast-check 任意生成器
// ---------------------------------------------------------------------------

/** 合法 agent id：非空、仅字母数字连字符（避免空白/重复语义歧义） */
const agentIdArb = fc
  .string({ minLength: 1, maxLength: 8 })
  .map((s) => s.replace(/[^a-zA-Z0-9]/g, "a"))
  .filter((s) => s.length > 0);

/** 可用性取值生成器 */
const availabilityArb = fc.constantFrom<ModelAvailability>(
  "available",
  "unavailable",
  "unknown",
);

/** 单个候选模型生成器（id 来自给定候选 id 集合，random availability） */
function modelInfoArb(id: string): fc.Arbitrary<ModelInfo> {
  return availabilityArb.map((availability) => ({
    id,
    source: "fetched" as const,
    availability,
  }));
}

// ===========================================================================
// Property 4: 报告完备
// ===========================================================================

describe("Property 4: 报告完备", () => {
  it("entries 恰覆盖每个 agentId 一次，且 summary 计数之和等于 entries 长度", async () => {
    await fcAssertAsync(
      fc.asyncProperty(
        // 随机 agentIds：允许重复，以验证「每个请求位置都产出一条 entry」
        fc.array(agentIdArb, { minLength: 0, maxLength: 10 }),
        async (agentIds) => {
          // 为去重后的 id 注册捕获型适配器（重复 id 共享同一适配器实例，符合注册表语义）
          const uniqueIds = Array.from(new Set(agentIds));
          const { distributor } = makeDistributor(uniqueIds);

          const config = makeLocalConfig(["m1"]);
          const report = await distributor.distribute(config, agentIds);

          // 1. entries 长度等于请求的 agentIds 长度（逐一对应，不多不少）
          expect(report.entries.length).toBe(agentIds.length);

          // 2. entries 的 agentId 序列与请求顺序逐位一致（恰好覆盖每个请求 agentId 一次）
          expect(report.entries.map((e) => e.agentId)).toEqual(agentIds);

          // 3. summary 三类计数之和等于 entries 长度（计数无遗漏、无重复）
          const { success, failed, skipped } = report.summary;
          expect(success + failed + skipped).toBe(report.entries.length);

          // 4. 每条 entry 的 status 都落在三类之一（穷尽覆盖）
          for (const entry of report.entries) {
            expect(["success", "failed", "skipped"]).toContain(entry.status);
          }

          return true;
        },
      ),
    );
  });

  it("即便部分 agent 未注册（failed），报告仍完备且计数一致", async () => {
    await fcAssertAsync(
      fc.asyncProperty(
        fc.array(agentIdArb, { minLength: 1, maxLength: 8 }),
        async (agentIds) => {
          // 故意只注册「偶数下标」的 id 对应适配器，其余 id 无适配器 → distributeOne 记为 failed。
          // 这样报告中混有 success 与 failed，用以验证报告完备性在混合结果下依然成立。
          const uniqueIds = Array.from(new Set(agentIds));
          const registered = uniqueIds.filter((_, i) => i % 2 === 0);
          const { distributor } = makeDistributor(registered);

          const config = makeLocalConfig(["m1"]);
          const report = await distributor.distribute(config, agentIds);

          expect(report.entries.length).toBe(agentIds.length);
          expect(report.entries.map((e) => e.agentId)).toEqual(agentIds);
          const { success, failed, skipped } = report.summary;
          expect(success + failed + skipped).toBe(report.entries.length);

          return true;
        },
      ),
    );
  });
});

// ===========================================================================
// Property 7: 仅分发可用模型（available-only 模式）
// ===========================================================================

describe("Property 7: 仅分发可用模型", () => {
  it("available-only 模式下，分发集合为 candidateModels 中 available 的子集", async () => {
    await fcAssertAsync(
      fc.asyncProperty(
        // 生成一组唯一模型 id，并为每个 id 赋随机 availability，构成 candidateModels
        fc
          .uniqueArray(
            fc
              .string({ minLength: 1, maxLength: 6 })
              .map((s) => s.replace(/[^a-zA-Z0-9]/g, "m"))
              .filter((s) => s.length > 0),
            { minLength: 1, maxLength: 12 },
          )
          .chain((ids) =>
            fc.tuple(
              fc.constant(ids),
              // 为每个 id 生成一个 ModelInfo（带随机 availability）
              fc.tuple(...ids.map((id) => modelInfoArb(id))),
            ),
          ),
        async ([ids, models]) => {
          const candidateModels = models as ModelInfo[];
          // 已选 models 取全部候选 id（最宽集合），以充分检验 available-only 的收敛
          const selected = [...ids];

          const { distributor, adapters } = makeDistributor(["opencode"]);
          const config = makeLocalConfig(selected, candidateModels, "available-only");
          await distributor.distribute(config, ["opencode"]);

          const captured = adapters.get("opencode")!.capturedModels ?? [];

          // 候选中 available 的 id 集合
          const availableIds = new Set(
            candidateModels.filter((m) => m.availability === "available").map((m) => m.id),
          );

          // 断言：分发集合中的每个 id 都属于 available 集合（子集关系，Property 7）
          for (const id of captured) {
            expect(availableIds.has(id)).toBe(true);
          }

          // 对照 applyModelSelection 的纯函数结果一致（分发集合即其派生 models）
          const effective = applyModelSelection(config);
          expect(captured).toEqual(effective.models);

          return true;
        },
      ),
    );
  });

  it("applyModelSelection: available-only 直接验证子集关系（纯函数维度）", () => {
    fcAssert(
      fc.property(
        fc
          .uniqueArray(
            fc
              .string({ minLength: 1, maxLength: 6 })
              .map((s) => s.replace(/[^a-zA-Z0-9]/g, "m"))
              .filter((s) => s.length > 0),
            { minLength: 1, maxLength: 12 },
          )
          .chain((ids) =>
            fc.tuple(
              fc.constant(ids),
              fc.tuple(...ids.map((id) => modelInfoArb(id))),
            ),
          ),
        ([ids, models]) => {
          const candidateModels = models as ModelInfo[];
          const config = makeLocalConfig([...ids], candidateModels, "available-only");
          const effective = applyModelSelection(config);

          const availableIds = new Set(
            candidateModels.filter((m) => m.availability === "available").map((m) => m.id),
          );
          for (const id of effective.models) {
            expect(availableIds.has(id)).toBe(true);
          }
          return true;
        },
      ),
    );
  });
});

// ===========================================================================
// Property 11: 候选到分发的包含关系
// ===========================================================================

describe("Property 11: 候选到分发的包含关系", () => {
  it("candidateModels 非空时，分发集合每个 id 都存在于候选 id 集合", async () => {
    await fcAssertAsync(
      fc.asyncProperty(
        // 候选 id 集合（非空且唯一）
        fc.uniqueArray(
          fc
            .string({ minLength: 1, maxLength: 6 })
            .map((s) => s.replace(/[^a-zA-Z0-9]/g, "c"))
            .filter((s) => s.length > 0),
          { minLength: 1, maxLength: 10 },
        ),
        // 额外「游离」id 集合（可能不在候选中，用以验证会被剔除）
        fc.array(
          fc
            .string({ minLength: 1, maxLength: 6 })
            .map((s) => s.replace(/[^a-zA-Z0-9]/g, "x"))
            .filter((s) => s.length > 0),
          { minLength: 0, maxLength: 8 },
        ),
        // 筛选策略：all 或 available-only 都应满足「子集于候选」
        fc.constantFrom<"available-only" | "all">("available-only", "all"),
        async (candidateIds, strayIds, modelSelection) => {
          // 候选清单：每个候选 id 带随机 availability
          const candidateModels: ModelInfo[] = candidateIds.map((id) => ({
            id,
            source: "fetched",
            availability: "available", // 置为 available，避免 available-only 把全部筛空而弱化本属性
          }));

          // 已选 models = 候选 id + 游离 id（游离 id 应被剔除）
          const selected = [...candidateIds, ...strayIds];

          const { distributor, adapters } = makeDistributor(["pi"]);
          const config = makeLocalConfig(selected, candidateModels, modelSelection);
          await distributor.distribute(config, ["pi"]);

          const captured = adapters.get("pi")!.capturedModels ?? [];
          const candidateSet = new Set(candidateIds);

          // 断言：分发集合中每个 id 都在候选 id 集合内（Property 11）
          for (const id of captured) {
            expect(candidateSet.has(id)).toBe(true);
          }

          // 对照纯函数结果一致
          const effective = applyModelSelection(config);
          expect(captured).toEqual(effective.models);

          return true;
        },
      ),
    );
  });

  it("applyModelSelection: candidateModels 非空时 models 子集于候选 id（纯函数维度）", () => {
    fcAssert(
      fc.property(
        fc.uniqueArray(
          fc
            .string({ minLength: 1, maxLength: 6 })
            .map((s) => s.replace(/[^a-zA-Z0-9]/g, "c"))
            .filter((s) => s.length > 0),
          { minLength: 1, maxLength: 10 },
        ),
        fc.array(
          fc
            .string({ minLength: 1, maxLength: 6 })
            .map((s) => s.replace(/[^a-zA-Z0-9]/g, "x"))
            .filter((s) => s.length > 0),
          { minLength: 0, maxLength: 8 },
        ),
        fc.constantFrom<"available-only" | "all">("available-only", "all"),
        (candidateIds, strayIds, modelSelection) => {
          const candidateModels: ModelInfo[] = candidateIds.map((id) => ({
            id,
            source: "fetched",
            availability: "available",
          }));
          const config = makeLocalConfig(
            [...candidateIds, ...strayIds],
            candidateModels,
            modelSelection,
          );
          const effective = applyModelSelection(config);
          const candidateSet = new Set(candidateIds);
          for (const id of effective.models) {
            expect(candidateSet.has(id)).toBe(true);
          }
          return true;
        },
      ),
    );
  });
});
