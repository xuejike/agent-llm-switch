// 跨进程共享的核心 TypeScript 类型定义
//
// 本文件集中声明 LLM 配置管理器在主进程与渲染进程之间共享的全部核心类型：
// - 统一的 Provider 配置（供应商中立的「配置真相」）
// - 模型发现与探测相关类型
// - Agent 适配器所需的数据驱动声明类型（格式映射、凭据注入、鉴权注入等）
// - 分发编排的探测/渲染/报告结果类型
// - 跨进程边界的 IPC 契约接口
//
// 设计约束（务必遵守）：
// - ProviderConfig 必须保持供应商中立、与具体 agent 无关，只持有中立的 apiKeyRef，
//   不得为任何特定 agent 的 key 字段名/位置/引用形式保留字段（key 的 agent 差异一律
//   在各 AgentAdapter.render 内经 CredentialMapping 转换）。
// - 本文件只放类型声明，不含任何运行时逻辑，便于主进程与渲染进程共同引用。

// ===========================================================================
// 数据驱动声明类型：配置格式 / 格式映射 / 凭据注入 / 鉴权注入 / 模型端点声明
// ===========================================================================

/** 配置文件序列化格式 */
export type ConfigFormat = "json" | "jsonc" | "toml" | "yaml";

/**
 * 格式映射描述：声明如何把统一 ProviderConfig 的字段
 * 映射到某个 agent 配置文件的具体位置（数据驱动，可配置）。
 */
export interface FormatMapping {
  /** 配置文件格式 */
  format: ConfigFormat;
  /**
   * 字段映射表：键为统一模型字段路径，值为目标文件中的 JSON 指针式路径。
   * 例如 { "baseUrl": "/provider/{providerName}/options/baseURL" }
   */
  fieldPaths: Record<string, string>;
  /** 该 agent 配置中「受本程序管理」的字段路径集合（合并时只动这些） */
  managedPaths: string[];
  /**
   * 可选：凭据注入的声明式描述（数据驱动，向后兼容——不声明时沿用 fieldPaths 里对
   * key 字段的直接明文映射）。用于覆盖大多数 agent 对 key 字段名/位置/引用形式/
   * 格式的差异，使 ProviderConfig 无需为任何 agent 的 key 写法保留字段。
   * 无法用声明表达的特殊封装（base64、签名、连接串拼装等）仍走下方 transform 钩子。
   */
  credential?: CredentialMapping;
  /**
   * 可选的自定义变换钩子名（用于无法用路径/声明表达的特殊情况，
   * 包括 key 的特殊封装：base64、签名、provider+key 连接串等——属少数特例）。
   */
  transform?: string;
}

/**
 * 凭据字段形态：决定 key 以何种形式出现在该 agent 的配置文件中。
 * - "inline"：直接写入明文 key（能走环境变量/独立 secrets 的优先于明文）
 * - "env"：配置文件里写环境变量引用（如 "{env:VAR}" / "${VAR}"），明文落到环境变量/.env
 * - "secrets-file"：配置文件里写对独立 secrets 文件的引用，明文落到该 secrets 文件
 */
export type CredentialForm = "inline" | "env" | "secrets-file";

/**
 * 凭据注入声明：描述把供应商 key 适配成「该 agent 要求」的字段名、位置、引用形式与格式。
 * 由各 AgentAdapter 在 render 阶段数据驱动地应用；本结构不进入 ProviderConfig，
 * 从而保证 ProviderConfig 的供应商中立与 agent 无关性。
 */
export interface CredentialMapping {
  /**
   * 目标路径：key（或其引用）写到该 agent 配置文件哪个 JSON 指针式位置。
   * 覆盖「字段名不同 + 放置位置不同」两类差异，例如：
   * "/provider/{providerName}/options/apiKey"（provider 块内）、
   * "/api_key"（顶层、下划线命名）、"/secrets/token"（独立 credentials 段）。
   */
  targetPointer: string;
  /** 字段形态：inline 明文 / env 引用 / secrets 文件引用 */
  form: CredentialForm;
  /**
   * 值模板：写入 targetPointer 的字符串模板。
   * - inline：如 "{key}" 或带前缀 "Bearer {key}"（覆盖「格式/封装」差异的简单情形）
   * - env：如 "{env:ANTHROPIC_API_KEY}" 或 "${ANTHROPIC_API_KEY}"（覆盖「引用方式」差异）
   * - secrets-file：如对独立文件中条目的引用占位
   * 占位符：{key}=明文密钥，{env:VAR}/{VAR}=环境变量引用，{providerName}=provider 名。
   */
  valueTemplate: string;
  /**
   * 当 form="env" 时，明文密钥实际写入的环境变量名（如 "ANTHROPIC_API_KEY"）。
   * 适配器负责把明文写到该环境变量/该 agent 读取的 .env 文件，配置文件里只留引用。
   */
  envVarName?: string;
  /**
   * 当 form="secrets-file" 时，明文密钥实际写入的独立 secrets 文件路径（可含平台变量，
   * 由 PathResolver 解析）与文件内的条目键；配置文件里只留对它的引用。
   */
  secretsFile?: { path: string; entryKey: string };
}

/** 鉴权注入方式（不同 provider 不同） */
export interface AuthInjection {
  /**
   * 注入位置：
   * - "header"：把密钥注入请求头（如 Authorization / x-api-key / api-key）
   * - "query"：把密钥注入查询参数（如 Google Gemini 的 ?key={key}）
   * - "none"：无鉴权（本地/自托管场景，如 Ollama / LM Studio / vLLM 默认无需密钥）
   */
  in: "header" | "query" | "none";
  /**
   * 鉴权种类（可选，用于显式区分表达方式与特例）：
   * - "bearer"：Authorization: Bearer {key}（OpenAI 及多数兼容平台）
   * - "header"：任意自定义头注入 {key}（如 Anthropic 的 x-api-key、Azure 的 api-key）
   * - "query"：查询参数注入 {key}（如 Gemini ?key=）
   * - "none"：无鉴权（本地场景，apiKeyRef 可为空）
   * - "sigv4"：AWS SigV4 签名鉴权，无法用简单 header/query 模板表达，
   *            由专门的代码级 auth 适配器处理，属少数特例。
   * 缺省时由 in + name + valueTemplate 推断（保持与现有字段兼容）。
   */
  kind?: "bearer" | "header" | "query" | "none" | "sigv4";
  /** 头/参数名，如 "Authorization" / "x-api-key" / "api-key"；in="none"/kind="sigv4" 时可省略 */
  name?: string;
  /** 值模板，用 {key} 占位明文密钥，如 "Bearer {key}" 或 "{key}"；in="none"/kind="sigv4" 时可省略 */
  valueTemplate?: string;
  /** 额外固定头（如 Anthropic 的 anthropic-version、Azure 的 api-version 查询） */
  extraHeaders?: Record<string, string>;
}

/** 模型列表响应解析映射（JSON 指针式，数据驱动） */
export interface ModelListingResponseMapping {
  /** 指向响应中「模型数组」的指针，如 "/data"（OpenAI）或 "/models"（其它） */
  arrayPointer: string;
  /** 数组元素中模型 id 的字段名，如 "id" 或 "name" */
  idField: string;
}

/**
 * 模型列表端点配置（数据驱动，声明如何从某 provider 拉取与解析模型清单）。
 */
export interface ModelListingConfig {
  /** 相对 baseUrl 的端点路径，如 "/v1/models"；缺省表示该 provider 不支持列表 API */
  path?: string;
  /** HTTP 方法，默认 "GET" */
  method?: "GET" | "POST";
  /** 鉴权注入方式：决定把密钥放到 Header 还是 Query */
  auth: AuthInjection;
  /** 响应解析映射：从原始 JSON 定位模型数组与字段 */
  responseMapping: ModelListingResponseMapping;
}

/**
 * 模型探测端点配置（数据驱动，声明如何对该 provider 做最小代价探测）。
 */
export interface ModelProbeConfig {
  /** 探测端点路径，如 "/v1/chat/completions" */
  path: string;
  /** HTTP 方法，默认 "POST" */
  method?: "GET" | "POST";
  /** 鉴权注入方式 */
  auth: AuthInjection;
  /**
   * 请求体模板：用 {model} 占位模型 id；构造「最小代价」请求。
   * 例如 { model: "{model}", messages: [{role:"user",content:"ping"}], max_tokens: 1 }
   */
  bodyTemplate?: Record<string, unknown>;
  /** 判定为「可用」的 HTTP 状态码集合，默认 2xx */
  availableStatuses?: number[];
}

/** 探测控制参数 */
export interface ProbeOptions {
  /** 单个模型探测的超时（毫秒），默认如 8000 */
  timeoutMs?: number;
  /** 并发上限（同时进行的探测请求数），默认如 4 */
  concurrency?: number;
}

/** fetchModels 结果：区分「成功拉取」与「provider 不支持列表 API 需回退手动」 */
export interface FetchModelsResult {
  /** 该 provider 是否支持模型列表 API（false 时提示用户回退手动输入） */
  supportsListing: boolean;
  /** 归一化后的候选模型清单（source="fetched"） */
  models: ModelInfo[];
  /** 拉取失败/部分失败的说明（端点不可达、格式非预期等），成功时为空 */
  warning?: string;
}

// ===========================================================================
// 模型发现与探测相关类型
// ===========================================================================

/** 模型可用性状态 */
export type ModelAvailability = "available" | "unavailable" | "unknown";

/** 模型来源：自动拉取 or 用户手动输入 */
export type ModelSource = "fetched" | "manual";

/**
 * 单个模型的信息（候选清单的元素）：
 * 既承载「从哪来」（source），也承载最近一次探测的结论（availability 等）。
 */
export interface ModelInfo {
  /** 模型 id，如 "claude-sonnet-4" / "gpt-4o-mini" */
  id: string;
  /** 来源：fetched=API 拉取；manual=用户手动输入 */
  source: ModelSource;
  /** 最近一次探测得到的可用性；未探测过为 "unknown" */
  availability: ModelAvailability;
  /** 最近一次成功探测的往返延迟（毫秒）；未探测或失败时为 undefined */
  latencyMs?: number;
  /** 探测失败/不可用时的错误信息（如 "401 未授权" / "超时"）；可用时为 undefined */
  error?: string;
  /** 最近一次探测的时间戳（ISO 字符串），便于判断结果新鲜度 */
  probedAt?: string;
}

/**
 * 单个模型的探测结果：probeModel/probeModels 的返回元素。
 * 与 ModelInfo 的探测字段对应，可用于回写 candidateModels。
 */
export interface ModelProbeResult {
  /** 被探测的模型 id */
  modelId: string;
  /** 探测判定的可用性 */
  availability: ModelAvailability;
  /** 成功时的往返延迟（毫秒） */
  latencyMs?: number;
  /** 探测返回的 HTTP 状态码（若有），便于诊断 */
  statusCode?: number;
  /** 失败/不可用的原因（鉴权失败、超时、网络错误、格式异常等） */
  error?: string;
  /** 探测完成时间（ISO 字符串） */
  probedAt: string;
}

// ===========================================================================
// Provider 配置（统一真相，供应商中立、与 agent 无关）
// ===========================================================================

/** 代理设置 */
export interface ProxyConfig {
  /** 代理地址 */
  url: string;
  /** 代理认证引用（如需要），同样走凭据管理器 */
  authRef?: string;
}

/**
 * 统一的 Provider 配置：UI 维护的「配置真相」，与具体 agent 无关。
 *
 * 重要约束：本结构保持供应商中立，仅含中立的 apiKeyRef，
 * 不包含任何 agent 专属的 key 字段（如 apiKey/api_key/token 等）。
 * 各 agent 对 key 的字段名/位置/引用形式差异一律在适配器 render 内经
 * CredentialMapping 转换，不污染本「配置真相」。
 */
export interface ProviderConfig {
  /** 内部唯一 id */
  id: string;
  /** Provider 名称，如 "anthropic" / "openai" / 自定义网关 */
  name: string;
  /** API 基础地址 */
  baseUrl: string;
  /** API Key 的引用（指向 OS 凭据管理器中的条目），绝不存明文 */
  apiKeyRef: string;
  /**
   * 已选用于分发的模型 id 列表（分发时写入各 agent 的就是这一组）。
   * 兼容既有字段名 models：原「模型列表」即为此「已选分发集合」。
   * 其元素应为 candidateModels 中 id 的子集（当使用自动获取时），
   * 或为用户手动输入的模型 id（provider 不支持列表 API 时）。
   */
  models: string[];
  /**
   * 候选模型清单：由 ModelDiscovery.fetchModels 拉取或用户手动录入，
   * 携带来源与最近一次探测状态，供 UI 展示与筛选。可选（未获取过时为空）。
   */
  candidateModels?: ModelInfo[];
  /**
   * 分发时的模型筛选策略：
   * - "available-only"：仅分发探测结果为 available 的模型
   * - "all"：分发全部已选模型（不要求探测通过）
   * 默认 "all"（保持与旧行为兼容）。
   */
  modelSelection?: "available-only" | "all";
  /**
   * 该 provider 的模型列表端点配置（数据驱动，可扩展）；
   * 缺省表示该 provider 不支持自动获取，UI 回退到手动输入 models。
   */
  modelListing?: ModelListingConfig;
  /** 该 provider 的模型探测端点配置（数据驱动，可扩展）；缺省则无法探测 */
  modelProbe?: ModelProbeConfig;
  /** 请求超时（毫秒），可选 */
  timeoutMs?: number;
  /** 代理设置，可选 */
  proxy?: ProxyConfig;
  /**
   * 是否为本地/自托管 provider（baseUrl 指向 localhost/自定义内网主机）。
   * 为 true 时通常无需 API Key，校验规则放宽：apiKeyRef 允许为空。可选，默认 false。
   */
  isLocal?: boolean;
}

// ===========================================================================
// 平台上下文 / 探测 / 渲染 / 分发报告 / 应用状态
// ===========================================================================

/** 平台上下文：注入而非全局读取，便于测试 */
export interface PlatformContext {
  /** 运行平台 */
  os: "win32" | "darwin" | "linux";
  /** 用户主目录 */
  homeDir: string;
  /** 环境变量快照（APPDATA、XDG_CONFIG_HOME、ProgramData 等） */
  env: Record<string, string | undefined>;
}

/** 探测结果（agent 安装与配置文件状态） */
export interface DetectResult {
  /** 该 agent 是否安装 */
  installed: boolean;
  /** 解析出的配置文件绝对路径 */
  configPath: string;
  /** 配置文件当前是否已存在 */
  fileExists: boolean;
  /**
   * 检测到的 agent 版本号（经 CLI 命令探测得到，如 "0.3.12"）。
   * 仅当通过命令成功探测到安装时才有值；未安装或命令不支持版本输出时为 undefined。
   */
  version?: string;
}

/** 渲染结果（预览与写入共用） */
export interface RenderResult {
  /** 合并后的完整文件文本 */
  mergedContent: string;
  /** 供 UI 预览的差异（API Key 已掩码，绝不含明文） */
  maskedDiff: string;
}

/** 单个 agent 的分发结果 */
export interface ApplyEntry {
  /** agent 唯一标识 */
  agentId: string;
  /** 分发状态 */
  status: "success" | "failed" | "skipped";
  /** 写入成功时的备份文件路径，供回溯/手动回滚 */
  backupPath?: string;
  /** 跳过原因（如未安装）或失败错误信息 */
  message?: string;
}

/** 一次分发的汇总报告 */
export interface ApplyReport {
  /** 分发完成时间（ISO 字符串） */
  timestamp: string;
  /** 每个 agent 的分发结果 */
  entries: ApplyEntry[];
  /** 汇总计数 */
  summary: { success: number; failed: number; skipped: number };
}

/** 预览结果（分发前的 Diff 预览） */
export interface PreviewResult {
  /** agent 唯一标识 */
  agentId: string;
  /** 该 agent 的配置文件绝对路径 */
  configPath: string;
  /** 该 agent 是否安装 */
  installed: boolean;
  /** 掩码后的差异（API Key 已掩码，绝不含明文） */
  maskedDiff: string;
}

/** 单个 agent 在本程序中的状态 */
export interface AgentState {
  /** agent 唯一标识 */
  agentId: string;
  /** 用户是否勾选启用（参与一键分发） */
  enabled: boolean;
  /** 最近一次探测结果缓存 */
  lastDetect?: DetectResult;
}

/** 应用全局状态（由 ConfigStore 持久化，不含明文密钥） */
export interface AppState {
  /** 所有 Provider 配置 */
  providers: ProviderConfig[];
  /** 各 agent 的启用/状态 */
  agents: AgentState[];
  /** 当前选中的 Provider id（可选） */
  activeProviderId?: string;
}

// ===========================================================================
// IPC 契约（进程边界白名单 API）
// ===========================================================================

/**
 * 预加载脚本经 contextBridge 暴露给渲染进程的白名单 API。
 *
 * 边界约束：IPC 向渲染进程回传的所有内容（含 maskedDiff、getMaskedSecret、
 * fetchModels/probeModels 的结果）均不含明文密钥；明文仅在主进程内存中短暂存在。
 */
export interface IpcApi {
  /** 读取应用全局状态 */
  loadAppState(): Promise<AppState>;
  /** 保存应用全局状态（不含明文密钥） */
  saveAppState(state: AppState): Promise<void>;
  /** 保存密钥：明文由渲染进程输入后立即交主进程存入凭据管理器 */
  saveSecret(keyRef: string, apiKey: string): Promise<void>;
  /** 返回用于 UI 展示的掩码串，从不回传明文 */
  getMaskedSecret(keyRef: string): Promise<string | null>;
  /** 探测一组 agent 的安装与配置文件状态 */
  detectAgents(agentIds: string[]): Promise<DetectResult[]>;
  /** 仅预览：对启用的 agent 生成合并结果与掩码差异，不写盘 */
  preview(config: ProviderConfig, agentIds: string[]): Promise<PreviewResult[]>;
  /** 执行分发：写盘并返回报告 */
  distribute(config: ProviderConfig, agentIds: string[]): Promise<ApplyReport>;
  /** 列出所有已注册适配器（用于 UI 展示可管理的 agent 列表） */
  listAgents(): Promise<{ id: string; displayName: string }[]>;

  /**
   * 自动获取某 provider 的模型清单。
   * 渲染进程只传 config（含 apiKeyRef，不含明文）；主进程内部解析明文密钥请求端点。
   * 返回候选模型清单（ModelInfo[]，source="fetched"），不含明文密钥。
   */
  fetchModels(config: ProviderConfig): Promise<FetchModelsResult>;

  /**
   * 批量探测模型可用性。
   * 返回与 modelIds 对应的探测结果（availability/延迟/错误），不含明文密钥。
   */
  probeModels(
    config: ProviderConfig,
    modelIds: string[],
    options?: ProbeOptions,
  ): Promise<ModelProbeResult[]>;
}
