import { describe, it, expect } from "vitest";
import type {
  AuthInjection,
  ModelListingConfig,
  ModelProbeConfig,
  ProviderConfig,
} from "@shared/types";
import {
  PROVIDER_PRESETS,
  getPreset,
  validatePreset,
  applyPreset,
  type ProviderPreset,
} from "./providerPresets";

// 套用预设（applyPreset / validatePreset）单元测试
//
// 覆盖任务 8.4 要求的各分支，对应需求 4.3 / 4.4 / 4.7：
// - 套用默认值：对用户未填写的字段套用预设默认值（baseUrl/modelListing/modelProbe/isLocal）。
// - 不覆盖用户手填值：用户已手工填写的字段（baseUrl、modelListing 等）一律保留、不被覆盖。
// - 预设非法时拒绝并报错：预设缺失或缺 baseUrl/auth/modelListing 时返回错误、不产生 config。
// - 本地预设无鉴权：本地预设（Ollama、LM Studio 等）auth.in === "none" 且 isLocal，
//   套用后 config.isLocal === true。

/** 构造一份合法的鉴权注入声明（OpenAI 兼容 Bearer 形态），供测试复用 */
function makeValidAuth(): AuthInjection {
  return { in: "header", kind: "bearer", name: "Authorization", valueTemplate: "Bearer {key}" };
}

/** 构造一份合法的模型列表端点配置，供测试复用 */
function makeValidListing(): ModelListingConfig {
  return {
    path: "/v1/models",
    method: "GET",
    auth: makeValidAuth(),
    responseMapping: { arrayPointer: "/data", idField: "id" },
  };
}

/** 构造一份合法的模型探测端点配置，供测试复用 */
function makeValidProbe(): ModelProbeConfig {
  return {
    path: "/v1/chat/completions",
    method: "POST",
    auth: makeValidAuth(),
    bodyTemplate: { model: "{model}", max_tokens: 1 },
    availableStatuses: [200],
  };
}

/** 构造一份合法的云平台预设，供"套用/不覆盖"用例复用 */
function makeValidCloudPreset(overrides: Partial<ProviderPreset> = {}): ProviderPreset {
  return {
    id: "test-cloud",
    displayName: "Test Cloud",
    group: "cloud",
    baseUrl: "https://api.test.example.com",
    auth: makeValidAuth(),
    modelListing: makeValidListing(),
    modelProbe: makeValidProbe(),
    ...overrides,
  };
}

describe("validatePreset 预设合法性校验", () => {
  it("合法预设（含 baseUrl/auth/modelListing）应通过校验", () => {
    const result = validatePreset(makeValidCloudPreset());

    expect(result.valid).toBe(true);
    expect(result.errors).toEqual([]);
  });

  it("预设缺失（undefined）应判定非法并给出原因", () => {
    const result = validatePreset(undefined);

    expect(result.valid).toBe(false);
    // 至少包含一条"预设缺失"类错误说明
    expect(result.errors.length).toBeGreaterThan(0);
  });

  it("缺少 baseUrl 应判定非法", () => {
    // 用空字符串模拟缺失的 baseUrl
    const preset = makeValidCloudPreset({ baseUrl: "" });

    const result = validatePreset(preset);

    expect(result.valid).toBe(false);
    expect(result.errors.some((e) => e.includes("baseUrl"))).toBe(true);
  });

  it("缺少 AuthInjection（非法 auth）应判定非法", () => {
    // 缺少 name/valueTemplate 的 header 鉴权无法注入密钥，属非法
    const preset = makeValidCloudPreset({
      auth: { in: "header", kind: "header" } as AuthInjection,
    });

    const result = validatePreset(preset);

    expect(result.valid).toBe(false);
    expect(result.errors.some((e) => e.includes("AuthInjection"))).toBe(true);
  });

  it("缺少 ModelListingConfig（非法 modelListing）应判定非法", () => {
    // responseMapping 缺失 arrayPointer/idField，属非法列表配置
    const preset = makeValidCloudPreset({
      modelListing: {
        path: "/v1/models",
        auth: makeValidAuth(),
        responseMapping: { arrayPointer: "", idField: "" },
      },
    });

    const result = validatePreset(preset);

    expect(result.valid).toBe(false);
    expect(result.errors.some((e) => e.includes("ModelListingConfig"))).toBe(true);
  });
});

describe("applyPreset 套用预设默认值", () => {
  it("用户未填写时应套用预设的 baseUrl/modelListing/modelProbe/isLocal 默认值", () => {
    const preset = makeValidCloudPreset();

    const result = applyPreset(preset, {});

    expect(result.ok).toBe(true);
    if (!result.ok) return; // 收窄类型，便于后续断言
    // 未手填的字段应被预设默认值填充
    expect(result.config.baseUrl).toBe(preset.baseUrl);
    expect(result.config.modelListing).toEqual(preset.modelListing);
    expect(result.config.modelProbe).toEqual(preset.modelProbe);
    // 云平台预设未声明 isLocal，默认为 false
    expect(result.config.isLocal).toBe(false);
  });

  it("未传 userInput 时应等价于空输入，完整套用默认值", () => {
    const preset = makeValidCloudPreset();

    const result = applyPreset(preset);

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.config.baseUrl).toBe(preset.baseUrl);
    expect(result.config.modelListing).toEqual(preset.modelListing);
  });
});

describe("applyPreset 不覆盖用户已手填的值", () => {
  it("用户已填 baseUrl 时应保留用户值、不被预设覆盖", () => {
    const preset = makeValidCloudPreset();
    const userInput: Partial<ProviderConfig> = { baseUrl: "https://my-gateway.internal" };

    const result = applyPreset(preset, userInput);

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    // baseUrl 保留用户手填值
    expect(result.config.baseUrl).toBe("https://my-gateway.internal");
    // 未手填的 modelListing 仍套用预设默认值
    expect(result.config.modelListing).toEqual(preset.modelListing);
  });

  it("用户已显式指定 modelListing/modelProbe/isLocal 时应全部保留", () => {
    const preset = makeValidCloudPreset();
    const userListing: ModelListingConfig = {
      path: "/custom/models",
      auth: makeValidAuth(),
      responseMapping: { arrayPointer: "/items", idField: "model" },
    };
    const userProbe: ModelProbeConfig = {
      path: "/custom/ping",
      auth: makeValidAuth(),
      availableStatuses: [204],
    };
    const userInput: Partial<ProviderConfig> = {
      modelListing: userListing,
      modelProbe: userProbe,
      isLocal: true,
    };

    const result = applyPreset(preset, userInput);

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    // 用户显式指定的结构化字段一律保留，不被预设覆盖
    expect(result.config.modelListing).toEqual(userListing);
    expect(result.config.modelProbe).toEqual(userProbe);
    expect(result.config.isLocal).toBe(true);
    // 未手填的 baseUrl 仍套用预设默认值
    expect(result.config.baseUrl).toBe(preset.baseUrl);
  });

  it("空白字符串的 baseUrl 视为未填写，应被预设默认值填充", () => {
    const preset = makeValidCloudPreset();
    const userInput: Partial<ProviderConfig> = { baseUrl: "   " };

    const result = applyPreset(preset, userInput);

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    // 纯空白不算有效手填值，应套用预设默认 baseUrl
    expect(result.config.baseUrl).toBe(preset.baseUrl);
  });

  it("应保留 userInput 中与套用无关的其它字段（如 name）", () => {
    const preset = makeValidCloudPreset();
    const userInput: Partial<ProviderConfig> = { name: "我的网关" };

    const result = applyPreset(preset, userInput);

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    // name 属用户自有字段，套用不应丢失
    expect(result.config.name).toBe("我的网关");
  });
});

describe("applyPreset 预设非法时拒绝套用并报错", () => {
  it("预设缺失（undefined）时应拒绝套用、不产生 config", () => {
    const result = applyPreset(undefined, { name: "x" });

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.errors.length).toBeGreaterThan(0);
    // 失败结果不应携带 config 字段
    expect("config" in result).toBe(false);
  });

  it("预设缺 baseUrl 时应拒绝套用并返回错误", () => {
    const preset = makeValidCloudPreset({ baseUrl: "" });

    const result = applyPreset(preset, {});

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.errors.some((e) => e.includes("baseUrl"))).toBe(true);
    expect("config" in result).toBe(false);
  });

  it("预设 auth 非法时应拒绝套用并返回错误", () => {
    const preset = makeValidCloudPreset({
      auth: { in: "header", kind: "header" } as AuthInjection,
    });

    const result = applyPreset(preset, {});

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.errors.some((e) => e.includes("AuthInjection"))).toBe(true);
  });

  it("预设 modelListing 非法时应拒绝套用并返回错误", () => {
    const preset = makeValidCloudPreset({
      modelListing: {
        auth: makeValidAuth(),
        responseMapping: { arrayPointer: "", idField: "" },
      },
    });

    const result = applyPreset(preset, {});

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.errors.some((e) => e.includes("ModelListingConfig"))).toBe(true);
  });
});

describe("本地预设无鉴权（auth.in === 'none' 且 isLocal）", () => {
  // 本地/自托管平台预设 id（设计中内置的本地推理服务）
  const localPresetIds = ["ollama", "lm-studio", "vllm", "llama-cpp-server", "localai"];

  it.each(localPresetIds)("本地预设 %s 应为无鉴权且标记 isLocal", (id) => {
    const preset = getPreset(id);

    expect(preset).toBeDefined();
    expect(preset?.group).toBe("local");
    // 本地预设无鉴权：auth.in === "none"
    expect(preset?.auth.in).toBe("none");
    // 本地预设标记为自托管
    expect(preset?.isLocal).toBe(true);
  });

  it("本地预设的模型列表/探测端点同样声明为无鉴权", () => {
    const preset = getPreset("ollama");

    expect(preset).toBeDefined();
    // 列表与探测端点的鉴权也应为 none，避免对本地服务要求密钥
    expect(preset?.modelListing.auth.in).toBe("none");
    expect(preset?.modelProbe.auth.in).toBe("none");
  });

  it("套用本地预设后 config.isLocal 应为 true（放宽密钥校验）", () => {
    const preset = getPreset("lm-studio");
    expect(preset).toBeDefined();

    const result = applyPreset(preset, {});

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    // 本地预设套用后应标记 isLocal，供后续放宽 apiKeyRef 校验（需求 4.4）
    expect(result.config.isLocal).toBe(true);
    // baseUrl 默认指向本地回环地址
    expect(result.config.baseUrl).toContain("localhost");
  });

  it("内置预设集中每个本地预设都满足无鉴权约束", () => {
    const locals = PROVIDER_PRESETS.filter((p) => p.group === "local");
    // 至少包含设计声明的 5 个本地平台
    expect(locals.length).toBeGreaterThanOrEqual(5);
    for (const p of locals) {
      expect(p.auth.in).toBe("none");
      expect(p.isLocal).toBe(true);
    }
  });
});
