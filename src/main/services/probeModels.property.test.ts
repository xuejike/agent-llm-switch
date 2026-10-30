// ModelDiscovery.probeModels 的基于属性的测试（任务 6.5）
//
// 本文件验证设计文档中的：
//   **Property 10: 探测结果与输入一一对应**
//   ∀ modelIds：probeModels 返回的结果恰好覆盖 modelIds 中每个 id 一次，
//   长度相等，顺序可按原下标对齐。
//
// 说明：Property 8/9/12（发现与探测不泄露密钥 / 只读无副作用 / 无鉴权本地 provider 不读密钥）
// 由任务 6.6 的 modelDiscovery.property.test.ts 承载；本文件只聚焦任务 6.5 要求的 Property 10，
// 故单独成文，避免与 6.6 文件相互覆盖。
//
// 测试策略：
// - 随机生成 modelIds（允许重复 id、允许空列表）与「随机 mock 响应」——mock httpSend 对每次
//   调用从一组预置结果（2xx / 401 / 500 / 超时 / 网络异常 / 连接错误）中取用，覆盖
//   available / unavailable / unknown 全部判定路径。
// - 断言：结果长度 == 输入长度；结果按下标对齐（results[i].modelId === modelIds[i]）；
//   每个输入位置恰有一条结果（无缺失、无多余）。
// - 全程 mock httpSend，不访问真实外网；SecretStore 用内存实现，不触达真实凭据库。
// - 经共享 fcConfig 运行，numRuns >= 100 并显式引用 Property 10（满足需求 14.4）。
//
// **Validates: Requirements 6.7 / Property 10**

import { describe, it, expect } from "vitest";
import fc from "fast-check";
import { fcAssertAsync } from "@shared/testing/fcConfig";
import type { ModelProbeConfig, ProviderConfig } from "@shared/types";
import { createModelDiscovery } from "./modelDiscovery";
import type { HttpResponse, HttpSend } from "./http";
import { InMemorySecretStore } from "./secretStore";

// 固定的测试 keyRef 与明文（长度 >= 8）
const KEY_REF = "prop-probe-key";
const PLAINTEXT = "sk-prop-1234567890";

/** 探测端点声明：POST /v1/chat/completions，2xx 视为可用 */
const PROBE_CONFIG: ModelProbeConfig = {
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

/** 构造带探测端点的 ProviderConfig（其余字段取最小可用值） */
function makeProvider(): ProviderConfig {
  return {
    id: "p-prop",
    name: "prop-provider",
    baseUrl: "https://api.example.com",
    apiKeyRef: KEY_REF,
    models: [],
    modelProbe: PROBE_CONFIG,
  };
}

/** 构造一个已写入测试密钥的内存 SecretStore */
async function makeSecretStore(): Promise<InMemorySecretStore> {
  const store = new InMemorySecretStore();
  await store.saveSecret(KEY_REF, PLAINTEXT);
  return store;
}

/**
 * 随机「mock 响应种类」：覆盖探测的全部判定路径。
 * 每种对应一个「如何让 mock httpSend 表现」的指令，由下方 mock 解释执行。
 */
type MockOutcome = "ok" | "unauthorized" | "server-error" | "timeout" | "network" | "refused";

const OUTCOME_ARB: fc.Arbitrary<MockOutcome> = fc.constantFrom(
  "ok",
  "unauthorized",
  "server-error",
  "timeout",
  "network",
  "refused",
);

/** 构造一个指定状态码的响应 */
function statusResponse(status: number): HttpResponse {
  return {
    status,
    headers: { "content-type": "application/json" },
    body: { ok: status === 200 },
    latencyMs: 7,
  };
}

describe("Property 10: 探测结果与输入一一对应", () => {
  it("随机 modelIds 与随机 mock 响应：结果与输入按下标一一对应、长度相等", async () => {
    await fcAssertAsync(
      fc.asyncProperty(
        // 随机 modelIds：允许空列表、允许重复 id（下标对齐仍须成立）
        fc.array(fc.string({ minLength: 1, maxLength: 12 }), { minLength: 0, maxLength: 20 }),
        // 为每次探测预置一串随机「响应种类」（mock 按调用次序循环取用，保证每次都有确定行为）
        fc.array(OUTCOME_ARB, { minLength: 0, maxLength: 20 }),
        // 随机并发上限（含 1 与较大值，验证不同并发下仍一一对应）
        fc.integer({ min: 1, max: 8 }),
        async (modelIds, outcomes, concurrency) => {
          // 按调用序号取响应种类（种类数组不足时循环取用）
          let callIndex = 0;
          const httpSend: HttpSend = async () => {
            const outcome: MockOutcome =
              outcomes.length > 0 ? outcomes[callIndex % outcomes.length] : "ok";
            callIndex += 1;
            switch (outcome) {
              case "ok":
                return statusResponse(200);
              case "unauthorized":
                return statusResponse(401);
              case "server-error":
                return statusResponse(500);
              case "timeout":
                // 超时错误（消息含「超时」，被识别为 unavailable + "超时"）
                throw new Error("HTTP 请求超时（8000ms）");
              case "network":
                // 不可判定的网络/解析异常 → unknown
                throw new Error("unexpected network failure");
              case "refused": {
                // 连接错误（ECONNREFUSED）→ unavailable 连接错误
                const err = new Error("connect ECONNREFUSED") as Error & { code?: string };
                err.code = "ECONNREFUSED";
                throw err;
              }
            }
          };

          const secretStore = await makeSecretStore();
          const discovery = createModelDiscovery({ secretStore, httpSend });

          const results = await discovery.probeModels(makeProvider(), modelIds, {
            concurrency,
            timeoutMs: 1000,
          });

          // 1) 长度相等
          expect(results).toHaveLength(modelIds.length);

          // 2) 下标对齐：每个位置的结果 modelId 等于对应输入（即便 id 重复也须逐位对齐）
          for (let i = 0; i < modelIds.length; i++) {
            expect(results[i]).toBeDefined();
            expect(results[i].modelId).toBe(modelIds[i]);
            // 每条结果的 availability 必为三态之一
            expect(["available", "unavailable", "unknown"]).toContain(results[i].availability);
          }

          // 3) 无空槽位：预置槽位全部被填充（一一对应、无缺失）
          expect(results.every((r) => r !== undefined)).toBe(true);

          return true;
        },
      ),
    );
  });
});
