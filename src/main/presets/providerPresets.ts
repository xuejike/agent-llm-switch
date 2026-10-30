// 内置 Provider 预设声明集（providerPresets）
//
// 本模块把"可扩展"落实为"开箱即用"：为主流云平台与本地/自托管推理服务各内置一份
// 声明式预设。每份预设是一个数据驱动的四元组
//   { baseUrl 默认值, AuthInjection, ModelListingConfig, ModelProbeConfig }
// 的模板——用户新建 Provider 选择平台时，这些声明被作为"可编辑默认值"套用到表单。
//
// 设计约束（务必遵守）：
// - 核心拉取/探测引擎（ModelDiscovery）对预设完全数据驱动：新增任意兼容平台只需在此
//   追加一份预设声明，无需改动引擎代码（唯一代码级例外是 AWS Bedrock 的 SigV4 签名，
//   由专用适配器处理，见任务 8.2）。
// - 严格参照 design.md「内置预设（Provider Presets）」表格的各平台端点
//   （path / arrayPointer / idField）、鉴权方式与探测端点声明。
// - 套用预设时只提供默认值，绝不覆盖用户已手工填写的值；预设缺失或非法
//   （缺 baseUrl / AuthInjection / ModelListingConfig）时拒绝套用并返回错误，
//   不创建处于无效状态的 Provider。
//
// 本模块仅承载预设声明与"套用/校验"纯逻辑，不发起任何网络请求、不访问文件系统。

import type {
  AuthInjection,
  ModelListingConfig,
  ModelProbeConfig,
  ProviderConfig,
} from "@shared/types";

// ===========================================================================
// 预设类型声明
// ===========================================================================

/** 预设分组：云平台（公网）/ 本地（自托管、通常无鉴权） */
export type PresetGroup = "cloud" | "local";

/**
 * 单份内置 Provider 预设：平台维度的声明式默认模板。
 *
 * 字段语义：
 * - id          ：平台内部唯一标识（kebab-case，如 "openai"、"azure-openai"、"ollama"）。
 * - displayName ：UI 展示名（如 "OpenAI"、"Azure OpenAI"、"Ollama（本地）"）。
 * - group       ：分组（cloud/local），供 UI 的"云/本地"分组展示。
 * - baseUrl     ：baseUrl 默认值（套用后用户可编辑；本地平台指向 localhost）。
 * - auth        ：鉴权注入声明（AuthInjection），决定密钥注入位置/方式或无鉴权。
 * - modelListing：模型列表端点配置（ModelListingConfig），声明如何拉取/解析模型清单。
 * - modelProbe  ：模型探测端点配置（ModelProbeConfig），声明如何最小代价探测可用性。
 * - isLocal     ：是否本地/自托管（本地平台通常无鉴权，apiKeyRef 可空，校验规则放宽）。
 */
export interface ProviderPreset {
  /** 平台内部唯一标识（kebab-case） */
  id: string;
  /** UI 展示名 */
  displayName: string;
  /** 分组：云平台 / 本地 */
  group: PresetGroup;
  /** baseUrl 默认值（可编辑） */
  baseUrl: string;
  /** 鉴权注入声明 */
  auth: AuthInjection;
  /** 模型列表端点配置 */
  modelListing: ModelListingConfig;
  /** 模型探测端点配置 */
  modelProbe: ModelProbeConfig;
  /** 是否本地/自托管平台（默认 false） */
  isLocal?: boolean;
}

// ===========================================================================
// 可复用的鉴权/端点声明片段（减少同质平台的重复，差异靠 baseUrl 吸收）
// ===========================================================================

/** OpenAI 兼容：Authorization: Bearer {key} 的 header 鉴权 */
const BEARER_AUTH: AuthInjection = {
  in: "header",
  kind: "bearer",
  name: "Authorization",
  valueTemplate: "Bearer {key}",
};

/** OpenAI 兼容：模型列表端点（/v1/models → /data[].id） */
const OPENAI_COMPATIBLE_LISTING: ModelListingConfig = {
  path: "/v1/models",
  method: "GET",
  auth: BEARER_AUTH,
  responseMapping: { arrayPointer: "/data", idField: "id" },
};

/** OpenAI 兼容：探测端点（/v1/chat/completions 最小代价 POST） */
const OPENAI_COMPATIBLE_PROBE: ModelProbeConfig = {
  path: "/v1/chat/completions",
  method: "POST",
  auth: BEARER_AUTH,
  bodyTemplate: {
    model: "{model}",
    messages: [{ role: "user", content: "ping" }],
    max_tokens: 1,
  },
  availableStatuses: [200],
};

/**
 * 构造一份标准 OpenAI 兼容云平台预设（高度同质：仅 baseUrl 与密钥不同）。
 * 用于 OpenAI 兼容云平台组与国内多数 OpenAI 兼容平台，避免逐个重复声明。
 */
function openAiCompatibleCloudPreset(
  id: string,
  displayName: string,
  baseUrl: string,
): ProviderPreset {
  return {
    id,
    displayName,
    group: "cloud",
    baseUrl,
    auth: BEARER_AUTH,
    modelListing: OPENAI_COMPATIBLE_LISTING,
    modelProbe: OPENAI_COMPATIBLE_PROBE,
  };
}

/**
 * 构造一份 OpenAI 兼容本地平台预设（无鉴权，baseUrl 指向 localhost）。
 * 用于 LM Studio、vLLM、llama.cpp server、LocalAI 等 OpenAI 兼容本地服务。
 */
function openAiCompatibleLocalPreset(
  id: string,
  displayName: string,
  baseUrl: string,
): ProviderPreset {
  // 本地无鉴权：auth.in="none"，拉取/探测端点均不注入密钥
  const noneAuth: AuthInjection = { in: "none", kind: "none" };
  return {
    id,
    displayName,
    group: "local",
    baseUrl,
    isLocal: true,
    auth: noneAuth,
    modelListing: {
      path: "/v1/models",
      method: "GET",
      auth: noneAuth,
      responseMapping: { arrayPointer: "/data", idField: "id" },
    },
    modelProbe: {
      path: "/v1/chat/completions",
      method: "POST",
      auth: noneAuth,
      bodyTemplate: {
        model: "{model}",
        messages: [{ role: "user", content: "ping" }],
        max_tokens: 1,
      },
      availableStatuses: [200],
    },
  };
}

// ===========================================================================
// 云平台预设（点名列出差异明显的平台）
// ===========================================================================

/** OpenAI：OpenAI 兼容标准形态（Bearer + /v1/models + /data[].id） */
const OPENAI_PRESET: ProviderPreset = openAiCompatibleCloudPreset(
  "openai",
  "OpenAI",
  "https://api.openai.com",
);

/**
 * Azure OpenAI：原生（deployment 维度）。
 * - 鉴权头为 api-key（非 Authorization），且几乎所有端点都要求 api-version 查询参数。
 * - 模型"列表"实为列出资源下的 deployments，路径与标准 /v1/models 不同。
 * - 探测端点需带 {deployment} 与 api-version。
 * baseUrl 默认留占位（用户需替换为自己的资源域名），api-version 以 extraHeaders 形式
 * 声明为固定查询附加项，由注入引擎并入请求。
 */
const AZURE_OPENAI_PRESET: ProviderPreset = {
  id: "azure-openai",
  displayName: "Azure OpenAI",
  group: "cloud",
  baseUrl: "https://<your-resource>.openai.azure.com",
  auth: {
    in: "header",
    kind: "header",
    name: "api-key",
    valueTemplate: "{key}",
  },
  modelListing: {
    // 列出资源下的 deployments；响应数组通常在 /data，idField 用 id
    path: "/openai/deployments?api-version=2024-10-21",
    method: "GET",
    auth: {
      in: "header",
      kind: "header",
      name: "api-key",
      valueTemplate: "{key}",
    },
    responseMapping: { arrayPointer: "/data", idField: "id" },
  },
  modelProbe: {
    // 探测需带 {deployment} 占位与 api-version（{model} 在此对应 deployment 名）
    path: "/openai/deployments/{model}/chat/completions?api-version=2024-10-21",
    method: "POST",
    auth: {
      in: "header",
      kind: "header",
      name: "api-key",
      valueTemplate: "{key}",
    },
    bodyTemplate: {
      messages: [{ role: "user", content: "ping" }],
      max_tokens: 1,
    },
    availableStatuses: [200],
  },
};

/**
 * Anthropic：原生。
 * - 鉴权头为 x-api-key，附固定头 anthropic-version: 2023-06-01。
 * - 列表 /v1/models → /data[].id；探测端点 /v1/messages。
 */
const ANTHROPIC_PRESET: ProviderPreset = {
  id: "anthropic",
  displayName: "Anthropic",
  group: "cloud",
  baseUrl: "https://api.anthropic.com",
  auth: {
    in: "header",
    kind: "header",
    name: "x-api-key",
    valueTemplate: "{key}",
    extraHeaders: { "anthropic-version": "2023-06-01" },
  },
  modelListing: {
    path: "/v1/models",
    method: "GET",
    auth: {
      in: "header",
      kind: "header",
      name: "x-api-key",
      valueTemplate: "{key}",
      extraHeaders: { "anthropic-version": "2023-06-01" },
    },
    responseMapping: { arrayPointer: "/data", idField: "id" },
  },
  modelProbe: {
    path: "/v1/messages",
    method: "POST",
    auth: {
      in: "header",
      kind: "header",
      name: "x-api-key",
      valueTemplate: "{key}",
      extraHeaders: { "anthropic-version": "2023-06-01" },
    },
    bodyTemplate: {
      model: "{model}",
      max_tokens: 1,
      messages: [{ role: "user", content: "ping" }],
    },
    availableStatuses: [200],
  },
};

/**
 * Google Gemini：原生。
 * - 密钥默认走查询参数 ?key={key}（也支持 x-goog-api-key header）。
 * - 列表数组在 /models、模型标识字段是 name（形如 models/gemini-...）。
 * - 探测端点 /v1beta/models/{model}:generateContent。
 */
const GEMINI_PRESET: ProviderPreset = {
  id: "google-gemini",
  displayName: "Google Gemini",
  group: "cloud",
  baseUrl: "https://generativelanguage.googleapis.com",
  auth: { in: "query", kind: "query", name: "key", valueTemplate: "{key}" },
  modelListing: {
    path: "/v1beta/models",
    method: "GET",
    auth: { in: "query", kind: "query", name: "key", valueTemplate: "{key}" },
    responseMapping: { arrayPointer: "/models", idField: "name" },
  },
  modelProbe: {
    path: "/v1beta/models/{model}:generateContent",
    method: "POST",
    auth: { in: "query", kind: "query", name: "key", valueTemplate: "{key}" },
    bodyTemplate: {
      contents: [{ parts: [{ text: "ping" }] }],
      generationConfig: { maxOutputTokens: 1 },
    },
    availableStatuses: [200],
  },
};

/**
 * AWS Bedrock：原生，SigV4 签名鉴权（少数代码级特例）。
 * - kind="sigv4" 走专用代码级签名适配器（见任务 8.2），不走简单 header/query 模板。
 * - "模型列表"与"调用"分属控制面（ListFoundationModels）与运行时（InvokeModel）不同端点。
 * baseUrl 默认指向常用区域端点，用户可按区域编辑。
 */
const BEDROCK_PRESET: ProviderPreset = {
  id: "aws-bedrock",
  displayName: "AWS Bedrock",
  group: "cloud",
  baseUrl: "https://bedrock.us-east-1.amazonaws.com",
  auth: { in: "header", kind: "sigv4" },
  modelListing: {
    // 控制面 API：列出基础模型，响应数组在 /modelSummaries，idField 为 modelId
    path: "/foundation-models",
    method: "GET",
    auth: { in: "header", kind: "sigv4" },
    responseMapping: { arrayPointer: "/modelSummaries", idField: "modelId" },
  },
  modelProbe: {
    // 运行时端点：InvokeModel（SigV4 签名），{model} 为模型 id
    path: "/model/{model}/invoke",
    method: "POST",
    auth: { in: "header", kind: "sigv4" },
    bodyTemplate: {},
    availableStatuses: [200],
  },
};

// ===========================================================================
// 本地平台预设（端点/鉴权不同而分别点名）
// ===========================================================================

/**
 * Ollama（本地）：原生（含 OpenAI 兼容层）。
 * - 无鉴权（in=none，apiKeyRef 可空）。
 * - 列表 /api/tags → /models[].name；探测 /api/show（最小代价）。
 */
const OLLAMA_PRESET: ProviderPreset = {
  id: "ollama",
  displayName: "Ollama（本地）",
  group: "local",
  baseUrl: "http://localhost:11434",
  isLocal: true,
  auth: { in: "none", kind: "none" },
  modelListing: {
    path: "/api/tags",
    method: "GET",
    auth: { in: "none", kind: "none" },
    responseMapping: { arrayPointer: "/models", idField: "name" },
  },
  modelProbe: {
    path: "/api/show",
    method: "POST",
    auth: { in: "none", kind: "none" },
    bodyTemplate: { name: "{model}" },
    availableStatuses: [200],
  },
};

/** LM Studio（本地）：OpenAI 兼容、无鉴权，默认端口 1234 */
const LM_STUDIO_PRESET: ProviderPreset = openAiCompatibleLocalPreset(
  "lm-studio",
  "LM Studio（本地）",
  "http://localhost:1234",
);

/** vLLM（本地）：OpenAI 兼容、无鉴权，默认端口 8000 */
const VLLM_PRESET: ProviderPreset = openAiCompatibleLocalPreset(
  "vllm",
  "vLLM（本地）",
  "http://localhost:8000",
);

/** llama.cpp server（本地）：OpenAI 兼容、无鉴权，默认端口 8080 */
const LLAMACPP_PRESET: ProviderPreset = openAiCompatibleLocalPreset(
  "llama-cpp-server",
  "llama.cpp server（本地）",
  "http://localhost:8080",
);

/** LocalAI（本地）：OpenAI 兼容、无鉴权，默认端口 8080 */
const LOCALAI_PRESET: ProviderPreset = openAiCompatibleLocalPreset(
  "localai",
  "LocalAI（本地）",
  "http://localhost:8080",
);

// ===========================================================================
// 内置预设集合（注册表）
// ===========================================================================

/**
 * 全部内置 Provider 预设（有序列表，供 UI 分组展示）。
 *
 * 云平台含点名平台（OpenAI / Azure OpenAI / Anthropic / Gemini / Bedrock）、
 * OpenAI 兼容云平台组（DeepSeek / xAI(Grok) / Groq / OpenRouter / Together / Mistral /
 * Cohere / Fireworks / Perplexity）与国内云平台组（阿里云百炼 DashScope / 智谱 GLM /
 * Moonshot / SiliconFlow 等）；本地含 Ollama / LM Studio / vLLM / llama.cpp server / LocalAI。
 *
 * 新增兼容平台只需在此追加一份预设声明（数据驱动），无需改动拉取/探测引擎。
 */
export const PROVIDER_PRESETS: readonly ProviderPreset[] = [
  // —— 云平台（点名差异明显者）——
  OPENAI_PRESET,
  AZURE_OPENAI_PRESET,
  ANTHROPIC_PRESET,
  GEMINI_PRESET,
  BEDROCK_PRESET,

  // —— OpenAI 兼容云平台组（高度同质，差异仅 baseUrl）——
  openAiCompatibleCloudPreset("deepseek", "DeepSeek", "https://api.deepseek.com"),
  openAiCompatibleCloudPreset("xai", "xAI（Grok）", "https://api.x.ai"),
  openAiCompatibleCloudPreset("groq", "Groq", "https://api.groq.com/openai"),
  openAiCompatibleCloudPreset("openrouter", "OpenRouter", "https://openrouter.ai/api"),
  openAiCompatibleCloudPreset("together", "Together", "https://api.together.xyz"),
  openAiCompatibleCloudPreset("mistral", "Mistral", "https://api.mistral.ai"),
  openAiCompatibleCloudPreset("cohere", "Cohere", "https://api.cohere.ai"),
  openAiCompatibleCloudPreset("fireworks", "Fireworks", "https://api.fireworks.ai/inference"),
  openAiCompatibleCloudPreset("perplexity", "Perplexity", "https://api.perplexity.ai"),

  // —— 国内云平台组（多为 OpenAI 兼容端点）——
  openAiCompatibleCloudPreset(
    "dashscope",
    "阿里云百炼（DashScope）",
    "https://dashscope.aliyuncs.com/compatible-mode",
  ),
  openAiCompatibleCloudPreset("zhipu", "智谱 GLM", "https://open.bigmodel.cn/api/paas/v4"),
  openAiCompatibleCloudPreset("moonshot", "月之暗面 Moonshot", "https://api.moonshot.cn"),
  openAiCompatibleCloudPreset("siliconflow", "硅基流动 SiliconFlow", "https://api.siliconflow.cn"),

  // —— 本地/自托管平台（端点/鉴权不同，分别点名）——
  OLLAMA_PRESET,
  LM_STUDIO_PRESET,
  VLLM_PRESET,
  LLAMACPP_PRESET,
  LOCALAI_PRESET,
];

/** 按平台 id 建立的索引表，供快速查找 */
const PRESET_BY_ID: ReadonlyMap<string, ProviderPreset> = new Map(
  PROVIDER_PRESETS.map((p) => [p.id, p]),
);

/** 按平台 id 查找内置预设；未找到返回 undefined */
export function getPreset(id: string): ProviderPreset | undefined {
  return PRESET_BY_ID.get(id);
}

// ===========================================================================
// 预设合法性校验
// ===========================================================================

/** 预设校验结果：合法时 valid=true；非法时携带逐项错误信息 */
export interface PresetValidation {
  /** 预设是否合法可套用 */
  valid: boolean;
  /** 非法原因列表（合法时为空数组） */
  errors: string[];
}

/**
 * 判断一个字符串是否为非空有效值（去除首尾空白后仍非空）。
 */
function isNonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0;
}

/**
 * 判断 AuthInjection 是否为合法声明。
 *
 * 合法条件：
 * - 必须声明注入位置 in（header/query/none）；
 * - 当 in 为 header/query 时，必须有参数名 name 与值模板 valueTemplate（否则无法注入密钥）；
 *   例外：kind="sigv4" 的 header 形态由代码级签名适配器处理，不要求 name/valueTemplate；
 * - in="none"（无鉴权）无需 name/valueTemplate。
 */
function isValidAuth(auth: AuthInjection | undefined): boolean {
  if (!auth || typeof auth !== "object") {
    return false;
  }
  if (auth.in !== "header" && auth.in !== "query" && auth.in !== "none") {
    return false;
  }
  // 无鉴权：无需更多字段
  if (auth.in === "none" || auth.kind === "none") {
    return true;
  }
  // SigV4 特例：由专用适配器处理签名，不要求简单的 name/valueTemplate 模板
  if (auth.kind === "sigv4") {
    return true;
  }
  // header/query 简单形态：必须有 name 与 valueTemplate 才能注入 {key}
  return isNonEmptyString(auth.name) && isNonEmptyString(auth.valueTemplate);
}

/**
 * 判断 ModelListingConfig 是否为合法声明。
 *
 * 合法条件：必须声明鉴权 auth（合法）与响应解析映射 responseMapping
 *（含非空 arrayPointer 与 idField）。path 可缺省（表示不支持列表 API），
 * 但作为"内置预设"要求 path 存在，以保证开箱可用。
 */
function isValidModelListing(listing: ModelListingConfig | undefined): boolean {
  if (!listing || typeof listing !== "object") {
    return false;
  }
  if (!isNonEmptyString(listing.path)) {
    return false;
  }
  if (!isValidAuth(listing.auth)) {
    return false;
  }
  const mapping = listing.responseMapping;
  if (!mapping || typeof mapping !== "object") {
    return false;
  }
  return isNonEmptyString(mapping.arrayPointer) && isNonEmptyString(mapping.idField);
}

/**
 * 校验一份预设是否合法可套用。
 *
 * 必需字段：baseUrl（非空）、AuthInjection（合法）、ModelListingConfig（合法）。
 * 任一缺失或非法即判定为"非法预设"，拒绝套用（见 applyPreset）。
 *
 * @param preset 待校验的预设（允许传入部分构造好的对象，故参数类型放宽）
 */
export function validatePreset(preset: ProviderPreset | undefined): PresetValidation {
  const errors: string[] = [];

  if (!preset || typeof preset !== "object") {
    return { valid: false, errors: ["预设缺失：未找到对应平台的 Provider 预设"] };
  }

  if (!isNonEmptyString(preset.baseUrl)) {
    errors.push("预设非法：缺少 baseUrl 默认值");
  }
  if (!isValidAuth(preset.auth)) {
    errors.push("预设非法：缺少或非法的 AuthInjection（鉴权注入声明）");
  }
  if (!isValidModelListing(preset.modelListing)) {
    errors.push("预设非法：缺少或非法的 ModelListingConfig（模型列表端点配置）");
  }

  return { valid: errors.length === 0, errors };
}

// ===========================================================================
// 套用预设
// ===========================================================================

/**
 * applyPreset 的套用结果：
 * - ok=true  ：套用成功，config 为合并了预设默认值的 Provider 配置草稿。
 * - ok=false ：预设缺失或非法，拒绝套用，errors 给出原因，不产生 config。
 */
export type ApplyPresetResult =
  | { ok: true; config: Partial<ProviderConfig> }
  | { ok: false; errors: string[] };

/**
 * 把预设声明套用为 Provider 配置草稿的默认值，但不覆盖用户已手工填写的值。
 *
 * 行为约定（对应 Requirement 4.3 / 4.7）：
 * - 仅当用户尚未填写某字段时，才用预设的默认值填充；用户已填写的值一律保留。
 *   "已填写"的判断：baseUrl 为非空字符串即视为已填；其余结构化字段
 *   （auth/modelListing/modelProbe/isLocal）只要 userInput 中存在该键即视为用户已指定。
 * - 若预设缺失或非法（缺 baseUrl/AuthInjection/ModelListingConfig），拒绝套用并返回错误，
 *   不产生任何 config（调用方据此不创建处于无效状态的 Provider）。
 *
 * @param preset    所选平台对应的内置预设（可能为 undefined，表示预设缺失）
 * @param userInput 用户已手工填写的部分字段（仅这些字段需被保留、不被覆盖）
 */
export function applyPreset(
  preset: ProviderPreset | undefined,
  userInput: Partial<ProviderConfig> = {},
): ApplyPresetResult {
  // 先做合法性校验：预设缺失或非法时拒绝套用，不创建无效 Provider
  const validation = validatePreset(preset);
  if (!validation.valid || !preset) {
    return { ok: false, errors: validation.errors };
  }

  // 以用户已填值为基底，仅填补用户未提供的字段（不覆盖用户手填值）
  const config: Partial<ProviderConfig> = { ...userInput };

  // baseUrl：仅当用户未填写（空/缺省）时套用预设默认值
  if (!isNonEmptyString(userInput.baseUrl)) {
    config.baseUrl = preset.baseUrl;
  }

  // modelListing：用户未显式指定时套用预设
  if (userInput.modelListing === undefined) {
    config.modelListing = preset.modelListing;
  }

  // modelProbe：用户未显式指定时套用预设
  if (userInput.modelProbe === undefined) {
    config.modelProbe = preset.modelProbe;
  }

  // isLocal：用户未显式指定时套用预设（本地平台默认为 true）
  if (userInput.isLocal === undefined) {
    config.isLocal = preset.isLocal ?? false;
  }

  return { ok: true, config };
}
