// 分发编排器（Distributor）
//
// 本模块实现 design.md 组件 3 的 Distributor：编排一次分发的完整流程，对每个启用的
// agent 依次执行「探测安装 → 解析密钥 → 字段级合并渲染 → 备份 → 原子写入 →（失败时）
// 回滚」，并把每个 agent 的结果汇总为一份 ApplyReport。预览流程（preview）走相同的
// detect + render，但不写盘，只回传掩码后的差异供 UI 展示。
//
// 关键设计约束（对应需求 8.3 / 8.4 / 8.5 / 8.6 / 8.7、10.3 / 10.4 / 10.5、11.1~11.5）：
//   1. 故障隔离：单个 agent 的任何失败（密钥解析失败、既有文件损坏、凭据引用目标写入
//      失败、原子写入失败）都只影响该 agent 自身——被标记为 failed 并回滚其局部改动，
//      绝不中断或影响其它 agent 的处理（需求 11.4 / 11.5）。
//   2. 跳过未安装：detect 判定未安装的 agent 标记为 skipped、记录原因、不写任何文件
//      （需求 8.5）。
//   3. 写盘前校验密钥：非「无鉴权/本地」场景下，若 SecretStore 无法解析 apiKeyRef 对应
//      的明文，则在进入写盘阶段前即判定该 agent 失败（failed），不进行任何文件写入
//      （需求 10.5）。无鉴权/本地场景（isLocal 或 apiKeyRef 为空）允许明文为空串继续。
//   4. 既有文件损坏：render 解析既有内容失败时该 agent 标记为 failed、提示格式异常，
//      且不覆盖原文件（需求 10.4）——render 抛错发生在写盘之前，天然不触碰磁盘。
//   5. 模型筛选：分发/预览前按 ProviderConfig 的 modelSelection 与 candidateModels 对
//      「写入集合 models」做收敛（需求 8.6 / 8.7），得到一份派生的 ProviderConfig 再交给
//      适配器 render，不改动调用方传入的原 config。
//   6. 报告完备：ApplyReport.entries 恰好覆盖请求中的每个 agentId 一次，summary 三类
//      计数之和等于 entries 长度（需求 11.1）。
//
// 密钥安全约束（对应需求 2.8 / Property 1）：
//   - 明文 apiKey 仅在本模块内存中短暂存在并传给 render；
//   - 回传渲染进程的 PreviewResult.maskedDiff 与 ApplyReport 均不含明文（maskedDiff 由
//     render 内部掩码保证）。
//
// 依赖可注入：AdapterRegistry / SecretStore / AtomicFileWriter / PlatformContext /
// RenderDeps 全部经构造函数注入，便于主进程装配与单元/属性测试替身化。

import type {
  ApplyEntry,
  ApplyReport,
  ModelInfo,
  PlatformContext,
  PreviewResult,
  ProviderConfig,
} from "@shared/types";
import type { AdapterRegistry } from "../adapters/registry";
import type { SecretStore } from "./secretStore";
import { SecretStoreError } from "./secretStore";
import type { AtomicFileWriter } from "./atomicFileWriter";
import type { RenderDeps } from "../core/render";

/**
 * 分发编排器接口（参照 design.md 组件 3）。
 *
 * 两个入口共享「按 agent 迭代 + detect + render」的核心，但 preview 不写盘、distribute 写盘。
 */
export interface Distributor {
  /** 仅预览：对启用的 agent 生成合并结果与掩码差异，不写盘 */
  preview(config: ProviderConfig, agentIds: string[]): Promise<PreviewResult[]>;
  /** 执行分发：对每个 agent 写盘并返回汇总报告 */
  distribute(config: ProviderConfig, agentIds: string[]): Promise<ApplyReport>;
}

/**
 * Distributor 的可注入依赖集合。
 *
 * 之所以全部可注入：主进程启动时按运行环境装配真实实现（已注册适配器注册表、safeStorage
 * 密钥服务、基于 fs 的原子写入器、从 process 读取的平台上下文），而测试注入替身以覆盖
 * 「未安装 / 密钥不存在 / 既有文件损坏 / 凭据目标写入失败 / 原子写入失败」等异常路径，
 * 且绝不触达真实文件系统与 OS 凭据库。
 */
export interface DistributorDeps {
  /** 适配器注册表：按 agentId 查询对应的 AgentAdapter */
  registry: AdapterRegistry;
  /** 密钥服务：按 apiKeyRef 解析明文（仅主进程内存使用，绝不回传渲染进程） */
  secretStore: SecretStore;
  /** 安全文件写入器：备份 / 原子写入 / 回滚 */
  fileWriter: AtomicFileWriter;
  /** 当前运行平台上下文：供适配器 detect / configPath 解析配置文件路径 */
  platform: PlatformContext;
  /**
   * render 的可注入依赖（凭据 env/secrets-file 落地与 transform 钩子解析器）；
   * 透传给各适配器的 render。缺省使用面向生产的默认实现。
   */
  renderDeps?: RenderDeps;
  /**
   * 可选：读取既有配置文件原始文本的依赖（便于测试注入内存文件系统）。
   * 返回文件文本；文件不存在返回 null。缺省基于 node fs/promises 的 readFile。
   */
  readExisting?: ReadExistingFile;
}

/**
 * 既有配置文件读取的可注入依赖。
 *
 * render 需要既有文件内容以做字段级合并（保留非受管字段）。把这一步抽象为可注入接口，
 * 便于测试在不碰真实文件系统的前提下提供既有内容或模拟「文件不存在」。
 */
export interface ReadExistingFile {
  /**
   * 读取给定绝对路径的文件原始文本。
   * @param absolutePath 已解析的配置文件绝对路径
   * @returns 文件文本；文件不存在返回 null
   */
  (absolutePath: string): Promise<string | null>;
}

/**
 * 默认既有文件读取实现：基于 node fs/promises 的 readFile，文件不存在时返回 null。
 *
 * 延迟到调用时再引入 node:fs/promises，避免在不需要读取的路径上产生依赖。
 */
const defaultReadExisting: ReadExistingFile = async (
  absolutePath: string,
): Promise<string | null> => {
  const { readFile } = await import("node:fs/promises");
  try {
    return await readFile(absolutePath, "utf8");
  } catch (error) {
    // ENOENT（文件不存在）是预期分支：返回 null，render 据此以空对象起步
    if (isNotFoundError(error)) {
      return null;
    }
    // 其它错误（权限不足等）属真实故障，向上抛出交由分发流程归为该 agent failed
    throw error;
  }
};

/**
 * 判断错误是否为「文件不存在」（ENOENT）。
 *
 * @param error 捕获到的异常
 * @returns 表示目标不存在时返回 true
 */
function isNotFoundError(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    (error as NodeJS.ErrnoException).code === "ENOENT"
  );
}

/**
 * Distributor 的默认实现。
 *
 * 持有一组可注入依赖，无跨调用的可变状态；preview/distribute 彼此独立，可并发调用。
 */
export class DefaultDistributor implements Distributor {
  private readonly deps: DistributorDeps;

  /**
   * @param deps 可注入依赖集合（注册表 / 密钥服务 / 文件写入器 / 平台上下文 / render 依赖等）
   */
  constructor(deps: DistributorDeps) {
    this.deps = deps;
  }

  /**
   * 预览：对每个请求的 agent 生成合并结果与掩码差异，但不写入磁盘。
   *
   * 流程（对应需求 8.4 与预览时序图）：对每个 agentId 解析适配器 → detect → 读既有内容 →
   * render（含掩码 diff）。本流程只读不写：未找到适配器、未安装、密钥无法解析（非无鉴权）、
   * 既有文件损坏等异常都收敛为该 agent 的一条 PreviewResult（installed 反映真实探测结果，
   * maskedDiff 承载可用的差异或贴切的错误说明），绝不抛出以免一个 agent 影响整体预览。
   *
   * @param config   供应商中立的 Provider 配置（写入集合会按模型筛选规则派生）
   * @param agentIds 需要预览的 agent id 列表
   * @returns 每个 agent 一条 PreviewResult（不含明文密钥）
   */
  async preview(config: ProviderConfig, agentIds: string[]): Promise<PreviewResult[]> {
    // 先按模型筛选规则派生「写入集合」，预览与分发看到一致的 models（需求 8.6 / 8.7）
    const effectiveConfig = applyModelSelection(config);

    const results: PreviewResult[] = [];
    for (const agentId of agentIds) {
      results.push(await this.previewOne(agentId, effectiveConfig));
    }
    return results;
  }

  /**
   * 执行分发：对每个请求的 agent 依次写盘并汇总为 ApplyReport。
   *
   * 流程（对应主流程时序图与需求 11.x）：对每个 agentId 解析适配器 → detect → 若未安装则
   * skipped → 否则解析密钥（非无鉴权场景解析失败即 failed、不写盘）→ 读既有内容 → render
   * （既有损坏/凭据目标写入失败 → failed、不写盘）→ 适配器 apply（备份+原子写入+失败回滚）。
   * 每个 agent 的处理相互隔离：任何单点失败只产生该 agent 的一条 failed/skipped 记录，
   * 循环继续处理后续 agent（需求 11.4 / 11.5）。
   *
   * @param config   供应商中立的 Provider 配置（写入集合会按模型筛选规则派生）
   * @param agentIds 需要分发的 agent id 列表
   * @returns ApplyReport：entries 恰好覆盖每个 agentId 一次，summary 计数之和等于 entries 长度
   */
  async distribute(config: ProviderConfig, agentIds: string[]): Promise<ApplyReport> {
    // 派生写入集合（需求 8.6 / 8.7）；不改动调用方传入的原 config
    const effectiveConfig = applyModelSelection(config);

    const entries: ApplyEntry[] = [];
    for (const agentId of agentIds) {
      // 单个 agent 的处理完全隔离：distributeOne 内部已把所有异常收敛为一条 ApplyEntry，
      // 故此处无需 try/catch 兜底，循环保证后续 agent 不受前者失败影响（需求 11.4）
      entries.push(await this.distributeOne(agentId, effectiveConfig));
    }

    return buildReport(entries);
  }

  // =========================================================================
  // 单 agent 处理：preview / distribute 各一条路径，复用密钥解析与适配器定位
  // =========================================================================

  /**
   * 预览单个 agent：解析适配器 → detect → 读既有 → render，产出一条 PreviewResult。
   *
   * 预览只读不写，任何异常都被收敛为可读的 maskedDiff 说明，并如实反映 installed 状态，
   * 使 UI 能同时呈现「可预览的 agent」与「无法预览及其原因的 agent」。
   *
   * @param agentId 目标 agent id
   * @param config  已完成模型筛选派生的 Provider 配置
   * @returns 该 agent 的 PreviewResult
   */
  private async previewOne(agentId: string, config: ProviderConfig): Promise<PreviewResult> {
    const adapter = this.deps.registry.get(agentId);
    if (!adapter) {
      // 未注册适配器：无法定位配置文件，给出空路径与说明，installed=false
      return {
        agentId,
        configPath: "",
        installed: false,
        maskedDiff: `未找到 agent "${agentId}" 的适配器，无法预览`,
      };
    }

    const detect = await adapter.detect(this.deps.platform);

    // 未安装：预览无合并内容，仅反映探测结果（与分发的 skipped 对应）
    if (!detect.installed) {
      return {
        agentId,
        configPath: detect.configPath,
        installed: false,
        maskedDiff: "该 agent 未安装（未发现配置文件），分发时将跳过",
      };
    }

    try {
      // 解析密钥：非无鉴权场景解析失败将抛出，收敛为预览错误说明
      const apiKey = await this.resolveApiKey(config);
      // 读既有内容（供字段级合并保留非受管字段）
      const existing = await this.readExisting(detect.configPath);
      // render 产出掩码 diff（内部保证不含明文）
      const rendered = adapter.render(config, apiKey, existing);
      return {
        agentId,
        configPath: detect.configPath,
        installed: true,
        maskedDiff: rendered.maskedDiff,
      };
    } catch (error) {
      // 既有文件损坏 / 密钥无法解析 / 凭据目标写入失败等：预览阶段如实呈现原因，不写盘
      return {
        agentId,
        configPath: detect.configPath,
        installed: true,
        maskedDiff: `无法生成预览：${describeError(error)}`,
      };
    }
  }

  /**
   * 分发单个 agent：解析适配器 → detect → 解析密钥 → 读既有 → render → apply，产出一条 ApplyEntry。
   *
   * 本方法把该 agent 的所有失败点收敛为 failed/skipped 的 ApplyEntry，从不向上抛出，
   * 从而保证 distribute 循环中各 agent 相互隔离（需求 11.4 / 11.5）。写盘前的失败
   * （密钥解析、既有损坏、凭据目标写入）均不触碰磁盘；写盘中的失败由适配器 apply 内的
   * 「备份 → 原子写入 → 失败回滚」保证不留半写文件（需求 10.3）。
   *
   * @param agentId 目标 agent id
   * @param config  已完成模型筛选派生的 Provider 配置
   * @returns 该 agent 的 ApplyEntry（success / failed / skipped）
   */
  private async distributeOne(agentId: string, config: ProviderConfig): Promise<ApplyEntry> {
    const adapter = this.deps.registry.get(agentId);
    if (!adapter) {
      // 未注册适配器：无法分发，记为 failed 并说明原因（计入报告，保持 entries 覆盖）
      return {
        agentId,
        status: "failed",
        message: `未找到 agent "${agentId}" 的适配器`,
      };
    }

    // 1. 探测安装与配置文件状态
    let configPath: string;
    try {
      const detect = await adapter.detect(this.deps.platform);
      // 2. 未安装 → skipped，不写任何文件（需求 8.5）
      if (!detect.installed) {
        return {
          agentId,
          status: "skipped",
          message: "未安装（未发现配置文件），已跳过",
        };
      }
      configPath = detect.configPath;
    } catch (error) {
      // 探测本身失败（如路径解析/文件访问异常）：隔离为该 agent failed
      return {
        agentId,
        status: "failed",
        message: `探测失败：${describeError(error)}`,
      };
    }

    // 3. 写盘前解析密钥：非无鉴权场景解析失败即判 failed、不进入写盘（需求 10.5）
    let apiKey: string;
    try {
      apiKey = await this.resolveApiKey(config);
    } catch (error) {
      return {
        agentId,
        status: "failed",
        message: describeSecretError(error),
      };
    }

    // 4. 读既有内容并 render：既有文件损坏 / 凭据引用目标写入失败在此抛出，
    //    发生在写盘之前，天然不覆盖原文件（需求 10.4 / 11.5）
    let rendered;
    try {
      const existing = await this.readExisting(configPath);
      rendered = adapter.render(config, apiKey, existing);
    } catch (error) {
      return {
        agentId,
        status: "failed",
        message: `渲染失败（不覆盖原文件）：${describeError(error)}`,
      };
    }

    // 5. 应用：经 AtomicFileWriter 备份 + 原子写入 + 失败回滚，返回该 agent 的结果。
    //    适配器 apply 内部已捕获写入异常并回滚，返回 failed 的 ApplyEntry，不会抛出。
    try {
      return await adapter.apply(configPath, rendered, this.deps.fileWriter);
    } catch (error) {
      // 兜底：即便 apply 以外的意外抛出，也隔离为该 agent failed，不影响其它 agent
      return {
        agentId,
        status: "failed",
        message: `写入失败：${describeError(error)}`,
      };
    }
  }

  /**
   * 解析分发所需的明文密钥，区分「无鉴权/本地」与「需要鉴权」两类场景。
   *
   * 判定（对应需求 10.5 与需求 13 的本地放宽）：
   * - 无鉴权/本地场景（config.isLocal 为 true，或 apiKeyRef 为空/纯空白）：允许无密钥，
   *   返回空串，render 据此跳过凭据注入；
   * - 需要鉴权场景（apiKeyRef 非空且非本地）：经 SecretStore 解析明文；解析失败（不存在/
   *   存储读取失败）将抛出，由调用方在写盘前判定该 agent failed。
   *
   * @param config Provider 配置
   * @returns 明文密钥；无鉴权/本地场景为空串
   * @throws SecretStoreError 需要鉴权但密钥无法解析（code=not_found / storage_failure）
   */
  private async resolveApiKey(config: ProviderConfig): Promise<string> {
    const ref = config.apiKeyRef?.trim() ?? "";
    // 本地/无鉴权或未配置引用：允许空密钥继续（render 跳过凭据注入）
    if (config.isLocal === true || ref === "") {
      return "";
    }
    // 需要鉴权：解析明文（仅内存使用）；不存在/读取失败会抛出 SecretStoreError
    return this.deps.secretStore.resolveSecret(ref);
  }

  /**
   * 读取既有配置文件文本（经可注入依赖，缺省基于 node fs/promises）。
   *
   * @param configPath 已解析的配置文件绝对路径
   * @returns 文件文本；不存在返回 null
   */
  private async readExisting(configPath: string): Promise<string | null> {
    const reader = this.deps.readExisting ?? defaultReadExisting;
    return reader(configPath);
  }
}

// ===========================================================================
// 模型筛选：按 modelSelection / candidateModels 收敛「写入集合 models」
// ===========================================================================

/**
 * 依据 ProviderConfig 的模型筛选策略派生「写入各 agent 的 models 集合」。
 *
 * 规则（对应需求 8.6 / 8.7、Property 7 / Property 11）：
 * 1. modelSelection === "available-only"：写入集合为 candidateModels 中 availability 为
 *    "available" 的模型 id 集合的子集——取「原 models 与 available 集合」的交集，确保
 *    只分发真正可用的模型（Property 7）。
 * 2. candidateModels 非空：无论策略如何，写入集合 models 中的每个 id 都必须存在于
 *    candidateModels 的 id 集合中——取「原 models 与候选 id 集合」的交集，剔除不在候选
 *    清单中的游离 id（Property 11）。
 *
 * 为保持「交集」语义与原顺序，本函数以原 config.models 为基准做过滤（而非从候选清单重排），
 * 从而天然满足「写入集合是相应集合的子集」。对调用方传入的 config 不做任何原地修改，
 * 返回一份仅 models 可能不同的浅拷贝派生配置。
 *
 * @param config 原始 Provider 配置（不被修改）
 * @returns 写入集合已按规则收敛的派生 Provider 配置
 */
export function applyModelSelection(config: ProviderConfig): ProviderConfig {
  const candidates: ModelInfo[] = config.candidateModels ?? [];
  const hasCandidates = candidates.length > 0;
  const availableOnly = config.modelSelection === "available-only";

  // 两条规则都不触发时，写入集合与原 models 一致，直接返回原 config（避免无谓拷贝）
  if (!hasCandidates && !availableOnly) {
    return config;
  }

  // 候选清单的全部 id 集合（用于 Property 11 的「子集于候选 id」约束）
  const candidateIds = new Set(candidates.map((m) => m.id));
  // 候选清单中 available 的 id 集合（用于 Property 7 的「子集于 available」约束）
  const availableIds = new Set(
    candidates.filter((m) => m.availability === "available").map((m) => m.id),
  );

  const filtered = (config.models ?? []).filter((id) => {
    // available-only：必须落在 available 集合内（available 集合本身即候选子集，
    // 故该分支同时满足 Property 11 的候选约束）
    if (availableOnly) {
      return availableIds.has(id);
    }
    // 否则仅在候选清单非空时要求落在候选 id 集合内；候选为空则不额外约束
    return hasCandidates ? candidateIds.has(id) : true;
  });

  // 仅覆盖 models 字段，其余字段（含 apiKeyRef/baseUrl 等）原样保留
  return { ...config, models: filtered };
}

// ===========================================================================
// 报告汇总与错误描述
// ===========================================================================

/**
 * 把逐 agent 的 ApplyEntry 列表汇总为 ApplyReport。
 *
 * 保证（对应需求 11.1 / Property 4）：entries 原样保留（恰好覆盖每个请求 agentId 一次，
 * 由调用方的循环保证），summary 的 success/failed/skipped 三类计数之和等于 entries 长度。
 *
 * @param entries 逐 agent 的分发结果
 * @returns 带时间戳与汇总计数的 ApplyReport
 */
function buildReport(entries: ApplyEntry[]): ApplyReport {
  const summary = { success: 0, failed: 0, skipped: 0 };
  for (const entry of entries) {
    // 按状态累加对应计数；三类穷尽覆盖 ApplyEntry.status 的全部取值
    summary[entry.status] += 1;
  }
  return {
    timestamp: new Date().toISOString(),
    entries,
    summary,
  };
}

/**
 * 把密钥解析错误转为贴切、可操作的提示（对应需求 10.5：提示重新录入密钥）。
 *
 * 对 SecretStoreError 按语义码给出中文说明，其它错误回退到通用描述。消息中绝不包含明文。
 *
 * @param error 捕获到的异常
 * @returns 面向用户的中文错误描述
 */
function describeSecretError(error: unknown): string {
  if (error instanceof SecretStoreError) {
    if (error.code === "not_found") {
      return "无法解析 API Key：对应密钥不存在，请重新录入密钥后再分发";
    }
    return "无法解析 API Key：读取凭据存储失败，请重试或重新录入密钥";
  }
  return `无法解析 API Key：${describeError(error)}`;
}

/**
 * 把未知错误对象转为可读字符串，避免在消息中泄露意外结构或明文。
 *
 * @param error 捕获到的异常
 * @returns 可读的错误描述
 */
function describeError(error: unknown): string {
  if (error instanceof Error) {
    return error.message;
  }
  return String(error);
}

/**
 * 便捷工厂：基于可注入依赖构造默认 Distributor。
 *
 * 主进程/IPC 层装配时调用：传入已注册适配器的注册表、密钥服务、原子写入器与平台上下文，
 * 即可获得一个可直接服务 preview/distribute 的 Distributor。
 *
 * @param deps 可注入依赖集合
 * @returns Distributor 实例
 */
export function createDistributor(deps: DistributorDeps): Distributor {
  return new DefaultDistributor(deps);
}
