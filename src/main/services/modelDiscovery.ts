// 模型发现与探测服务（ModelDiscovery）
//
// 本模块位于主进程，负责「基于 API 自动获取模型清单」与「探测模型可用性」两类能力
// （对应 design.md 组件 8）。本任务（6.2）只实现 fetchModels（数据驱动的模型拉取与
// 归一化）；probeModel / probeModels 的探测能力在同一个类里预留签名占位，由任务 6.3
// 接入（见文件末尾 TODO）。
//
// 设计与安全约束（务必遵守，对应需求 5.x / 7.x / 13.x 与 Property 8/9/12）：
// - 依赖全部可注入：SecretStore（解析明文密钥）、HttpSend（发送只读请求）、
//   injectAuth（按 provider 声明把密钥注入请求）。这既保证主进程内清晰的装配，
//   也保证测试绝不访问真实外网与真实 OS 凭据库。
// - 明文密钥只在主进程内存中短暂存在：解析后仅用于构造请求，用后即弃；
//   回传给调用方（最终经 IPC 到渲染进程）的结果**绝不含明文密钥**。
// - 对 provider 远端只做**只读** GET 访问，不产生任何本地或远端配置副作用。
// - 无鉴权本地 provider（auth.in="none" / kind="none" 或 provider.isLocal）**不解析密钥**：
//   既不调用 SecretStore.resolveSecret，也不因 apiKeyRef 为空而失败，请求也不含鉴权头/查询。
// - 数据驱动：拉取路径、方法、鉴权注入与响应归一化全部来自 provider 的 ModelListingConfig
//   声明；新增 provider 只需补一份声明，核心引擎不改（对应 Property 13）。

import type {
  FetchModelsResult,
  ModelInfo,
  ModelListingConfig,
  ModelProbeConfig,
  ModelProbeResult,
  ProbeOptions,
  ProviderConfig,
} from "@shared/types";

import { getByPointer } from "../core/pointer";
import { injectAuth, type HttpRequest } from "../core/injectAuth";
import type { HttpSend } from "./http";
import type { SecretStore } from "./secretStore";

// ===========================================================================
// 可注入依赖与常量
// ===========================================================================

/**
 * ModelDiscovery 的可注入依赖集合。
 *
 * 之所以全部依赖注入而非在模块内硬编码：
 * - SecretStore：解析 apiKeyRef 为明文；测试注入内存实现，不触达真实凭据库。
 * - HttpSend：发送 HTTP 请求；测试注入 mock，CI 不访问真实外网。
 * - injectAuth：按 AuthInjection 声明把密钥注入请求；默认取本仓库实现，
 *   允许覆盖以便单测校验「注入了什么」或注入 SigV4 等特例适配器。
 */
export interface ModelDiscoveryDeps {
  /** 密钥服务：按 apiKeyRef 解析明文（仅主进程内存使用） */
  secretStore: SecretStore;
  /** HTTP 发送实现：生产用基于 fetch 的默认实现，测试注入 mock */
  httpSend: HttpSend;
  /**
   * 鉴权注入函数（可选，默认取 core/injectAuth 的 injectAuth）。
   * 允许注入便于在单测中断言注入行为，或装配 SigV4 签名适配器等特例。
   */
  injectAuthFn?: typeof injectAuth;
}

/** fetchModels 默认超时（毫秒）：provider 未声明 timeoutMs 时兜底，避免长时间阻塞 */
const DEFAULT_FETCH_TIMEOUT_MS = 10_000;

/** probeModel 默认单模型探测超时（毫秒）：options 未声明 timeoutMs 时兜底 */
const DEFAULT_PROBE_TIMEOUT_MS = 8_000;

/** probeModels 默认并发上限：options 未声明 concurrency 时兜底 */
const DEFAULT_PROBE_CONCURRENCY = 4;

// ===========================================================================
// 小工具（纯函数）
// ===========================================================================

/**
 * 拼接 baseUrl 与端点相对路径为完整 URL。
 *
 * 容错处理：
 * - path 缺省或为空 → 直接返回 baseUrl（理论上缺省 path 已在上层短路，这里兜底）。
 * - 去重连接处的斜杠，避免出现 "host//v1/models" 这类双斜杠。
 */
function joinUrl(baseUrl: string, path?: string): string {
  if (!path) {
    return baseUrl;
  }
  // 去掉 baseUrl 末尾斜杠与 path 开头斜杠后，用单个 "/" 连接
  const trimmedBase = baseUrl.replace(/\/+$/, "");
  const trimmedPath = path.replace(/^\/+/, "");
  return `${trimmedBase}/${trimmedPath}`;
}

/**
 * 判定 HTTP 状态码是否为成功（2xx）。
 */
function isSuccessStatus(status: number): boolean {
  return status >= 200 && status < 300;
}

/**
 * 判定该 provider 的模型列表拉取是否「无鉴权」。
 *
 * 无鉴权判定（对应需求 7.3 / Property 12）：auth.in="none" 或 kind="none"，或 provider 标记
 * 为本地（isLocal）。此时**不解析也不要求**密钥：既不调用 SecretStore，也不因 apiKeyRef 空而失败。
 */
function isNoAuthListing(provider: ProviderConfig, cfg: ModelListingConfig): boolean {
  if (provider.isLocal === true) {
    return true;
  }
  return cfg.auth.in === "none" || cfg.auth.kind === "none";
}

/**
 * 判定该 provider 的探测是否「无鉴权」（规则与列表拉取一致）。
 *
 * 无鉴权判定（对应需求 7.3 / Property 12）：provider.isLocal，或探测端点声明
 * auth.in="none" / kind="none"。此时**不解析也不要求**密钥。
 */
function isNoAuthProbe(provider: ProviderConfig, cfg: ModelProbeConfig): boolean {
  if (provider.isLocal === true) {
    return true;
  }
  return cfg.auth.in === "none" || cfg.auth.kind === "none";
}

/**
 * 判定一个传输层错误是否为「超时」。
 *
 * 之所以同时看多种信号：超时在不同实现下表现不一——
 * - 本仓库 http.ts 默认实现超时时抛出消息含「超时」字样的 Error；
 * - 基于 AbortController 的实现常抛 name="AbortError"/"TimeoutError" 的错误；
 * - 某些运行时用 code="ETIMEDOUT" 表达。
 * 这里把这些信号统一识别为超时，保证超时一律归类为 unavailable + "超时"。
 */
function isTimeoutError(err: unknown): boolean {
  if (!(err instanceof Error)) {
    return false;
  }
  const name = err.name;
  if (name === "TimeoutError" || name === "AbortError") {
    return true;
  }
  // Node 风格错误码（如 ETIMEDOUT）与中文/英文消息关键字兜底识别
  const code = (err as { code?: unknown }).code;
  if (code === "ETIMEDOUT") {
    return true;
  }
  const message = err.message ?? "";
  return message.includes("超时") || message.toLowerCase().includes("timeout");
}

/**
 * 判定一个传输层错误是否为「连接错误」（服务未启动/端口未监听/主机不可达）。
 *
 * 对应 design.md 场景 10：本地/自托管 provider 连接被拒绝（ECONNREFUSED）、主机不可达
 * （EHOSTUNREACH）或端口未监听时，应识别为**连接错误**并归类为 unavailable，
 * 给出可读的连接错误信息，**绝不**提示鉴权失败（本地多为无鉴权，误导无意义）。
 */
function isConnectionError(err: unknown): boolean {
  if (!(err instanceof Error)) {
    return false;
  }
  const code = (err as { code?: unknown }).code;
  if (
    code === "ECONNREFUSED" ||
    code === "EHOSTUNREACH" ||
    code === "ENOTFOUND" ||
    code === "ECONNRESET"
  ) {
    return true;
  }
  // fetch/undici 常把底层连接错误包进 cause，这里顺带检查 cause 的 code
  const causeCode = (err as { cause?: { code?: unknown } }).cause?.code;
  if (
    causeCode === "ECONNREFUSED" ||
    causeCode === "EHOSTUNREACH" ||
    causeCode === "ENOTFOUND" ||
    causeCode === "ECONNRESET"
  ) {
    return true;
  }
  // 消息关键字兜底（部分实现只在消息里体现连接被拒绝）
  const message = err.message ?? "";
  return (
    message.includes("ECONNREFUSED") ||
    message.includes("EHOSTUNREACH") ||
    message.includes("连接被拒绝") ||
    message.includes("ECONNRESET")
  );
}

/**
 * 以 bodyTemplate 为模板，用 { model: modelId } 展开最小代价探测请求体。
 *
 * 递归替换模板中所有字符串值里的 {model} 占位符（如 { model: "{model}" } → { model: "gpt-4o" }）。
 * 不修改原模板对象（返回深拷贝后的结果），避免跨模型探测相互污染。
 */
function renderProbeBody(
  bodyTemplate: Record<string, unknown> | undefined,
  modelId: string,
): Record<string, unknown> | undefined {
  if (!bodyTemplate) {
    return undefined;
  }
  const replaceInValue = (value: unknown): unknown => {
    if (typeof value === "string") {
      return value.split("{model}").join(modelId);
    }
    if (Array.isArray(value)) {
      return value.map(replaceInValue);
    }
    if (value !== null && typeof value === "object") {
      const out: Record<string, unknown> = {};
      for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
        out[k] = replaceInValue(v);
      }
      return out;
    }
    return value;
  };
  return replaceInValue(bodyTemplate) as Record<string, unknown>;
}

/**
 * 判定探测返回的 HTTP 状态码是否命中「可用」集合。
 *
 * availableStatuses 显式声明时以其为准；缺省时按 2xx 判定。
 */
function isProbeAvailable(status: number, availableStatuses?: number[]): boolean {
  if (availableStatuses && availableStatuses.length > 0) {
    return availableStatuses.includes(status);
  }
  return isSuccessStatus(status);
}

// ===========================================================================
// ModelDiscovery 实现
// ===========================================================================

/**
 * 模型发现与探测服务实现（对应 design.md 组件 8）。
 *
 * 本任务（6.2）实现 fetchModels；probeModel / probeModels 在类内预留签名占位，
 * 由任务 6.3 在同一个类里补齐实现（复用同一套注入依赖）。
 */
export class ModelDiscovery {
  private readonly secretStore: SecretStore;
  private readonly httpSend: HttpSend;
  private readonly injectAuthFn: typeof injectAuth;

  constructor(deps: ModelDiscoveryDeps) {
    this.secretStore = deps.secretStore;
    this.httpSend = deps.httpSend;
    // 缺省取本仓库的 injectAuth；注入点便于测试与 SigV4 特例装配
    this.injectAuthFn = deps.injectAuthFn ?? injectAuth;
  }

  /**
   * 拉取某 provider 当前可用的模型清单（数据驱动归一化）。
   *
   * 流程（对应 design.md「模型拉取算法 fetchModels」伪代码与需求 5.1~5.6/7.1~7.3/13.2~13.3）：
   * 1. provider 无 modelListing → 返回 { supportsListing:false, models:[] } 且**不发任何请求**
   *    （场景 9：provider 不支持列表 API，UI 回退手动输入）。
   * 2. 否则按声明构造请求：拼 URL、注入鉴权（无鉴权本地 provider 不解析密钥）。
   * 3. httpSend 只读 GET；按状态码分类：
   *    - 401/403 → supportsListing:true + 空清单 + 鉴权失败 warning（场景 7）。
   *    - 其它非 2xx → supportsListing:true + 空清单 + 「端点返回 N」warning。
   * 4. 成功则按 responseMapping 定位模型数组、取 idField、去重，归一化为
   *    ModelInfo[]（source="fetched"、availability="unknown"）。
   *    数组定位落空或非数组 → supportsListing:true + 空清单 + 「响应格式非预期」warning。
   * 5. 传输层异常（不可达/连接被拒绝/超时等）被捕获为带 warning 的结果而**不抛出**
   *    到渲染进程（场景 6 / 场景 10）。
   *
   * @param provider 统一 Provider 配置（含 apiKeyRef 与可选的 modelListing 声明）
   * @returns FetchModelsResult；结果中**不含明文密钥**
   * @remarks 仅做只读请求，不写任何本地或远端配置
   */
  async fetchModels(provider: ProviderConfig): Promise<FetchModelsResult> {
    const cfg = provider.modelListing;

    // 1) 无 modelListing：该 provider 不支持列表 API，直接回退手动输入，绝不发请求
    if (!cfg) {
      return { supportsListing: false, models: [] };
    }

    // 2) 解析明文密钥：仅在需要鉴权时解析；无鉴权本地 provider 不读取也不要求密钥
    let apiKey: string | undefined;
    if (!isNoAuthListing(provider, cfg)) {
      try {
        apiKey = await this.secretStore.resolveSecret(provider.apiKeyRef);
      } catch (err) {
        // 密钥无法解析（不存在/后端读取失败）：按「鉴权前置失败」返回带 warning 的空清单，
        // 不抛出到渲染进程；supportsListing 仍为 true（provider 声明了列表端点）。
        const message = err instanceof Error ? err.message : String(err);
        return { supportsListing: true, models: [], warning: `无法解析密钥：${message}` };
      }
    }

    // 3) 构造只读请求：按声明拼 URL、方法（默认 GET），注入鉴权（含 extraHeaders）
    const url = joinUrl(provider.baseUrl, cfg.path);
    const req: HttpRequest = {
      url,
      method: cfg.method ?? "GET",
      headers: {},
    };
    // injectAuth 内部按 auth.in/kind 分派：none 不注入密钥仅附加 extraHeaders；
    // header/query/bearer 注入 {key}；extraHeaders 一并附加。
    this.injectAuthFn(req, cfg.auth, apiKey);

    const timeout = provider.timeoutMs ?? DEFAULT_FETCH_TIMEOUT_MS;

    // 4) 发送与分类：传输层异常统一兜底为带 warning 的空清单，绝不抛到渲染进程
    try {
      const resp = await this.httpSend(req, { timeout, proxy: provider.proxy });

      // 鉴权失败：401/403 → 支持列表但本次鉴权失败（场景 7）
      if (resp.status === 401 || resp.status === 403) {
        return {
          supportsListing: true,
          models: [],
          warning: `鉴权失败(${resp.status})`,
        };
      }

      // 其它非成功状态：返回带状态码的 warning（场景 6）
      if (!isSuccessStatus(resp.status)) {
        return {
          supportsListing: true,
          models: [],
          warning: `端点返回 ${resp.status}`,
        };
      }

      // 成功：按 responseMapping 归一化
      const models = this.normalizeModels(resp.body, cfg);
      if (models === null) {
        // 无法按指针定位到模型数组（格式变更、HTML 错误页等）：格式非预期（场景 6）
        return {
          supportsListing: true,
          models: [],
          warning: "响应格式非预期",
        };
      }

      return { supportsListing: true, models };
    } catch (err) {
      // 端点不可达 / 连接被拒绝 / 超时等传输层错误：带 warning 返回，不抛出（场景 6/10）
      const message = err instanceof Error ? err.message : String(err);
      return {
        supportsListing: true,
        models: [],
        warning: `端点不可达: ${message}`,
      };
    }
  }

  /**
   * 按 ModelListingConfig.responseMapping 把原始响应体归一化为 ModelInfo[]。
   *
   * - 用 getByPointer 以 arrayPointer 定位「模型数组」（兼容 OpenAI 风格 /data、
   *   其它风格 /models 等任意指针）。
   * - 逐项用 idField 取出模型 id（如 "id" 或 "name"），仅接受非空字符串 id；
   *   按 id 去重（保留首次出现），归一化为 { id, source:"fetched", availability:"unknown" }。
   *
   * @returns 归一化后的 ModelInfo[]；当 arrayPointer 落空或目标非数组时返回 null（格式非预期）
   */
  private normalizeModels(body: unknown, cfg: ModelListingConfig): ModelInfo[] | null {
    const { arrayPointer, idField } = cfg.responseMapping;

    // 定位模型数组：指针落空或目标非数组即视为格式非预期
    const located = getByPointer(body, arrayPointer);
    if (!Array.isArray(located)) {
      return null;
    }

    const models: ModelInfo[] = [];
    const seen = new Set<string>();

    for (const item of located) {
      // 元素必须是对象才能取 idField；非对象元素跳过（尽力解析）
      if (item === null || typeof item !== "object") {
        continue;
      }
      const rawId = (item as Record<string, unknown>)[idField];
      // 仅接受非空字符串 id；其它类型（number/null/undefined）跳过
      if (typeof rawId !== "string" || rawId.length === 0) {
        continue;
      }
      // id 去重：保留首次出现
      if (seen.has(rawId)) {
        continue;
      }
      seen.add(rawId);
      models.push({
        id: rawId,
        source: "fetched",
        availability: "unknown",
      });
    }

    return models;
  }

  // =========================================================================
  // 模型可用性探测（对应 design.md「模型探测算法 probeModels」与需求 6.x）
  // =========================================================================

  /**
   * 探测单个模型的可用性（最小代价真实调用）。
   *
   * 流程（对应 design.md 的 probeModel 伪代码）：
   * 1. 按 modelProbe 声明拼 URL、用 bodyTemplate 渲染「最小代价请求体」（{model} 占位）。
   * 2. 注入鉴权（无鉴权本地 provider 不注入密钥）；httpSend 带单模型超时发送。
   * 3. 按结果分类：
   *    - 命中 availableStatuses（缺省 2xx）→ available + latencyMs + statusCode；
   *    - 401/403 → unavailable + statusCode + "鉴权失败(状态码)"；
   *    - 其它非可用状态 → unavailable + statusCode + "返回 N"；
   *    - 超时 → unavailable + "超时"（不提供 statusCode）；
   *    - 连接错误（ECONNREFUSED/EHOSTUNREACH 等，含本地服务未启动）→ unavailable + 连接错误，
   *      **绝不**提示鉴权失败；
   *    - 其它网络/解析不可判定异常 → unknown + 错误消息。
   *
   * @param provider 统一 Provider 配置（含 apiKeyRef 与 modelProbe 声明）
   * @param modelId 待探测的模型 id
   * @param apiKey 已解析的明文密钥（仅主进程内存；无鉴权时为 undefined）
   * @param timeoutMs 单模型探测超时（毫秒）
   * @returns 单模型探测结果；结果中**不含明文密钥**
   * @remarks 探测只读、无副作用；仅发最小代价请求，不写任何本地或远端配置
   */
  private async probeOne(
    provider: ProviderConfig,
    modelId: string,
    apiKey: string | undefined,
    timeoutMs: number,
  ): Promise<ModelProbeResult> {
    // 调用方已保证 modelProbe 存在（probeModel/probeModels 入口处前置断言）
    const cfg = provider.modelProbe as ModelProbeConfig;

    // 1) 构造最小代价请求：拼 URL、渲染 body（{model} 占位）、方法默认 POST
    const url = joinUrl(provider.baseUrl, cfg.path);
    const req: HttpRequest = {
      url,
      method: cfg.method ?? "POST",
      headers: {},
      body: renderProbeBody(cfg.bodyTemplate, modelId),
    };
    // 2) 注入鉴权：none 形态不注入密钥仅附加 extraHeaders；header/query/bearer 注入 {key}
    this.injectAuthFn(req, cfg.auth, apiKey);

    try {
      const resp = await this.httpSend(req, { timeout: timeoutMs, proxy: provider.proxy });
      const probedAt = new Date().toISOString();

      // 命中可用状态集合 → available（附往返延迟）
      if (isProbeAvailable(resp.status, cfg.availableStatuses)) {
        return {
          modelId,
          availability: "available",
          latencyMs: resp.latencyMs,
          statusCode: resp.status,
          probedAt,
        };
      }

      // 鉴权失败：401/403 → unavailable（error 含状态码）
      if (resp.status === 401 || resp.status === 403) {
        return {
          modelId,
          availability: "unavailable",
          statusCode: resp.status,
          error: `鉴权失败(${resp.status})`,
          probedAt,
        };
      }

      // 其它非可用状态 → unavailable（error 含状态码）
      return {
        modelId,
        availability: "unavailable",
        statusCode: resp.status,
        error: `返回 ${resp.status}`,
        probedAt,
      };
    } catch (err) {
      const probedAt = new Date().toISOString();

      // 超时 → unavailable + "超时"
      if (isTimeoutError(err)) {
        return { modelId, availability: "unavailable", error: "超时", probedAt };
      }

      // 连接错误（本地服务未启动/端口未监听/主机不可达）→ unavailable 连接错误，
      // 绝不提示鉴权失败（对应 design.md 场景 10）。
      if (isConnectionError(err)) {
        return {
          modelId,
          availability: "unavailable",
          error: `无法连接到 ${provider.baseUrl}（连接错误，本地服务可能未运行）`,
          probedAt,
        };
      }

      // 其它网络/解析等不可判定异常 → unknown
      const message = err instanceof Error ? err.message : String(err);
      return { modelId, availability: "unknown", error: message, probedAt };
    }
  }

  /**
   * 探测单个模型的可用性（对外入口）。
   *
   * 自行解析密钥（无鉴权本地 provider 不解析），再委托 probeOne 完成一次探测。
   *
   * @param provider 统一 Provider 配置
   * @param modelId 待探测的模型 id
   * @param options 超时等控制（缺省取默认值）
   * @returns 单模型探测结果；结果中**不含明文密钥**
   */
  async probeModel(
    provider: ProviderConfig,
    modelId: string,
    options?: ProbeOptions,
  ): Promise<ModelProbeResult> {
    const cfg = provider.modelProbe;
    if (!cfg) {
      // 未声明探测端点：无法探测，归类 unknown 并给出可读原因（不抛出到调用链上层）
      return {
        modelId,
        availability: "unknown",
        error: "该 provider 未声明模型探测端点（modelProbe）",
        probedAt: new Date().toISOString(),
      };
    }
    const timeoutMs = options?.timeoutMs ?? DEFAULT_PROBE_TIMEOUT_MS;
    const apiKey = await this.resolveProbeKey(provider, cfg);
    return this.probeOne(provider, modelId, apiKey, timeoutMs);
  }

  /**
   * 批量探测模型可用性（并发受限工作池 + 预置槽位保证一一对应）。
   *
   * 流程（对应 design.md 的 probeModels 伪代码与需求 6.7 / Property 10）：
   * 1. 前置：modelProbe 未声明时为每个 modelId 返回 unknown 占位结果（仍一一对应）。
   * 2. 解析密钥一次（无鉴权本地 provider 不解析），供所有模型复用。
   * 3. 预置与 modelIds 等长的结果数组（保证长度相等、按下标对齐）。
   * 4. 启动至多 concurrency 个 worker 并行从带下标的队列取任务，逐个 probeOne，
   *    把结果写回对应下标——任一时刻进行中的请求数不超过 concurrency。
   *
   * @param provider 统一 Provider 配置
   * @param modelIds 待探测模型 id 列表
   * @param options 并发上限、单模型超时（缺省取默认值）
   * @returns 与 modelIds **一一对应**（长度相等、下标对齐）的探测结果；不含明文密钥
   * @remarks 探测只读、无副作用
   */
  async probeModels(
    provider: ProviderConfig,
    modelIds: string[],
    options?: ProbeOptions,
  ): Promise<ModelProbeResult[]> {
    const timeoutMs = options?.timeoutMs ?? DEFAULT_PROBE_TIMEOUT_MS;
    // 并发上限至少为 1，避免非法并发导致 worker 不启动
    const concurrency = Math.max(1, options?.concurrency ?? DEFAULT_PROBE_CONCURRENCY);

    // 预置槽位：无论探测成败，结果数组始终与 modelIds 一一对应（长度相等、下标对齐）
    const results: ModelProbeResult[] = new Array(modelIds.length);

    // 空输入快速返回（无需解析密钥、无需发请求）
    if (modelIds.length === 0) {
      return results;
    }

    const cfg = provider.modelProbe;
    if (!cfg) {
      // 未声明探测端点：为每个模型填 unknown 占位，保持一一对应
      const probedAt = new Date().toISOString();
      for (let i = 0; i < modelIds.length; i++) {
        results[i] = {
          modelId: modelIds[i],
          availability: "unknown",
          error: "该 provider 未声明模型探测端点（modelProbe）",
          probedAt,
        };
      }
      return results;
    }

    // 解析密钥一次，供所有模型复用（无鉴权本地 provider 不解析）
    const apiKey = await this.resolveProbeKey(provider, cfg);

    // 带下标的共享游标：各 worker 以原子自增的方式领取任务，天然保证互不重复
    let nextIndex = 0;
    const worker = async (): Promise<void> => {
      // 不变式：同时运行的 worker 数 ≤ concurrency，故进行中的探测数 ≤ concurrency。
      // 当队列还有未领取的下标时循环领取并探测，领完即退出。
      while (nextIndex < modelIds.length) {
        const idx = nextIndex;
        nextIndex = idx + 1;
        results[idx] = await this.probeOne(provider, modelIds[idx], apiKey, timeoutMs);
      }
    };

    // 启动至多 concurrency 个 worker（不超过待探测数量）并等待全部完成
    const workerCount = Math.min(concurrency, modelIds.length);
    const workers: Promise<void>[] = [];
    for (let i = 0; i < workerCount; i++) {
      workers.push(worker());
    }
    await Promise.all(workers);

    return results;
  }

  /**
   * 解析探测所需的明文密钥（仅主进程内存使用）。
   *
   * 无鉴权判定下（本地 provider 或 auth.in/kind="none"）**不解析也不要求**密钥：
   * 既不调用 SecretStore，也不因 apiKeyRef 为空而失败（对应 Property 12）。
   * 密钥解析失败时抛出，交由 probeModel/probeModels 的调用方处理。
   *
   * @returns 明文密钥；无鉴权时返回 undefined
   */
  private async resolveProbeKey(
    provider: ProviderConfig,
    cfg: ModelProbeConfig,
  ): Promise<string | undefined> {
    if (isNoAuthProbe(provider, cfg)) {
      return undefined;
    }
    return this.secretStore.resolveSecret(provider.apiKeyRef);
  }
}

/**
 * 便捷工厂：按注入依赖构造 ModelDiscovery 实例。
 *
 * 保持与仓库其它服务一致的「依赖可注入」装配风格，便于主进程启动点集中装配，
 * 也便于测试直接传入内存 SecretStore 与 mock httpSend。
 */
export function createModelDiscovery(deps: ModelDiscoveryDeps): ModelDiscovery {
  return new ModelDiscovery(deps);
}
