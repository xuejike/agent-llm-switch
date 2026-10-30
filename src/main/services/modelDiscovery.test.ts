// ModelDiscovery.fetchModels 的单元测试（任务 6.4）
//
// 本测试用「mock httpSend」注入 ModelDiscovery，覆盖 fetchModels 的全部关键分支，
// 全程不访问真实外网、不触达真实 OS 凭据库（密钥服务用内存实现 InMemorySecretStore）。
//
// 覆盖需求（对应 tasks.md 任务 6.4 / 需求 5.1、5.2、5.4、5.5）：
// - 5.1：provider 支持列表 API 时拉取并归一化为候选模型清单（source="fetched"）。
// - 5.2：数据驱动归一化——OpenAI 风格（/data[].id）与另一风格（/models[].name）均正确。
// - 5.4：端点返回非成功状态/格式非预期/不可达时，返回带 warning 的空清单且不抛异常。
// - 5.5：401/403 鉴权失败时，supportsListing:true + 空清单 + 鉴权失败 warning。
// 另：无 modelListing 的 provider 直接回退手动输入且「零调用」httpSend（场景 9）。

import { describe, it, expect, vi } from "vitest";
import type {
  ModelListingConfig,
  ModelProbeConfig,
  ProviderConfig,
} from "@shared/types";
import { createModelDiscovery } from "./modelDiscovery";
import type { HttpResponse, HttpSend } from "./http";
import type { HttpRequest } from "../core/injectAuth";
import { InMemorySecretStore } from "./secretStore";

// 测试用固定 keyRef 与明文密钥（长度 >= 8，便于与掩码/注入逻辑配合）
const KEY_REF = "provider-test-key";
const PLAINTEXT = "sk-test-1234567890";

/**
 * 构造一个成功响应（200 + JSON body）。
 * body 为「智能解析后」的对象，与 http.ts 的 HttpResponse 语义一致。
 */
function okResponse(body: unknown): HttpResponse {
  return {
    status: 200,
    headers: { "content-type": "application/json" },
    body,
    latencyMs: 5,
  };
}

/**
 * 构造一个指定状态码的响应（用于 401/403/500 等分支）。
 */
function statusResponse(status: number, body: unknown = ""): HttpResponse {
  return {
    status,
    headers: { "content-type": "application/json" },
    body,
    latencyMs: 5,
  };
}

/** OpenAI 风格的列表端点声明：模型数组在 /data，id 字段为 "id" */
const OPENAI_LISTING: ModelListingConfig = {
  path: "/v1/models",
  method: "GET",
  auth: { in: "header", kind: "bearer", name: "Authorization" },
  responseMapping: { arrayPointer: "/data", idField: "id" },
};

/** 另一风格的列表端点声明：模型数组在 /models，id 字段为 "name" */
const ALT_LISTING: ModelListingConfig = {
  path: "/api/models",
  method: "GET",
  auth: { in: "header", kind: "header", name: "x-api-key" },
  responseMapping: { arrayPointer: "/models", idField: "name" },
};

/**
 * 构造一个带可选 modelListing 的 ProviderConfig。
 * 其余字段取最小可用值；测试只关心拉取与归一化行为。
 */
function makeProvider(overrides: Partial<ProviderConfig> = {}): ProviderConfig {
  return {
    id: "p1",
    name: "test-provider",
    baseUrl: "https://api.example.com",
    apiKeyRef: KEY_REF,
    models: [],
    ...overrides,
  };
}

/**
 * 构造一个已写入测试密钥的内存 SecretStore。
 * 注意：无鉴权本地 provider 的分支不会调用它，但有鉴权分支需要能解析出明文。
 */
async function makeSecretStore(): Promise<InMemorySecretStore> {
  const store = new InMemorySecretStore();
  await store.saveSecret(KEY_REF, PLAINTEXT);
  return store;
}

describe("ModelDiscovery.fetchModels", () => {
  describe("无 modelListing：回退手动输入且零调用 httpSend（场景 9）", () => {
    it("provider 未声明 modelListing 时返回 supportsListing:false 且不发任何请求", async () => {
      // mock httpSend：一旦被调用即视为违约（无 modelListing 不应发请求）
      const httpSend = vi.fn<HttpSend>();
      const secretStore = await makeSecretStore();
      const discovery = createModelDiscovery({ secretStore, httpSend });

      const result = await discovery.fetchModels(makeProvider());

      expect(result).toEqual({ supportsListing: false, models: [] });
      // 关键：零调用——既不发请求，也不解析密钥
      expect(httpSend).not.toHaveBeenCalled();
    });
  });

  describe("OpenAI 风格（/data[].id）归一化与 id 去重（需求 5.1、5.2）", () => {
    it("应从 /data 定位数组、取 id 字段归一化，并对重复 id 去重（保留首次）", async () => {
      const httpSend = vi.fn<HttpSend>().mockResolvedValue(
        okResponse({
          object: "list",
          data: [
            { id: "gpt-4o" },
            { id: "gpt-4o-mini" },
            // 重复 id 应被去重
            { id: "gpt-4o" },
            // 非字符串 id 应被跳过
            { id: 123 },
            // 缺字段的元素应被跳过
            { foo: "bar" },
          ],
        }),
      );
      const secretStore = await makeSecretStore();
      const discovery = createModelDiscovery({ secretStore, httpSend });

      const result = await discovery.fetchModels(
        makeProvider({ modelListing: OPENAI_LISTING }),
      );

      expect(result.supportsListing).toBe(true);
      expect(result.warning).toBeUndefined();
      // 去重后保留首次出现顺序，非法元素被跳过
      expect(result.models).toEqual([
        { id: "gpt-4o", source: "fetched", availability: "unknown" },
        { id: "gpt-4o-mini", source: "fetched", availability: "unknown" },
      ]);
      // 只读 GET，且 URL 由 baseUrl + path 拼接
      expect(httpSend).toHaveBeenCalledTimes(1);
      const sentReq = httpSend.mock.calls[0][0] as HttpRequest;
      expect(sentReq.method).toBe("GET");
      expect(sentReq.url).toBe("https://api.example.com/v1/models");
    });
  });

  describe("另一风格（/models[].name）归一化（需求 5.2）", () => {
    it("应从 /models 定位数组、取 name 字段归一化为模型 id", async () => {
      const httpSend = vi.fn<HttpSend>().mockResolvedValue(
        okResponse({
          models: [{ name: "llama3.1" }, { name: "qwen2.5" }],
        }),
      );
      const secretStore = await makeSecretStore();
      const discovery = createModelDiscovery({ secretStore, httpSend });

      const result = await discovery.fetchModels(
        makeProvider({ modelListing: ALT_LISTING }),
      );

      expect(result.supportsListing).toBe(true);
      expect(result.models).toEqual([
        { id: "llama3.1", source: "fetched", availability: "unknown" },
        { id: "qwen2.5", source: "fetched", availability: "unknown" },
      ]);
    });
  });

  describe("非成功状态 / 非 JSON / 数组指针落空：带 warning 的空清单且不抛异常（需求 5.4）", () => {
    it("500 → supportsListing:true + 空清单 + 「端点返回 500」warning", async () => {
      const httpSend = vi.fn<HttpSend>().mockResolvedValue(statusResponse(500));
      const secretStore = await makeSecretStore();
      const discovery = createModelDiscovery({ secretStore, httpSend });

      const result = await discovery.fetchModels(
        makeProvider({ modelListing: OPENAI_LISTING }),
      );

      expect(result.supportsListing).toBe(true);
      expect(result.models).toEqual([]);
      expect(result.warning).toContain("500");
    });

    it("非 JSON（body 为纯文本/HTML 错误页）→ 格式非预期 warning，空清单不抛异常", async () => {
      // 2xx 但 body 不是可定位到数组的结构（如 HTML 错误页解析成的字符串）
      const httpSend = vi.fn<HttpSend>().mockResolvedValue(
        okResponse("<html><body>Not JSON</body></html>"),
      );
      const secretStore = await makeSecretStore();
      const discovery = createModelDiscovery({ secretStore, httpSend });

      const result = await discovery.fetchModels(
        makeProvider({ modelListing: OPENAI_LISTING }),
      );

      expect(result.supportsListing).toBe(true);
      expect(result.models).toEqual([]);
      expect(result.warning).toContain("格式");
    });

    it("数组指针落空（目标非数组）→ 格式非预期 warning，空清单不抛异常", async () => {
      // 2xx JSON，但 /data 处不是数组（指针落空）
      const httpSend = vi.fn<HttpSend>().mockResolvedValue(
        okResponse({ data: { not: "an-array" } }),
      );
      const secretStore = await makeSecretStore();
      const discovery = createModelDiscovery({ secretStore, httpSend });

      const result = await discovery.fetchModels(
        makeProvider({ modelListing: OPENAI_LISTING }),
      );

      expect(result.supportsListing).toBe(true);
      expect(result.models).toEqual([]);
      expect(result.warning).toContain("格式");
    });

    it("传输层异常（端点不可达）被捕获为 warning，而非向上抛出", async () => {
      const httpSend = vi
        .fn<HttpSend>()
        .mockRejectedValue(new Error("ECONNREFUSED"));
      const secretStore = await makeSecretStore();
      const discovery = createModelDiscovery({ secretStore, httpSend });

      // 不应抛异常
      const result = await discovery.fetchModels(
        makeProvider({ modelListing: OPENAI_LISTING }),
      );

      expect(result.supportsListing).toBe(true);
      expect(result.models).toEqual([]);
      expect(result.warning).toContain("不可达");
    });
  });

  describe("鉴权失败 401/403：supportsListing:true + 空清单 + 鉴权失败 warning（需求 5.5）", () => {
    it("401 → 空清单且 warning 标注鉴权失败", async () => {
      const httpSend = vi.fn<HttpSend>().mockResolvedValue(statusResponse(401));
      const secretStore = await makeSecretStore();
      const discovery = createModelDiscovery({ secretStore, httpSend });

      const result = await discovery.fetchModels(
        makeProvider({ modelListing: OPENAI_LISTING }),
      );

      expect(result.supportsListing).toBe(true);
      expect(result.models).toEqual([]);
      expect(result.warning).toContain("鉴权失败");
      expect(result.warning).toContain("401");
    });

    it("403 → 空清单且 warning 标注鉴权失败", async () => {
      const httpSend = vi.fn<HttpSend>().mockResolvedValue(statusResponse(403));
      const secretStore = await makeSecretStore();
      const discovery = createModelDiscovery({ secretStore, httpSend });

      const result = await discovery.fetchModels(
        makeProvider({ modelListing: OPENAI_LISTING }),
      );

      expect(result.supportsListing).toBe(true);
      expect(result.models).toEqual([]);
      expect(result.warning).toContain("鉴权失败");
      expect(result.warning).toContain("403");
    });
  });
});
// ===========================================================================
// ModelDiscovery.probeModel / probeModels 单元测试（任务 6.5）
//
// 用 mock httpSend 注入，覆盖探测的全部关键分支与并发约束，全程不访问真实外网、
// 不触达真实 OS 凭据库。对应需求 6.1/6.3/6.4/6.5/6.6/6.7/13.2 与 design.md 场景 8/10。
// ===========================================================================

/** OpenAI 风格探测端点声明：POST /v1/chat/completions，2xx 视为可用 */
const OPENAI_PROBE: ModelProbeConfig = {
  path: "/v1/chat/completions",
  method: "POST",
  auth: { in: "header", kind: "bearer", name: "Authorization", valueTemplate: "Bearer {key}" },
  bodyTemplate: {
    model: "{model}",
    messages: [{ role: "user", content: "ping" }],
    max_tokens: 1,
  },
  availableStatuses: [200],
};

/** 本地无鉴权探测端点声明：auth.in="none"，不注入也不要求密钥 */
const LOCAL_NONE_PROBE: ModelProbeConfig = {
  path: "/v1/chat/completions",
  method: "POST",
  auth: { in: "none", kind: "none" },
  bodyTemplate: {
    model: "{model}",
    messages: [{ role: "user", content: "ping" }],
    max_tokens: 1,
  },
  availableStatuses: [200],
};

/** 构造带延迟（latencyMs）的成功响应，便于断言 available 结果携带 latencyMs */
function okProbeResponse(latencyMs: number): HttpResponse {
  return {
    status: 200,
    headers: { "content-type": "application/json" },
    body: { ok: true },
    latencyMs,
  };
}

/**
 * 构造一个带 code 的错误（模拟 Node 传输层错误，如 ECONNREFUSED）。
 */
function errorWithCode(message: string, code: string): Error {
  const err = new Error(message);
  (err as Error & { code?: string }).code = code;
  return err;
}

describe("ModelDiscovery.probeModel（单模型探测）", () => {
  it("2xx 命中 availableStatuses → available 且含 latencyMs 与状态码（需求 6.3）", async () => {
    const httpSend = vi.fn<HttpSend>().mockResolvedValue(okProbeResponse(42));
    const secretStore = await makeSecretStore();
    const discovery = createModelDiscovery({ secretStore, httpSend });

    const result = await discovery.probeModel(
      makeProvider({ modelProbe: OPENAI_PROBE }),
      "gpt-4o",
    );

    expect(result.availability).toBe("available");
    expect(result.latencyMs).toBe(42);
    expect(result.statusCode).toBe(200);
    expect(result.error).toBeUndefined();
    expect(result.modelId).toBe("gpt-4o");
    // 探测为 POST，URL 由 baseUrl + path 拼接，body 的 {model} 已被替换
    const sentReq = httpSend.mock.calls[0][0] as HttpRequest;
    expect(sentReq.method).toBe("POST");
    expect(sentReq.url).toBe("https://api.example.com/v1/chat/completions");
    expect((sentReq.body as { model: string }).model).toBe("gpt-4o");
  });

  it("401 → unavailable 且 error 含状态码（需求 6.4 / 场景 8）", async () => {
    const httpSend = vi.fn<HttpSend>().mockResolvedValue(statusResponse(401));
    const secretStore = await makeSecretStore();
    const discovery = createModelDiscovery({ secretStore, httpSend });

    const result = await discovery.probeModel(
      makeProvider({ modelProbe: OPENAI_PROBE }),
      "gpt-4o",
    );

    expect(result.availability).toBe("unavailable");
    expect(result.statusCode).toBe(401);
    expect(result.error).toContain("401");
    expect(result.error).toContain("鉴权失败");
  });

  it("403 → unavailable 且 error 含状态码（需求 6.4 / 场景 8）", async () => {
    const httpSend = vi.fn<HttpSend>().mockResolvedValue(statusResponse(403));
    const secretStore = await makeSecretStore();
    const discovery = createModelDiscovery({ secretStore, httpSend });

    const result = await discovery.probeModel(
      makeProvider({ modelProbe: OPENAI_PROBE }),
      "gpt-4o",
    );

    expect(result.availability).toBe("unavailable");
    expect(result.statusCode).toBe(403);
    expect(result.error).toContain("403");
  });

  it("其它非可用状态（如 500）→ unavailable 且 error 含状态码", async () => {
    const httpSend = vi.fn<HttpSend>().mockResolvedValue(statusResponse(500));
    const secretStore = await makeSecretStore();
    const discovery = createModelDiscovery({ secretStore, httpSend });

    const result = await discovery.probeModel(
      makeProvider({ modelProbe: OPENAI_PROBE }),
      "gpt-4o",
    );

    expect(result.availability).toBe("unavailable");
    expect(result.statusCode).toBe(500);
    expect(result.error).toContain("500");
  });

  it("超时 → unavailable + \"超时\"（需求 6.5 / 场景：探测超时）", async () => {
    // 模拟 http.ts 默认实现的超时错误（消息含「超时」）
    const httpSend = vi
      .fn<HttpSend>()
      .mockRejectedValue(new Error("HTTP 请求超时（8000ms）：POST ..."));
    const secretStore = await makeSecretStore();
    const discovery = createModelDiscovery({ secretStore, httpSend });

    const result = await discovery.probeModel(
      makeProvider({ modelProbe: OPENAI_PROBE }),
      "gpt-4o",
    );

    expect(result.availability).toBe("unavailable");
    expect(result.error).toBe("超时");
    // 超时无状态码
    expect(result.statusCode).toBeUndefined();
  });

  it("超时（AbortError 形态）同样判定为 unavailable + \"超时\"", async () => {
    const abortErr = new Error("The operation was aborted");
    abortErr.name = "AbortError";
    const httpSend = vi.fn<HttpSend>().mockRejectedValue(abortErr);
    const secretStore = await makeSecretStore();
    const discovery = createModelDiscovery({ secretStore, httpSend });

    const result = await discovery.probeModel(
      makeProvider({ modelProbe: OPENAI_PROBE }),
      "gpt-4o",
    );

    expect(result.availability).toBe("unavailable");
    expect(result.error).toBe("超时");
  });

  it("网络异常（不可判定）→ unknown 且携带错误消息（需求 6.6）", async () => {
    // 非超时、非连接错误的通用网络/解析异常 → unknown
    const httpSend = vi
      .fn<HttpSend>()
      .mockRejectedValue(new Error("something unexpected"));
    const secretStore = await makeSecretStore();
    const discovery = createModelDiscovery({ secretStore, httpSend });

    const result = await discovery.probeModel(
      makeProvider({ modelProbe: OPENAI_PROBE }),
      "gpt-4o",
    );

    expect(result.availability).toBe("unknown");
    expect(result.error).toContain("something unexpected");
  });

  it("本地 ECONNREFUSED 识别为连接错误 → unavailable，且不提示鉴权失败（需求 6.6 / 场景 10）", async () => {
    const httpSend = vi
      .fn<HttpSend>()
      .mockRejectedValue(errorWithCode("connect ECONNREFUSED 127.0.0.1:11434", "ECONNREFUSED"));
    const secretStore = await makeSecretStore();
    const discovery = createModelDiscovery({ secretStore, httpSend });

    // 本地无鉴权 provider（isLocal + auth.in="none"）
    const localProvider = makeProvider({
      baseUrl: "http://127.0.0.1:11434",
      isLocal: true,
      apiKeyRef: "",
      modelProbe: LOCAL_NONE_PROBE,
    });

    const result = await discovery.probeModel(localProvider, "llama3.1");

    expect(result.availability).toBe("unavailable");
    // 连接错误而非鉴权失败：绝不出现「鉴权失败/密钥」字样
    expect(result.error).toContain("连接");
    expect(result.error).not.toContain("鉴权");
    expect(result.error).not.toContain("密钥");
    // 无鉴权本地 provider 不解析密钥：SecretStore 未被触达（apiKeyRef 为空也不失败）
  });

  it("无鉴权本地 provider 探测不解析密钥、请求不含鉴权头（需求 7.3 / Property 12）", async () => {
    const httpSend = vi.fn<HttpSend>().mockResolvedValue(okProbeResponse(10));
    // 用会抛错的 resolveSecret 断言「绝不被调用」——一旦调用即失败
    const secretStore = await makeSecretStore();
    const spy = vi.spyOn(secretStore, "resolveSecret");
    const discovery = createModelDiscovery({ secretStore, httpSend });

    const localProvider = makeProvider({
      baseUrl: "http://127.0.0.1:1234",
      isLocal: true,
      apiKeyRef: "",
      modelProbe: LOCAL_NONE_PROBE,
    });

    const result = await discovery.probeModel(localProvider, "local-model");

    expect(result.availability).toBe("available");
    // 关键：无鉴权不解析密钥
    expect(spy).not.toHaveBeenCalled();
    // 请求不含任何鉴权头/查询
    const sentReq = httpSend.mock.calls[0][0] as HttpRequest;
    expect(sentReq.headers["Authorization"]).toBeUndefined();
    expect(sentReq.query).toBeUndefined();
  });
});

describe("ModelDiscovery.probeModels（批量探测）", () => {
  it("结果与输入一一对应、长度相等、下标对齐（需求 6.7）", async () => {
    // 按 model 返回不同状态码：available / unavailable(401) / unknown(网络异常)
    const httpSend = vi.fn<HttpSend>().mockImplementation(async (req) => {
      const model = (req.body as { model: string }).model;
      if (model === "m-ok") {
        return okProbeResponse(5);
      }
      if (model === "m-401") {
        return statusResponse(401);
      }
      throw new Error("boom");
    });
    const secretStore = await makeSecretStore();
    const discovery = createModelDiscovery({ secretStore, httpSend });

    const modelIds = ["m-ok", "m-401", "m-net"];
    const results = await discovery.probeModels(
      makeProvider({ modelProbe: OPENAI_PROBE }),
      modelIds,
    );

    expect(results).toHaveLength(modelIds.length);
    // 下标对齐：每个 modelId 恰好一条结果，且顺序与输入一致
    expect(results.map((r) => r.modelId)).toEqual(modelIds);
    expect(results[0].availability).toBe("available");
    expect(results[1].availability).toBe("unavailable");
    expect(results[2].availability).toBe("unknown");
  });

  it("并发受限：任一时刻进行中的探测数不超过 concurrency（需求 6.2 / 13.2）", async () => {
    const concurrency = 2;
    let inFlight = 0;
    let maxInFlight = 0;
    // 可计数 mock：进入时自增、结束前自减，记录峰值；用微任务延迟制造重叠
    const httpSend = vi.fn<HttpSend>().mockImplementation(async () => {
      inFlight += 1;
      maxInFlight = Math.max(maxInFlight, inFlight);
      // 让出事件循环，使多个探测有机会重叠（从而放大并发峰值）
      await new Promise((resolve) => setTimeout(resolve, 5));
      inFlight -= 1;
      return okProbeResponse(5);
    });
    const secretStore = await makeSecretStore();
    const discovery = createModelDiscovery({ secretStore, httpSend });

    // 10 个模型、并发上限 2
    const modelIds = Array.from({ length: 10 }, (_, i) => `m-${i}`);
    const results = await discovery.probeModels(
      makeProvider({ modelProbe: OPENAI_PROBE }),
      modelIds,
      { concurrency, timeoutMs: 1000 },
    );

    expect(results).toHaveLength(10);
    expect(results.every((r) => r.availability === "available")).toBe(true);
    // 关键断言：进行中的探测数峰值不超过 concurrency
    expect(maxInFlight).toBeLessThanOrEqual(concurrency);
    // 全部被探测（共 10 次调用）
    expect(httpSend).toHaveBeenCalledTimes(10);
  });

  it("空 modelIds → 空结果且零调用 httpSend", async () => {
    const httpSend = vi.fn<HttpSend>();
    const secretStore = await makeSecretStore();
    const discovery = createModelDiscovery({ secretStore, httpSend });

    const results = await discovery.probeModels(
      makeProvider({ modelProbe: OPENAI_PROBE }),
      [],
    );

    expect(results).toEqual([]);
    expect(httpSend).not.toHaveBeenCalled();
  });
});
