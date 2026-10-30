import { describe, it, expect } from "vitest";

import type { ProviderConfig } from "@shared/types";

import { validate } from "./validate";

// validate 配置校验纯函数的单元测试
//
// 覆盖任务 3.4 要求的各分支：
// - 合法配置整体通过
// - 非法 baseUrl（协议错误 / 无法解析）
// - 空 name / 超长 name（> 100）
// - 空 models / 超限 models（> 50）
// - 非正 timeoutMs（0、负数、小数）
// - 本地无鉴权放宽（isLocal / auth.in=none / auth.kind=none 允许 apiKeyRef 为空）
// - 非无鉴权场景 apiKeyRef 为空应报错
// - candidateModels id 重复
//
// 对应需求：1.5、1.6、1.7、4.4

/**
 * 构造一份「全部合法」的基准 ProviderConfig，供各用例按需覆盖单个字段。
 * 默认非本地、需要鉴权（apiKeyRef 非空）。
 */
function makeValidConfig(overrides: Partial<ProviderConfig> = {}): ProviderConfig {
  return {
    id: "p-1",
    name: "openai",
    baseUrl: "https://api.openai.com",
    apiKeyRef: "secret-ref-1",
    models: ["gpt-4o-mini"],
    ...overrides,
  };
}

/** 判断校验结果中是否存在指定字段的错误 */
function hasErrorOn(
  result: ReturnType<typeof validate>,
  field: string,
): boolean {
  return result.errors.some((e) => e.field === field);
}

describe("validate", () => {
  // -------------------------------------------------------------------------
  // 合法基准：整体通过
  // -------------------------------------------------------------------------
  it("合法配置应整体通过且无错误", () => {
    const result = validate(makeValidConfig());
    expect(result.valid).toBe(true);
    expect(result.errors).toHaveLength(0);
  });

  it("http 协议的 baseUrl 也应合法", () => {
    const result = validate(makeValidConfig({ baseUrl: "http://localhost:11434" }));
    expect(result.valid).toBe(true);
  });

  // -------------------------------------------------------------------------
  // baseUrl 非法（需求 1.5 / 1.6）
  // -------------------------------------------------------------------------
  it("非法 baseUrl（非 http/https 协议）应报错", () => {
    const result = validate(makeValidConfig({ baseUrl: "ftp://example.com" }));
    expect(result.valid).toBe(false);
    expect(hasErrorOn(result, "baseUrl")).toBe(true);
  });

  it("非法 baseUrl（无法解析的字符串）应报错", () => {
    const result = validate(makeValidConfig({ baseUrl: "not a url" }));
    expect(result.valid).toBe(false);
    expect(hasErrorOn(result, "baseUrl")).toBe(true);
  });

  it("空字符串 baseUrl 应报错", () => {
    const result = validate(makeValidConfig({ baseUrl: "" }));
    expect(result.valid).toBe(false);
    expect(hasErrorOn(result, "baseUrl")).toBe(true);
  });

  // -------------------------------------------------------------------------
  // name 校验（需求 1.5 / 1.6）
  // -------------------------------------------------------------------------
  it("空 name 应报错", () => {
    const result = validate(makeValidConfig({ name: "" }));
    expect(result.valid).toBe(false);
    expect(hasErrorOn(result, "name")).toBe(true);
  });

  it("恰好 100 字符的 name 应通过（边界内）", () => {
    const result = validate(makeValidConfig({ name: "a".repeat(100) }));
    expect(hasErrorOn(result, "name")).toBe(false);
  });

  it("超长 name（101 字符）应报错", () => {
    const result = validate(makeValidConfig({ name: "a".repeat(101) }));
    expect(result.valid).toBe(false);
    expect(hasErrorOn(result, "name")).toBe(true);
  });

  // -------------------------------------------------------------------------
  // models 校验（需求 1.5 / 1.6）
  // -------------------------------------------------------------------------
  it("空 models 应报错", () => {
    const result = validate(makeValidConfig({ models: [] }));
    expect(result.valid).toBe(false);
    expect(hasErrorOn(result, "models")).toBe(true);
  });

  it("恰好 50 项的 models 应通过（边界内）", () => {
    const models = Array.from({ length: 50 }, (_, i) => `model-${i}`);
    const result = validate(makeValidConfig({ models }));
    expect(hasErrorOn(result, "models")).toBe(false);
  });

  it("超限 models（51 项）应报错", () => {
    const models = Array.from({ length: 51 }, (_, i) => `model-${i}`);
    const result = validate(makeValidConfig({ models }));
    expect(result.valid).toBe(false);
    expect(hasErrorOn(result, "models")).toBe(true);
  });

  // -------------------------------------------------------------------------
  // timeoutMs 校验（需求 1.5 / 1.6）
  // -------------------------------------------------------------------------
  it("timeoutMs 为正整数应通过", () => {
    const result = validate(makeValidConfig({ timeoutMs: 8000 }));
    expect(hasErrorOn(result, "timeoutMs")).toBe(false);
  });

  it("timeoutMs 为 0 应报错（非正）", () => {
    const result = validate(makeValidConfig({ timeoutMs: 0 }));
    expect(result.valid).toBe(false);
    expect(hasErrorOn(result, "timeoutMs")).toBe(true);
  });

  it("timeoutMs 为负数应报错", () => {
    const result = validate(makeValidConfig({ timeoutMs: -1 }));
    expect(result.valid).toBe(false);
    expect(hasErrorOn(result, "timeoutMs")).toBe(true);
  });

  it("timeoutMs 为小数应报错（非整数）", () => {
    const result = validate(makeValidConfig({ timeoutMs: 1500.5 }));
    expect(result.valid).toBe(false);
    expect(hasErrorOn(result, "timeoutMs")).toBe(true);
  });

  it("未提供 timeoutMs 不应产生 timeoutMs 错误", () => {
    const result = validate(makeValidConfig({ timeoutMs: undefined }));
    expect(hasErrorOn(result, "timeoutMs")).toBe(false);
  });

  // -------------------------------------------------------------------------
  // apiKeyRef：非无鉴权场景必须非空（需求 4.4 反向）
  // -------------------------------------------------------------------------
  it("非本地且需鉴权时，空 apiKeyRef 应报错", () => {
    const result = validate(makeValidConfig({ apiKeyRef: "" }));
    expect(result.valid).toBe(false);
    expect(hasErrorOn(result, "apiKeyRef")).toBe(true);
  });

  // -------------------------------------------------------------------------
  // 本地 / 无鉴权放宽：允许 apiKeyRef 为空（需求 4.4）
  // -------------------------------------------------------------------------
  it("isLocal=true 时允许空 apiKeyRef（放宽）", () => {
    const result = validate(
      makeValidConfig({ isLocal: true, apiKeyRef: "" }),
    );
    expect(hasErrorOn(result, "apiKeyRef")).toBe(false);
    expect(result.valid).toBe(true);
  });

  it("modelListing.auth.in=none 时允许空 apiKeyRef（放宽）", () => {
    const result = validate(
      makeValidConfig({
        apiKeyRef: "",
        modelListing: {
          path: "/v1/models",
          auth: { in: "none" },
          responseMapping: { arrayPointer: "/data", idField: "id" },
        },
      }),
    );
    expect(hasErrorOn(result, "apiKeyRef")).toBe(false);
    expect(result.valid).toBe(true);
  });

  it("modelListing.auth.kind=none 时允许空 apiKeyRef（放宽）", () => {
    const result = validate(
      makeValidConfig({
        apiKeyRef: "",
        modelListing: {
          path: "/v1/models",
          // in 非 none，但 kind 显式声明无鉴权，也应放宽
          auth: { in: "header", kind: "none" },
          responseMapping: { arrayPointer: "/data", idField: "id" },
        },
      }),
    );
    expect(hasErrorOn(result, "apiKeyRef")).toBe(false);
    expect(result.valid).toBe(true);
  });

  it("有鉴权声明（auth.in=header）时，空 apiKeyRef 仍应报错（不放宽）", () => {
    const result = validate(
      makeValidConfig({
        apiKeyRef: "",
        modelListing: {
          path: "/v1/models",
          auth: { in: "header", kind: "bearer", name: "Authorization", valueTemplate: "Bearer {key}" },
          responseMapping: { arrayPointer: "/data", idField: "id" },
        },
      }),
    );
    expect(result.valid).toBe(false);
    expect(hasErrorOn(result, "apiKeyRef")).toBe(true);
  });

  // -------------------------------------------------------------------------
  // candidateModels id 唯一性（需求 1.7）
  // -------------------------------------------------------------------------
  it("candidateModels id 重复应报错", () => {
    const result = validate(
      makeValidConfig({
        candidateModels: [
          { id: "gpt-4o", source: "fetched", availability: "unknown" },
          { id: "gpt-4o", source: "fetched", availability: "unknown" },
        ],
      }),
    );
    expect(result.valid).toBe(false);
    expect(hasErrorOn(result, "candidateModels")).toBe(true);
  });

  it("candidateModels id 全部唯一应通过", () => {
    const result = validate(
      makeValidConfig({
        candidateModels: [
          { id: "gpt-4o", source: "fetched", availability: "unknown" },
          { id: "gpt-4o-mini", source: "fetched", availability: "available" },
        ],
      }),
    );
    expect(hasErrorOn(result, "candidateModels")).toBe(false);
  });

  it("空 candidateModels 不触发唯一性校验", () => {
    const result = validate(makeValidConfig({ candidateModels: [] }));
    expect(hasErrorOn(result, "candidateModels")).toBe(false);
  });

  // -------------------------------------------------------------------------
  // 多项错误聚合：一次返回全部未通过项（需求 1.6）
  // -------------------------------------------------------------------------
  it("多个字段同时非法时应聚合返回全部错误", () => {
    const result = validate(
      makeValidConfig({
        name: "",
        baseUrl: "bad-url",
        models: [],
        timeoutMs: -5,
      }),
    );
    expect(result.valid).toBe(false);
    expect(hasErrorOn(result, "name")).toBe(true);
    expect(hasErrorOn(result, "baseUrl")).toBe(true);
    expect(hasErrorOn(result, "models")).toBe(true);
    expect(hasErrorOn(result, "timeoutMs")).toBe(true);
  });
});
