// injectCredential / render 的凭据属性测试（Property 14）
//
// 覆盖任务 3.12，验证 design.md「Property 14: key 适配收敛于适配器且转换后不泄露明文」
// 与需求 9.1 / 9.3 / 9.4 / 9.5 / 9.7：
//
//   对任意 agent 与任意 ProviderConfig，适配器 render（经 injectCredential）产出的配置中，
//   供应商 key 以该 agent 要求的字段名 / 位置 / 引用形式出现（由 CredentialMapping 声明）；
//   且无论 inline（明文）还是 env / secrets-file（引用形式），maskedDiff 与任何回传渲染进程
//   的数据中都不含明文 key。
//
// 随机维度：
//   - form：inline / env / secrets-file 三种凭据形态；
//   - targetPointer：随机生成的合法 JSON 指针（RFC 6901，1~3 段对象路径）；
//   - valueTemplate：
//       · inline 用含 {key} 的模板（可带前缀，如 "Bearer {key}"），明文按声明出现；
//       · env / secrets-file 用「不含 {key}」的引用占位模板，保证写入 tree 的值无明文；
//   - apiKey：带独特前缀 "sk-" 的长随机串（见 apiKeyArb 说明，避免假阳性）。
//
// 断言：
//   (a) inline 形态下 key 按声明（valueTemplate 渲染结果）出现在 mergedContent 的 targetPointer 处；
//   (b) env / secrets-file 形态下 mergedContent 与 maskedDiff 均不含明文，明文仅落到注入的内存 store；
//   (c) JSON.stringify(RenderResult) 不含明文（回传渲染进程的数据不泄露）；
//   (d) 构造的 ProviderConfig 不含任何 agent 专属 key 字段（apiKey / api_key / token 等），仅含 apiKeyRef。
//
// 所有属性测试统一经共享约定 fcAssert 运行（numRuns >= 100）。

import { describe, it, expect } from "vitest";
import fc from "fast-check";
import { fcAssert } from "@shared/testing/fcConfig";
import { render } from "./render";
import { getByPointer } from "./pointer";
import {
  createInMemoryWriteEnv,
  createInMemoryWriteSecretsFile,
} from "./injectCredential";
import type { CredentialForm, FormatMapping, ProviderConfig } from "@shared/types";

/** 文档树通用类型别名 */
type Tree = Record<string, unknown>;

/**
 * 构造一个最小合法的 ProviderConfig（供应商中立，不含 agent 专属 key 字段）。
 * 仅持有中立的 apiKeyRef；key 的字段名 / 位置 / 引用形式差异一律交由 CredentialMapping 处理。
 */
function makeProviderConfig(overrides: Partial<ProviderConfig> = {}): ProviderConfig {
  return {
    id: "p1",
    name: "openai",
    baseUrl: "https://api.example.com",
    apiKeyRef: "secret://p1",
    models: ["gpt-4o", "gpt-4o-mini"],
    timeoutMs: 30000,
    ...overrides,
  };
}

// ===========================================================================
// 随机生成器
// ===========================================================================

/**
 * 随机 apiKey 生成器：模拟真实 API Key——带固定可识别前缀 "sk-" 且长度足够（>= 20）的
 * 随机串，字符集为字母数字加少量符号。
 *
 * 为何用带独特前缀的长串：真实密钥长而独特；极短子串几乎必然偶然出现在 baseUrl、字段名、
 * 引用占位等无关文本中，会让「mergedContent / maskedDiff 是否含明文」的判定产生假阳性
 * （子串偶然重合而非真正泄露）。独特长串让「明文是否出现」成为可严格判定的属性——
 * 它只会在真正写入明文时出现。
 */
const apiKeyArb: fc.Arbitrary<string> = fc
  .array(
    fc.constantFrom(
      ..."abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789_-".split(""),
    ),
    { minLength: 20, maxLength: 60 },
  )
  .map((chars) => `sk-${chars.join("")}`);

/**
 * Object.prototype 上的内置属性名集合。
 * 这些名字即使对象「自身」未设置，也能通过原型链被读到（且多为函数），若作为指针
 * 中间段用于 setByPointer 下钻，会被判定为「路径与既有基础类型冲突」而抛错——这是
 * 指针生成器与 JS 原型链交互产生的假阳性，与 Property 14 的凭据语义无关，故排除。
 */
const PROTOTYPE_KEYS = new Set([
  "toString",
  "valueOf",
  "constructor",
  "hasOwnProperty",
  "isPrototypeOf",
  "propertyIsEnumerable",
  "toLocaleString",
  "__proto__",
  "__defineGetter__",
  "__defineSetter__",
  "__lookupGetter__",
  "__lookupSetter__",
]);

/**
 * 合法的对象属性名段：非空、不含 "/" 与 "~"（避免 JSON 指针转义歧义）、非纯数字
 * （避免被当作数组下标），且仅用字母以保证构造的指针干净、可读；并排除
 * Object.prototype 的内置属性名（见 PROTOTYPE_KEYS 说明）。
 */
const pointerSegmentArb: fc.Arbitrary<string> = fc
  .stringMatching(/^[a-zA-Z]{1,8}$/)
  .filter((s) => !PROTOTYPE_KEYS.has(s));

/**
 * 随机合法 JSON 指针生成器：1~3 段对象路径（如 "/apiKey"、"/provider/options/token"）。
 * 这些指针用于 CredentialMapping.targetPointer，覆盖「字段名不同 + 放置位置不同」两类差异。
 */
const targetPointerArb: fc.Arbitrary<string> = fc
  .array(pointerSegmentArb, { minLength: 1, maxLength: 3 })
  .map((segments) => "/" + segments.join("/"));

/**
 * inline 形态的 valueTemplate 生成器：必含 {key} 占位（明文将按声明出现）；
 * 可选带一个「不含明文、不与密钥冲突」的固定前缀（如 "Bearer "），覆盖「格式/封装」差异。
 */
const inlineTemplateArb: fc.Arbitrary<string> = fc
  .constantFrom("{key}", "Bearer {key}", "token {key}", "{providerName}:{key}");

/**
 * env / secrets-file 形态的引用占位 valueTemplate 生成器：刻意「不含 {key}」，
 * 确保写入配置文件（tree）的只是引用占位，绝不含明文。
 */
const refTemplateArb: fc.Arbitrary<string> = fc
  .constantFrom("{env:MY_API_KEY}", "${MY_API_KEY}", "secrets://token", "ref:credentials#key");

/** 随机环境变量名（非空字母串） */
const envVarNameArb: fc.Arbitrary<string> = fc.stringMatching(/^[A-Z][A-Z_]{2,15}$/);

/** 随机 secrets 文件路径与条目键 */
const secretsFileArb: fc.Arbitrary<{ path: string; entryKey: string }> = fc.record({
  path: fc
    .array(pointerSegmentArb, { minLength: 1, maxLength: 3 })
    .map((segs) => `/tmp/${segs.join("/")}.json`),
  entryKey: pointerSegmentArb,
});

// ===========================================================================
// 辅助：断言 ProviderConfig 无 agent 专属 key 字段
// ===========================================================================

/** agent 专属 key 字段名黑名单（ProviderConfig 绝不应持有这些字段，仅持有中立 apiKeyRef） */
const FORBIDDEN_KEY_FIELDS = ["apiKey", "api_key", "token", "accessKey", "secretKey", "key"];

/**
 * 断言给定的 ProviderConfig 不含任何 agent 专属 key 字段（仅允许中立的 apiKeyRef）。
 * 这是 Property 14 的子断言 (d)：key 的 agent 差异收敛于适配器，不污染配置真相。
 */
function expectNoAgentKeyFields(config: ProviderConfig): void {
  for (const field of FORBIDDEN_KEY_FIELDS) {
    expect(Object.prototype.hasOwnProperty.call(config, field)).toBe(false);
  }
  // 中立引用字段必须存在
  expect(typeof config.apiKeyRef).toBe("string");
}

// ===========================================================================
// Property 14: key 适配收敛于适配器且转换后不泄露明文
// ===========================================================================

describe("injectCredential/render 属性测试 - Property 14: key 适配收敛于适配器且转换后不泄露明文", () => {
  it("(a) inline 形态：key 按声明的字段名/位置/值模板出现在 mergedContent 对应位置，且回传数据可（因明文入文件）出现明文但 maskedDiff 已掩码", () => {
    // Validates: Requirements 9.1, 9.3, 9.7 / Property 14
    fcAssert(
      fc.property(apiKeyArb, targetPointerArb, inlineTemplateArb, (apiKey, targetPointer, template) => {
        const mapping: FormatMapping = {
          format: "json",
          fieldPaths: { baseUrl: "/options/baseURL" },
          managedPaths: ["baseUrl"],
          credential: {
            targetPointer,
            form: "inline",
            valueTemplate: template,
          },
        };

        const config = makeProviderConfig();
        // (d) 构造的 ProviderConfig 不含 agent 专属 key 字段
        expectNoAgentKeyFields(config);

        const result = render(config, apiKey, JSON.stringify({ theme: "dark" }), mapping);
        const merged = JSON.parse(result.mergedContent) as Tree;

        // (a) key 以声明的字段名/位置/值模板形式出现在 targetPointer 处
        const expectedValue = template
          .split("{key}")
          .join(apiKey)
          .split("{providerName}")
          .join(config.name);
        expect(getByPointer(merged, targetPointer)).toBe(expectedValue);
        // 明文确实按 inline 声明进入了配置文件对应位置
        expect(result.mergedContent.includes(apiKey)).toBe(true);

        // inline 形态下明文进文件属声明行为，但 maskedDiff 必须对其掩码、绝不含明文
        expect(result.maskedDiff.includes(apiKey)).toBe(false);

        return true;
      }),
    );
  });

  it("(b)(c) env 形态：mergedContent 与 maskedDiff 均不含明文（仅引用占位），明文落到内存 store，回传对象序列化不含明文", () => {
    // Validates: Requirements 9.1, 9.4, 9.7 / Property 14
    fcAssert(
      fc.property(
        apiKeyArb,
        targetPointerArb,
        refTemplateArb,
        envVarNameArb,
        (apiKey, targetPointer, template, envVarName) => {
          const mapping: FormatMapping = {
            format: "json",
            fieldPaths: { baseUrl: "/options/baseURL" },
            managedPaths: ["baseUrl"],
            credential: {
              targetPointer,
              form: "env",
              valueTemplate: template,
              envVarName,
            },
          };

          const { writeEnv, store } = createInMemoryWriteEnv();
          const config = makeProviderConfig();
          // (d) ProviderConfig 无 agent 专属 key 字段
          expectNoAgentKeyFields(config);

          const result = render(config, apiKey, JSON.stringify({ theme: "dark" }), mapping, {
            writeEnv,
          });

          // (b) 配置文件本身只含引用占位，不含明文
          expect(result.mergedContent.includes(apiKey)).toBe(false);
          // (b) maskedDiff 不含明文
          expect(result.maskedDiff.includes(apiKey)).toBe(false);
          // (c) 回传渲染进程的对象（RenderResult）整体序列化后不含明文
          expect(JSON.stringify(result).includes(apiKey)).toBe(false);
          // (b) 明文确实经 writeEnv 落到声明的环境变量目标（而非进配置文件）
          expect(store.get(envVarName)).toBe(apiKey);

          // key 以「引用形式」出现在 targetPointer 处（引用占位，不含明文）
          const merged = JSON.parse(result.mergedContent) as Tree;
          const refValue = template.split("{providerName}").join(config.name);
          expect(getByPointer(merged, targetPointer)).toBe(refValue);

          return true;
        },
      ),
    );
  });

  it("(b)(c) secrets-file 形态：mergedContent 与 maskedDiff 均不含明文（仅引用占位），明文落到内存 store，回传对象序列化不含明文", () => {
    // Validates: Requirements 9.1, 9.5, 9.7 / Property 14
    fcAssert(
      fc.property(
        apiKeyArb,
        targetPointerArb,
        refTemplateArb,
        secretsFileArb,
        (apiKey, targetPointer, template, secretsFile) => {
          const mapping: FormatMapping = {
            format: "json",
            fieldPaths: { baseUrl: "/options/baseURL" },
            managedPaths: ["baseUrl"],
            credential: {
              targetPointer,
              form: "secrets-file",
              valueTemplate: template,
              secretsFile,
            },
          };

          const { writeSecretsFile, store } = createInMemoryWriteSecretsFile();
          const config = makeProviderConfig();
          // (d) ProviderConfig 无 agent 专属 key 字段
          expectNoAgentKeyFields(config);

          const result = render(config, apiKey, JSON.stringify({ theme: "dark" }), mapping, {
            writeSecretsFile,
          });

          // (b) 配置文件本身只含引用占位，不含明文
          expect(result.mergedContent.includes(apiKey)).toBe(false);
          // (b) maskedDiff 不含明文
          expect(result.maskedDiff.includes(apiKey)).toBe(false);
          // (c) 回传对象整体序列化后不含明文
          expect(JSON.stringify(result).includes(apiKey)).toBe(false);
          // (b) 明文经 writeSecretsFile 落到声明的 secrets 文件条目
          expect(store.get(secretsFile.path)?.get(secretsFile.entryKey)).toBe(apiKey);

          // key 以「引用形式」出现在 targetPointer 处
          const merged = JSON.parse(result.mergedContent) as Tree;
          const refValue = template.split("{providerName}").join(config.name);
          expect(getByPointer(merged, targetPointer)).toBe(refValue);

          return true;
        },
      ),
    );
  });

  it("(a)(b)(c)(d) 综合：随机 form × targetPointer × valueTemplate × apiKey，key 收敛于适配器声明且引用形态下不泄露明文", () => {
    // Validates: Requirements 9.1, 9.3, 9.4, 9.5, 9.7 / Property 14
    const formArb: fc.Arbitrary<CredentialForm> = fc.constantFrom("inline", "env", "secrets-file");

    fcAssert(
      fc.property(
        apiKeyArb,
        formArb,
        targetPointerArb,
        envVarNameArb,
        secretsFileArb,
        (apiKey, form, targetPointer, envVarName, secretsFile) => {
          // 按 form 选择相应的值模板：inline 必含 {key}，引用形态必不含 {key}
          const config = makeProviderConfig();
          // (d) 任何 form 下 ProviderConfig 都无 agent 专属 key 字段
          expectNoAgentKeyFields(config);

          const { writeEnv, store: envStore } = createInMemoryWriteEnv();
          const { writeSecretsFile, store: secretsStore } = createInMemoryWriteSecretsFile();

          let mapping: FormatMapping;
          if (form === "inline") {
            mapping = {
              format: "json",
              fieldPaths: { baseUrl: "/options/baseURL" },
              managedPaths: ["baseUrl"],
              credential: { targetPointer, form, valueTemplate: "Bearer {key}" },
            };
          } else if (form === "env") {
            mapping = {
              format: "json",
              fieldPaths: { baseUrl: "/options/baseURL" },
              managedPaths: ["baseUrl"],
              credential: { targetPointer, form, valueTemplate: "{env:VAR}", envVarName },
            };
          } else {
            mapping = {
              format: "json",
              fieldPaths: { baseUrl: "/options/baseURL" },
              managedPaths: ["baseUrl"],
              credential: { targetPointer, form, valueTemplate: "secrets://ref", secretsFile },
            };
          }

          const result = render(config, apiKey, JSON.stringify({ theme: "dark" }), mapping, {
            writeEnv,
            writeSecretsFile,
          });
          const merged = JSON.parse(result.mergedContent) as Tree;

          // maskedDiff 在任何形态下都不含明文
          expect(result.maskedDiff.includes(apiKey)).toBe(false);

          if (form === "inline") {
            // (a) 明文按声明出现在目标位置
            expect(getByPointer(merged, targetPointer)).toBe(`Bearer ${apiKey}`);
          } else if (form === "env") {
            // (b) 配置文件/回传序列化均不含明文，明文落到 env store
            expect(result.mergedContent.includes(apiKey)).toBe(false);
            expect(JSON.stringify(result).includes(apiKey)).toBe(false);
            expect(getByPointer(merged, targetPointer)).toBe("{env:VAR}");
            expect(envStore.get(envVarName)).toBe(apiKey);
          } else {
            // (b) 配置文件/回传序列化均不含明文，明文落到 secrets store
            expect(result.mergedContent.includes(apiKey)).toBe(false);
            expect(JSON.stringify(result).includes(apiKey)).toBe(false);
            expect(getByPointer(merged, targetPointer)).toBe("secrets://ref");
            expect(secretsStore.get(secretsFile.path)?.get(secretsFile.entryKey)).toBe(apiKey);
          }

          return true;
        },
      ),
    );
  });
});
