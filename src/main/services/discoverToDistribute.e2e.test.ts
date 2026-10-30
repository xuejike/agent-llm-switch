// "获取→探测→筛选→分发" 端到端集成测试（任务 13.2）
//
// 本测试把「模型发现与探测」和「一键分发」两条链路真正串起来跑一遍，验证需求
// 5.1（自动获取模型清单）、6.1（探测可用性）、8.6 / 8.7（按筛选策略收敛写入集合）：
//
//   fetchModels（真实 ModelDiscovery + mock httpSend 返回固定模型清单）
//     → probeModels（真实 ModelDiscovery + mock httpSend 返回固定探测响应，
//                     覆盖 available / unavailable / unknown 三种结果）
//     → 回写 candidateModels 的 availability，并设 modelSelection="available-only"
//     → distribute（真实 Distributor + 真实 AdapterRegistry + 真实 AtomicFileWriter）
//     → 断言最终写入各 agent 配置文件的模型集合「恰为 available 子集」，
//       与筛选策略一致（对应 Property 7 / Property 11）。
//
// 端到端装配约定（尽量用真实实现，仅在「触达真实外网/真实凭据库/真实用户目录」处用替身）：
//   - ModelDiscovery：真实实现；仅注入 mock httpSend（返回固定响应，CI 不访问真实外网）。
//   - SecretStore：内存实现（InMemorySecretStore），不触达真实 OS 凭据库。
//   - Distributor：真实 DefaultDistributor。
//   - AdapterRegistry：真实 createRegisteredAdapters()（注册四个内置适配器）。
//   - AtomicFileWriter：真实 atomicFileWriter，写入系统临时目录下的唯一子目录。
//   - PlatformContext：os="linux" 且 XDG_CONFIG_HOME 指向临时目录，使各 agent 的
//     配置文件真实落在临时目录内，测试结束后整体清理。
//
// 清理约定：Windows 下文件句柄释放有延迟，fs.rm 加 maxRetries/retryDelay 增强健壮性。

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { promises as fs } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type {
  ModelInfo,
  PlatformContext,
  ProviderConfig,
} from "@shared/types";
import type { HttpRequest } from "../core/injectAuth";
import type { HttpSend, HttpResponse } from "./http";
import { ModelDiscovery } from "./modelDiscovery";
import { InMemorySecretStore } from "./secretStore";
import { DefaultDistributor } from "./distributor";
import { atomicFileWriter } from "./atomicFileWriter";
import { createAdapterRegistry, type AdapterRegistry } from "../adapters/registry";
import { OpencodeAdapter, createOpencodeMapping } from "../adapters/opencodeAdapter";
import { PiAdapter, createPiMapping } from "../adapters/piAdapter";
import { WorkbuddyAdapter, createWorkbuddyMapping } from "../adapters/workbuddyAdapter";
import { CodebuddyAdapter, createCodebuddyMapping } from "../adapters/codebuddyAdapter";

// ===========================================================================
// 固定测试数据：provider、密钥、模型清单与「每模型探测结果」预期
// ===========================================================================

/** provider 名（用于拼接 opencode 的 provider 块键名等，本测试只断言 JSON 数组型 agent） */
const PROVIDER_NAME = "openai";
/** 密钥引用与明文（仅内存 SecretStore，绝不落盘明文） */
const API_KEY_REF = "secret://openai/default";
const API_KEY_PLAINTEXT = "sk-e2e-fixed-test-key";
/** provider 的基础地址（mock httpSend 按 URL 路径分派，不真正发网络请求） */
const BASE_URL = "https://api.openai.test/v1";

/**
 * 固定模型清单：四个模型，分别覆盖三类探测结果 + 一个「候选中但探测不通过」的模型，
 * 从而让 available-only 的筛选结果成为候选集合的真子集，断言更有区分度。
 *
 * 探测判定设计（mock httpSend 据此返回）：
 * - m-ok-1 / m-ok-2 → available（探测返回 200）
 * - m-unauth        → unavailable（探测返回 401 鉴权失败）
 * - m-unknown       → unknown（探测时 mock 抛出不可判定的普通异常）
 */
const FIXED_MODEL_IDS = ["m-ok-1", "m-ok-2", "m-unauth", "m-unknown"] as const;
/** 期望最终「可用」的模型集合（available-only 筛选后应恰为此集合） */
const EXPECTED_AVAILABLE = ["m-ok-1", "m-ok-2"] as const;

// ===========================================================================
// mock httpSend：按请求 URL 路径分派「列表请求」与「探测请求」，返回固定响应
// ===========================================================================

/**
 * 构造固定响应的 mock httpSend。
 *
 * 分派规则（只看 URL 的 path，鉴权注入写在 header/query，不改变 path）：
 * - path 以 "/models" 结尾（列表端点 GET /v1/models）：返回 OpenAI 风格 { data: [{id}, ...] }，
 *   即固定模型清单（对应需求 5.1 自动获取）。
 * - path 以 "/chat/completions" 结尾（探测端点 POST）：按「请求体里的 model 字段」返回：
 *     · m-ok-1 / m-ok-2 → 200（available）
 *     · m-unauth        → 401（unavailable，鉴权失败）
 *     · m-unknown       → 抛出普通 Error（非超时、非连接错误 → ModelDiscovery 归为 unknown）
 *
 * 该实现不进行任何真实网络 I/O，保证 CI 不访问真实外网。
 */
function createMockHttpSend(): HttpSend {
  return async (req: HttpRequest): Promise<HttpResponse> => {
    const urlPath = new URL(req.url).pathname;

    // 列表端点：返回固定的候选模型清单（OpenAI 风格 data[].id）
    if (urlPath.endsWith("/models")) {
      const body = {
        data: FIXED_MODEL_IDS.map((id) => ({ id })),
      };
      return { status: 200, headers: { "content-type": "application/json" }, body, latencyMs: 5 };
    }

    // 探测端点：按请求体中的 model 字段决定返回结果
    if (urlPath.endsWith("/chat/completions")) {
      const bodyObj = (req.body ?? {}) as Record<string, unknown>;
      const model = typeof bodyObj.model === "string" ? bodyObj.model : "";

      if (model === "m-ok-1" || model === "m-ok-2") {
        // 可用：返回 2xx
        return {
          status: 200,
          headers: { "content-type": "application/json" },
          body: { ok: true },
          latencyMs: 12,
        };
      }
      if (model === "m-unauth") {
        // 不可用：鉴权失败 401
        return {
          status: 401,
          headers: { "content-type": "application/json" },
          body: { error: "unauthorized" },
          latencyMs: 8,
        };
      }
      // m-unknown：抛出不可判定的普通异常（非超时、非连接错误）→ 归类为 unknown
      throw new Error("模拟不可判定的网络异常");
    }

    // 其它未预期的端点：返回 404，便于测试快速暴露分派遗漏
    return { status: 404, headers: {}, body: "", latencyMs: 1 };
  };
}

// ===========================================================================
// 测试装配：临时目录 + PlatformContext + 真实组件
// ===========================================================================

describe("获取→探测→筛选→分发 端到端集成（任务 13.2）", () => {
  /** 本用例的临时配置根目录（作为各 agent 的 XDG_CONFIG_HOME） */
  let configHomeDir: string;

  beforeEach(async () => {
    // 在系统临时目录下创建唯一子目录，作为各 agent 配置文件的落盘根
    configHomeDir = await fs.mkdtemp(path.join(os.tmpdir(), "discover-distribute-e2e-"));
  });

  afterEach(async () => {
    // 递归清理临时目录；Windows 句柄释放有延迟，加重试增强健壮性
    await fs.rm(configHomeDir, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 });
  });

  /**
   * 构造把配置根目录指向临时目录的平台上下文（os 取真实运行平台）。
   *
   * 用真实平台而非固定 linux：各 agent 的配置模板以 ~ 开头（如 ~/.codebuddy），需按宿主平台
   * 语义展开 ~ 与平台变量；固定 linux 会以 POSIX 语义误处理 Windows 临时目录路径。homeDir 与
   * 各 home/配置根环境变量统一指向临时目录，使各 agent 配置解析到临时目录内，便于隔离与清理。
   */
  function makePlatform(): PlatformContext {
    const raw = process.platform;
    const osName: PlatformContext["os"] =
      raw === "win32" ? "win32" : raw === "darwin" ? "darwin" : "linux";
    return {
      os: osName,
      homeDir: configHomeDir,
      env: {
        USERPROFILE: configHomeDir,
        HOME: configHomeDir,
        APPDATA: configHomeDir,
        LOCALAPPDATA: configHomeDir,
        XDG_CONFIG_HOME: configHomeDir,
      },
    };
  }

  /**
   * 装配一个注册四个内置适配器的注册表，并为 detect 注入确定性探测替身。
   *
   * detect 已改为「CLI 命令（opencode/pi/codebuddy）/ 安装标志文件（workbuddy）」探测安装，
   * 为避免真实 spawn 子进程 / 读真实安装目录，这里注入恒成功的探测替身，使四个 agent 均判已安装。
   */
  function makeRegistryWithDetectStubs(): AdapterRegistry {
    const runCommand = async (): Promise<{ ok: boolean; output: string }> => ({
      ok: true,
      output: "1.0.0",
    });
    const readFile = async (): Promise<string | null> => JSON.stringify({ appVersion: "1.0.0" });
    const registry = createAdapterRegistry();
    registry.register(new OpencodeAdapter(createOpencodeMapping(PROVIDER_NAME), { runCommand }));
    registry.register(new PiAdapter(createPiMapping(PROVIDER_NAME), { runCommand }));
    registry.register(new WorkbuddyAdapter(createWorkbuddyMapping(), { readFile }));
    registry.register(new CodebuddyAdapter(createCodebuddyMapping(), { runCommand }));
    return registry;
  }

  /** 由适配器自身据平台解析各 agent 的配置文件绝对路径（与落盘路径完全一致，避免手写拼路径） */
  function agentConfigPath(registry: AdapterRegistry, agentId: string): string {
    const adapter = registry.get(agentId);
    if (!adapter) {
      throw new Error(`未知 agent：${agentId}`);
    }
    return adapter.configPath(makePlatform());
  }

  /**
   * 构造带「列表端点 + 探测端点」声明的供应商中立 ProviderConfig。
   *
   * 这是数据驱动的核心：ModelDiscovery 完全按本声明拉取（/models）与探测（/chat/completions），
   * 无需为本测试写任何特判。apiKeyRef 中立、绝不含明文。
   */
  function makeProviderConfig(overrides: Partial<ProviderConfig> = {}): ProviderConfig {
    return {
      id: "p-openai-e2e",
      name: PROVIDER_NAME,
      baseUrl: BASE_URL,
      apiKeyRef: API_KEY_REF,
      models: [],
      // 列表端点：GET /v1/models，Bearer 鉴权，OpenAI 风格 data[].id 归一化
      modelListing: {
        path: "/v1/models",
        method: "GET",
        auth: { in: "header", kind: "bearer", name: "Authorization", valueTemplate: "Bearer {key}" },
        responseMapping: { arrayPointer: "/data", idField: "id" },
      },
      // 探测端点：POST /v1/chat/completions，最小代价请求体（{model} 占位）
      modelProbe: {
        path: "/v1/chat/completions",
        method: "POST",
        auth: { in: "header", kind: "bearer", name: "Authorization", valueTemplate: "Bearer {key}" },
        bodyTemplate: { model: "{model}", messages: [{ role: "user", content: "ping" }], max_tokens: 1 },
      },
      ...overrides,
    };
  }

  /**
   * 把探测结果回写进候选清单：按 modelId 对齐更新每个候选模型的 availability
   * （以及延迟/错误/探测时间），得到一份「带可用性」的 candidateModels。
   *
   * 这一步模拟 UI 在用户点击「探测可用性」后，用探测结果刷新候选清单的真实行为。
   */
  function applyProbeResults(
    candidates: ModelInfo[],
    probeResults: Awaited<ReturnType<ModelDiscovery["probeModels"]>>,
  ): ModelInfo[] {
    const byId = new Map(probeResults.map((r) => [r.modelId, r]));
    return candidates.map((m) => {
      const r = byId.get(m.id);
      if (!r) {
        return m;
      }
      return {
        ...m,
        availability: r.availability,
        latencyMs: r.latencyMs,
        error: r.error,
        probedAt: r.probedAt,
      };
    });
  }

  /**
   * 读取并解析某个 agent 的 JSON 配置文件（路径由适配器据平台解析，与落盘一致），返回解析对象。
   *
   * @param registry 注册表（用于解析该 agent 的配置路径）
   * @param agentId  agent 唯一标识（如 "codebuddy"）
   */
  async function readAgentJson(
    registry: AdapterRegistry,
    agentId: string,
  ): Promise<Record<string, unknown>> {
    const filePath = agentConfigPath(registry, agentId);
    const text = await fs.readFile(filePath, "utf8");
    return JSON.parse(text) as Record<string, unknown>;
  }

  /** 确保父目录存在后写入 seed 配置文件（路径由适配器解析，与落盘一致） */
  async function seedAgentConfig(
    registry: AdapterRegistry,
    agentId: string,
    content: unknown,
  ): Promise<void> {
    const filePath = agentConfigPath(registry, agentId);
    await fs.mkdir(path.dirname(filePath), { recursive: true });
    await fs.writeFile(filePath, JSON.stringify(content, null, 2), "utf8");
  }

  it("端到端：fetchModels→probeModels→available-only 筛选→distribute，各 agent 写入集合恰为 available 子集", async () => {
    // --- 装配真实组件（仅 httpSend 为 mock、SecretStore 为内存） ---
    const platform = makePlatform();
    const httpSend = createMockHttpSend();

    // 内存密钥库：预存明文，供 ModelDiscovery 探测与 Distributor 写盘时解析（仅内存）
    const secretStore = new InMemorySecretStore();
    await secretStore.saveSecret(API_KEY_REF, API_KEY_PLAINTEXT);

    const discovery = new ModelDiscovery({ secretStore, httpSend });
    const registry = makeRegistryWithDetectStubs();
    const distributor = new DefaultDistributor({
      registry,
      secretStore,
      fileWriter: atomicFileWriter,
      platform,
    });

    // 选用两个「models 落在 JSON 数组」的 agent，便于直接断言写入的模型集合
    const agentIds = ["codebuddy", "workbuddy"];

    // 预置各 agent 的既有配置文件（非空，验证字段级合并只动受管字段）；安装由探测替身判定
    await seedAgentConfig(registry, "codebuddy", { keepMe: "codebuddy-preserved" });
    await seedAgentConfig(registry, "workbuddy", { keepMe: "workbuddy-preserved" });

    const provider = makeProviderConfig();

    // --- 步骤 1：fetchModels 得到固定候选清单（source="fetched"、availability="unknown"） ---
    const fetchResult = await discovery.fetchModels(provider);
    expect(fetchResult.supportsListing).toBe(true);
    expect(fetchResult.warning).toBeUndefined();
    expect(fetchResult.models.map((m) => m.id)).toEqual([...FIXED_MODEL_IDS]);
    // 刚拉取、未探测：全部 availability=unknown、source=fetched（需求 5.1）
    for (const m of fetchResult.models) {
      expect(m.source).toBe("fetched");
      expect(m.availability).toBe("unknown");
    }

    // --- 步骤 2：probeModels 探测候选清单，覆盖 available/unavailable/unknown（需求 6.1） ---
    const candidateIds = fetchResult.models.map((m) => m.id);
    const probeResults = await discovery.probeModels(provider, candidateIds);
    // 探测结果与输入一一对应、长度相等
    expect(probeResults.map((r) => r.modelId)).toEqual(candidateIds);
    const availabilityById = new Map(probeResults.map((r) => [r.modelId, r.availability]));
    expect(availabilityById.get("m-ok-1")).toBe("available");
    expect(availabilityById.get("m-ok-2")).toBe("available");
    expect(availabilityById.get("m-unauth")).toBe("unavailable");
    expect(availabilityById.get("m-unknown")).toBe("unknown");

    // --- 步骤 3：回写候选清单的可用性，设 available-only 策略，并把全部候选 id 作为「已选集合」 ---
    const candidateModels = applyProbeResults(fetchResult.models, probeResults);
    const distributeConfig: ProviderConfig = {
      ...provider,
      // 已选集合包含全部候选（含不可用/未知），交由 available-only 策略收敛
      models: [...candidateIds],
      candidateModels,
      modelSelection: "available-only",
    };

    // --- 步骤 4：distribute 写盘到各 agent 配置文件 ---
    const report = await distributor.distribute(distributeConfig, agentIds);

    // 报告完备：entries 覆盖每个 agent 一次，且全部成功
    expect(report.entries.map((e) => e.agentId).sort()).toEqual([...agentIds].sort());
    expect(report.summary).toEqual({ success: 2, failed: 0, skipped: 0 });
    for (const entry of report.entries) {
      expect(entry.status).toBe("success");
    }

    // --- 断言：最终写入各 agent 的模型集合「恰为 available 子集」，与筛选策略一致 ---
    // codebuddy：models 落在顶层 /models（JSON 数组）
    const codebuddyJson = await readAgentJson(registry, "codebuddy");
    expect(codebuddyJson.models).toEqual([...EXPECTED_AVAILABLE]);
    // 字段级合并：非受管字段原样保留
    expect(codebuddyJson.keepMe).toBe("codebuddy-preserved");
    // 受管字段 baseUrl 已写入（endpoint）
    expect(codebuddyJson.endpoint).toBe(BASE_URL);

    // workbuddy：models 落在 /model/models（JSON 数组）
    const workbuddyJson = await readAgentJson(registry, "workbuddy");
    const workbuddyModel = workbuddyJson.model as Record<string, unknown>;
    expect(workbuddyModel.models).toEqual([...EXPECTED_AVAILABLE]);
    expect(workbuddyJson.keepMe).toBe("workbuddy-preserved");
    expect(workbuddyModel.baseUrl).toBe(BASE_URL);

    // 关键一致性：写入集合是 available 集合的子集，且不含任何 unavailable/unknown 模型
    for (const agentDir of agentIds) {
      const json =
        agentDir === "codebuddy"
          ? codebuddyJson.models
          : (workbuddyJson.model as Record<string, unknown>).models;
      const written = json as string[];
      // 子集于 available（Property 7）
      for (const id of written) {
        expect(EXPECTED_AVAILABLE).toContain(id);
      }
      // 恰好等于 available 集合（本例已选集合覆盖全部候选，故交集就是全部 available）
      expect([...written].sort()).toEqual([...EXPECTED_AVAILABLE].sort());
      // 明确排除不可用/未知模型
      expect(written).not.toContain("m-unauth");
      expect(written).not.toContain("m-unknown");
    }
  });

  it("端到端：同一链路下 modelSelection=\"all\" 时写入集合为全部候选（与筛选策略一致的对照）", async () => {
    // 对照用例：相同的获取→探测结果，但策略改为 all，写入集合应为全部候选 id
    // （验证筛选策略切换会如实改变最终写入集合，锚定「写入集合与策略一致」这一断言）。
    const platform = makePlatform();
    const httpSend = createMockHttpSend();
    const secretStore = new InMemorySecretStore();
    await secretStore.saveSecret(API_KEY_REF, API_KEY_PLAINTEXT);

    const discovery = new ModelDiscovery({ secretStore, httpSend });
    const registry = makeRegistryWithDetectStubs();
    const distributor = new DefaultDistributor({
      registry,
      secretStore,
      fileWriter: atomicFileWriter,
      platform,
    });

    const agentIds = ["codebuddy"];
    await seedAgentConfig(registry, "codebuddy", {});

    const provider = makeProviderConfig();
    const fetchResult = await discovery.fetchModels(provider);
    const candidateIds = fetchResult.models.map((m) => m.id);
    const probeResults = await discovery.probeModels(provider, candidateIds);
    const candidateModels = applyProbeResults(fetchResult.models, probeResults);

    const distributeConfig: ProviderConfig = {
      ...provider,
      models: [...candidateIds],
      candidateModels,
      // all：不要求探测通过，写入集合为全部已选（受候选 id 约束，本例已选即全部候选）
      modelSelection: "all",
    };

    const report = await distributor.distribute(distributeConfig, agentIds);
    expect(report.summary).toEqual({ success: 1, failed: 0, skipped: 0 });

    const codebuddyJson = await readAgentJson(registry, "codebuddy");
    // all 策略：写入集合为全部候选 id（含不可用/未知），与策略一致
    expect([...(codebuddyJson.models as string[])].sort()).toEqual([...FIXED_MODEL_IDS].sort());
  });
});
