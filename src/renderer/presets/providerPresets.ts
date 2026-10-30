// 渲染侧内置 Provider 预设（只读数据表达）
//
// 来源与一致性约定（务必遵守）：
// - 本模块是主进程 `src/main/presets/providerPresets.ts` 的「渲染侧等价只读镜像」。
//   由于渲染进程 tsconfig 的 rootDir 限定在 src/renderer（仅引用 @shared 共享类型），
//   不便直接 import 主进程模块，故在此以等价的只读数据重新表达「分组 + 默认值」，
//   并保持与 providerPresets.ts 完全一致：
//     · 相同的平台 id / displayName / 分组（cloud/local）/ baseUrl 默认值；
//     · 本地平台一律无鉴权（auth.in = "none"，kind = "none"，isLocal = true）；
//     · 云平台的 AuthInjection / ModelListingConfig / ModelProbeConfig 与主进程声明一致。
// - 本模块仅承载声明式默认模板与「套用/校验」纯逻辑，不发起网络请求、不访问文件系统；
//   套用预设时只提供默认值、绝不覆盖用户已手填值（见 applyPreset）。
//
// 若主进程预设有增删改，请同步更新此镜像，确保两侧语义一致。

import type {
  AuthInjection,
  ModelListingConfig,
  ModelProbeConfig,
  ProviderConfig,
} from '@shared/types';

// ===========================================================================
// 预设类型声明（与主进程 ProviderPreset 对齐）
// ===========================================================================

/** 预设分组：云平台（公网）/ 本地（自托管、通常无鉴权） */
export type PresetGroup = 'cloud' | 'local';

/**
 * 单份内置 Provider 预设：平台维度的声明式默认模板。
 * 字段语义与主进程 `ProviderPreset` 完全一致（见 providerPresets.ts 注释）。
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
// 可复用的鉴权/端点声明片段（与主进程保持一致）
// ===========================================================================

/** OpenAI 兼容：Authorization: Bearer {key} 的 header 鉴权 */
const BEARER_AUTH: AuthInjection = {
  in: 'header',
  kind: 'bearer',
  name: 'Authorization',
  valueTemplate: 'Bearer {key}',
};

/** OpenAI 兼容：模型列表端点（/v1/models → /data[].id） */
const OPENAI_COMPATIBLE_LISTING: ModelListingConfig = {
  path: '/v1/models',
  method: 'GET',
  auth: BEARER_AUTH,
  responseMapping: { arrayPointer: '/data', idField: 'id' },
};

/** OpenAI 兼容：探测端点（/v1/chat/completions 最小代价 POST） */
const OPENAI_COMPATIBLE_PROBE: ModelProbeConfig = {
  path: '/v1/chat/completions',
  method: 'POST',
  auth: BEARER_AUTH,
  bodyTemplate: {
    model: '{model}',
    messages: [{ role: 'user', content: 'ping' }],
    max_tokens: 1,
  },
  availableStatuses: [200],
};

/** 构造一份标准 OpenAI 兼容云平台预设（仅 baseUrl 与密钥不同） */
function openAiCompatibleCloudPreset(
  id: string,
  displayName: string,
  baseUrl: string,
): ProviderPreset {
  return {
    id,
    displayName,
    group: 'cloud',
    baseUrl,
    auth: BEARER_AUTH,
    modelListing: OPENAI_COMPATIBLE_LISTING,
    modelProbe: OPENAI_COMPATIBLE_PROBE,
  };
}

/** 构造一份 OpenAI 兼容本地平台预设（无鉴权，baseUrl 指向 localhost） */
function openAiCompatibleLocalPreset(
  id: string,
  displayName: string,
  baseUrl: string,
): ProviderPreset {
  // 本地无鉴权：auth.in="none"，拉取/探测端点均不注入密钥
  const noneAuth: AuthInjection = { in: 'none', kind: 'none' };
  return {
    id,
    displayName,
    group: 'local',
    baseUrl,
    isLocal: true,
    auth: noneAuth,
    modelListing: {
      path: '/v1/models',
      method: 'GET',
      auth: noneAuth,
      responseMapping: { arrayPointer: '/data', idField: 'id' },
    },
    modelProbe: {
      path: '/v1/chat/completions',
      method: 'POST',
      auth: noneAuth,
      bodyTemplate: {
        model: '{model}',
        messages: [{ role: 'user', content: 'ping' }],
        max_tokens: 1,
      },
      availableStatuses: [200],
    },
  };
}

// ===========================================================================
// 云平台预设（点名列出差异明显的平台）
// ===========================================================================

/** OpenAI：OpenAI 兼容标准形态 */
const OPENAI_PRESET: ProviderPreset = openAiCompatibleCloudPreset(
  'openai',
  'OpenAI',
  'https://api.openai.com',
);

/** Azure OpenAI：原生（deployment 维度），api-key 头 + api-version 查询 */
const AZURE_OPENAI_PRESET: ProviderPreset = {
  id: 'azure-openai',
  displayName: 'Azure OpenAI',
  group: 'cloud',
  baseUrl: 'https://<your-resource>.openai.azure.com',
  auth: {
    in: 'header',
    kind: 'header',
    name: 'api-key',
    valueTemplate: '{key}',
  },
  modelListing: {
    path: '/openai/deployments?api-version=2024-10-21',
    method: 'GET',
    auth: {
      in: 'header',
      kind: 'header',
      name: 'api-key',
      valueTemplate: '{key}',
    },
    responseMapping: { arrayPointer: '/data', idField: 'id' },
  },
  modelProbe: {
    path: '/openai/deployments/{model}/chat/completions?api-version=2024-10-21',
    method: 'POST',
    auth: {
      in: 'header',
      kind: 'header',
      name: 'api-key',
      valueTemplate: '{key}',
    },
    bodyTemplate: {
      messages: [{ role: 'user', content: 'ping' }],
      max_tokens: 1,
    },
    availableStatuses: [200],
  },
};

/** Anthropic：原生，x-api-key + anthropic-version */
const ANTHROPIC_PRESET: ProviderPreset = {
  id: 'anthropic',
  displayName: 'Anthropic',
  group: 'cloud',
  baseUrl: 'https://api.anthropic.com',
  auth: {
    in: 'header',
    kind: 'header',
    name: 'x-api-key',
    valueTemplate: '{key}',
    extraHeaders: { 'anthropic-version': '2023-06-01' },
  },
  modelListing: {
    path: '/v1/models',
    method: 'GET',
    auth: {
      in: 'header',
      kind: 'header',
      name: 'x-api-key',
      valueTemplate: '{key}',
      extraHeaders: { 'anthropic-version': '2023-06-01' },
    },
    responseMapping: { arrayPointer: '/data', idField: 'id' },
  },
  modelProbe: {
    path: '/v1/messages',
    method: 'POST',
    auth: {
      in: 'header',
      kind: 'header',
      name: 'x-api-key',
      valueTemplate: '{key}',
      extraHeaders: { 'anthropic-version': '2023-06-01' },
    },
    bodyTemplate: {
      model: '{model}',
      max_tokens: 1,
      messages: [{ role: 'user', content: 'ping' }],
    },
    availableStatuses: [200],
  },
};

/** Google Gemini：原生，密钥走查询参数 ?key={key} */
const GEMINI_PRESET: ProviderPreset = {
  id: 'google-gemini',
  displayName: 'Google Gemini',
  group: 'cloud',
  baseUrl: 'https://generativelanguage.googleapis.com',
  auth: { in: 'query', kind: 'query', name: 'key', valueTemplate: '{key}' },
  modelListing: {
    path: '/v1beta/models',
    method: 'GET',
    auth: { in: 'query', kind: 'query', name: 'key', valueTemplate: '{key}' },
    responseMapping: { arrayPointer: '/models', idField: 'name' },
  },
  modelProbe: {
    path: '/v1beta/models/{model}:generateContent',
    method: 'POST',
    auth: { in: 'query', kind: 'query', name: 'key', valueTemplate: '{key}' },
    bodyTemplate: {
      contents: [{ parts: [{ text: 'ping' }] }],
      generationConfig: { maxOutputTokens: 1 },
    },
    availableStatuses: [200],
  },
};

/** AWS Bedrock：原生，SigV4 签名鉴权（代码级特例） */
const BEDROCK_PRESET: ProviderPreset = {
  id: 'aws-bedrock',
  displayName: 'AWS Bedrock',
  group: 'cloud',
  baseUrl: 'https://bedrock.us-east-1.amazonaws.com',
  auth: { in: 'header', kind: 'sigv4' },
  modelListing: {
    path: '/foundation-models',
    method: 'GET',
    auth: { in: 'header', kind: 'sigv4' },
    responseMapping: { arrayPointer: '/modelSummaries', idField: 'modelId' },
  },
  modelProbe: {
    path: '/model/{model}/invoke',
    method: 'POST',
    auth: { in: 'header', kind: 'sigv4' },
    bodyTemplate: {},
    availableStatuses: [200],
  },
};

// ===========================================================================
// 本地平台预设（端点/鉴权不同而分别点名）
// ===========================================================================

/** Ollama（本地）：原生（含 OpenAI 兼容层），无鉴权 */
const OLLAMA_PRESET: ProviderPreset = {
  id: 'ollama',
  displayName: 'Ollama（本地）',
  group: 'local',
  baseUrl: 'http://localhost:11434',
  isLocal: true,
  auth: { in: 'none', kind: 'none' },
  modelListing: {
    path: '/api/tags',
    method: 'GET',
    auth: { in: 'none', kind: 'none' },
    responseMapping: { arrayPointer: '/models', idField: 'name' },
  },
  modelProbe: {
    path: '/api/show',
    method: 'POST',
    auth: { in: 'none', kind: 'none' },
    bodyTemplate: { name: '{model}' },
    availableStatuses: [200],
  },
};

/** LM Studio（本地）：OpenAI 兼容、无鉴权，默认端口 1234 */
const LM_STUDIO_PRESET: ProviderPreset = openAiCompatibleLocalPreset(
  'lm-studio',
  'LM Studio（本地）',
  'http://localhost:1234',
);

/** vLLM（本地）：OpenAI 兼容、无鉴权，默认端口 8000 */
const VLLM_PRESET: ProviderPreset = openAiCompatibleLocalPreset(
  'vllm',
  'vLLM（本地）',
  'http://localhost:8000',
);

/** llama.cpp server（本地）：OpenAI 兼容、无鉴权，默认端口 8080 */
const LLAMACPP_PRESET: ProviderPreset = openAiCompatibleLocalPreset(
  'llama-cpp-server',
  'llama.cpp server（本地）',
  'http://localhost:8080',
);

/** LocalAI（本地）：OpenAI 兼容、无鉴权，默认端口 8080 */
const LOCALAI_PRESET: ProviderPreset = openAiCompatibleLocalPreset(
  'localai',
  'LocalAI（本地）',
  'http://localhost:8080',
);

// ===========================================================================
// 内置预设集合（注册表，供 UI 分组展示）
// ===========================================================================

/**
 * 全部内置 Provider 预设（有序列表，与主进程 PROVIDER_PRESETS 对齐）。
 */
export const PROVIDER_PRESETS: readonly ProviderPreset[] = [
  // —— 云平台（点名差异明显者）——
  OPENAI_PRESET,
  AZURE_OPENAI_PRESET,
  ANTHROPIC_PRESET,
  GEMINI_PRESET,
  BEDROCK_PRESET,

  // —— OpenAI 兼容云平台组（高度同质，差异仅 baseUrl）——
  openAiCompatibleCloudPreset('deepseek', 'DeepSeek', 'https://api.deepseek.com'),
  openAiCompatibleCloudPreset('xai', 'xAI（Grok）', 'https://api.x.ai'),
  openAiCompatibleCloudPreset('groq', 'Groq', 'https://api.groq.com/openai'),
  openAiCompatibleCloudPreset('openrouter', 'OpenRouter', 'https://openrouter.ai/api'),
  openAiCompatibleCloudPreset('together', 'Together', 'https://api.together.xyz'),
  openAiCompatibleCloudPreset('mistral', 'Mistral', 'https://api.mistral.ai'),
  openAiCompatibleCloudPreset('cohere', 'Cohere', 'https://api.cohere.ai'),
  openAiCompatibleCloudPreset('fireworks', 'Fireworks', 'https://api.fireworks.ai/inference'),
  openAiCompatibleCloudPreset('perplexity', 'Perplexity', 'https://api.perplexity.ai'),

  // —— 国内云平台组（多为 OpenAI 兼容端点）——
  openAiCompatibleCloudPreset(
    'dashscope',
    '阿里云百炼（DashScope）',
    'https://dashscope.aliyuncs.com/compatible-mode',
  ),
  openAiCompatibleCloudPreset('zhipu', '智谱 GLM', 'https://open.bigmodel.cn/api/paas/v4'),
  openAiCompatibleCloudPreset('moonshot', '月之暗面 Moonshot', 'https://api.moonshot.cn'),
  openAiCompatibleCloudPreset('siliconflow', '硅基流动 SiliconFlow', 'https://api.siliconflow.cn'),

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

/** 云平台预设子集（供 UI 的「云」分组展示） */
export const CLOUD_PRESETS: readonly ProviderPreset[] = PROVIDER_PRESETS.filter(
  (p) => p.group === 'cloud',
);

/** 本地平台预设子集（供 UI 的「本地」分组展示） */
export const LOCAL_PRESETS: readonly ProviderPreset[] = PROVIDER_PRESETS.filter(
  (p) => p.group === 'local',
);

// ===========================================================================
// 套用预设（与主进程 applyPreset 语义一致：只填默认值、不覆盖用户手填值）
// ===========================================================================

/** 判断一个字符串是否为非空有效值（去除首尾空白后仍非空） */
function isNonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0;
}

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
 * 行为与主进程 applyPreset 对齐（对应 Requirement 4.3 / 4.7）：
 * - 仅当用户尚未填写某字段时，才用预设的默认值填充；用户已填写的值一律保留。
 *   baseUrl 为非空字符串即视为已填；其余结构化字段（modelListing/modelProbe/isLocal）
 *   只要 userInput 中存在该键即视为用户已指定。
 * - 本地预设的 isLocal 默认为 true（本地无鉴权，auth.in="none"）。
 *
 * 注意：本渲染侧实现不做 SecretStore 可解析性等运行时校验（那属主进程职责），
 * 仅对「预设本身是否存在且含 baseUrl」做最小校验，保证不产生无效草稿。
 *
 * @param preset    所选平台对应的内置预设（可能为 undefined，表示预设缺失）
 * @param userInput 用户已手工填写的部分字段（仅这些字段需被保留、不被覆盖）
 */
export function applyPreset(
  preset: ProviderPreset | undefined,
  userInput: Partial<ProviderConfig> = {},
): ApplyPresetResult {
  // 预设缺失或缺 baseUrl：拒绝套用，不创建无效草稿
  if (!preset) {
    return { ok: false, errors: ['预设缺失：未找到对应平台的 Provider 预设'] };
  }
  if (!isNonEmptyString(preset.baseUrl)) {
    return { ok: false, errors: ['预设非法：缺少 baseUrl 默认值'] };
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
