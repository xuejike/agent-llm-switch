// render 字段级合并引擎的单元测试与属性测试
//
// 覆盖任务 3.10，验证 design.md 的两条核心属性与需求 10.1 / 2.8：
// - 单元测试：给定含非 API 字段（主题、快捷键、MCP）的既有 json 配置，
//   断言 render 合并后这些非受管字段被完整保留（Requirements 10.1）。
// - Property 2（字段级合并保真）：对随机既有配置树 + 随机 ProviderConfig，
//   断言 render 后不属于 managedPaths 的字段值保持不变（Requirements 10.1 / Property 2）。
// - Property 1（密钥不泄露）：对随机 apiKey，断言 maskedDiff 不含明文密钥
//   （Requirements 2.8 / Property 1），覆盖 inline 与 env 两种凭据形态。
//
// 所有属性测试统一经共享约定 fcAssert 运行（numRuns >= 100）。
// 本任务聚焦 json 格式（render 的受管合并与掩码 diff 逻辑与格式无关，json 足以验证属性）。

import { describe, it, expect } from "vitest";
import fc from "fast-check";
import { fcAssert } from "@shared/testing/fcConfig";
import { render } from "./render";
import { getByPointer } from "./pointer";
import {
  createInMemoryWriteEnv,
  createInMemoryWriteSecretsFile,
} from "./injectCredential";
import type { FormatMapping, ProviderConfig } from "@shared/types";

/** 文档树通用类型别名，便于测试内读写 */
type Tree = Record<string, unknown>;

/**
 * 构造一个最小合法的 ProviderConfig。
 * 测试只关心被 render 写入的中立字段（baseUrl / models / timeoutMs / name 等），
 * 其余字段取合理缺省值。
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
// 单元测试：非受管字段（主题 / 快捷键 / MCP）完整保留
// ===========================================================================

describe("render 单元测试 - 非受管字段保留", () => {
  it("合并受管字段时完整保留主题、快捷键、MCP 等非 API 字段", () => {
    // 既有 json 配置：含受管字段（provider 块内的 baseURL / models / timeout）
    // 以及大量非受管字段（theme / keybindings / mcp / editor 等用户个性化设置）。
    const existing: Tree = {
      theme: "dark", // 非受管：主题
      keybindings: {
        // 非受管：快捷键
        save: "Ctrl+S",
        quit: "Ctrl+Q",
      },
      mcp: {
        // 非受管：MCP 服务器声明
        servers: {
          fs: { command: "mcp-fs", args: ["--root", "/data"] },
        },
      },
      editor: { fontSize: 14, wordWrap: true }, // 非受管：编辑器设置
      provider: {
        // 受管块：baseURL / models / timeout 将被 render 覆盖
        options: {
          baseURL: "https://old.example.com",
          timeout: 5000,
          models: ["old-model"],
        },
        // provider 块内的其它字段（非受管）也应保留
        label: "我的供应商",
      },
    };

    // 格式映射：仅把 baseUrl / models / timeout 声明为受管字段
    const mapping: FormatMapping = {
      format: "json",
      fieldPaths: {
        baseUrl: "/provider/options/baseURL",
        models: "/provider/options/models",
        timeout: "/provider/options/timeout",
      },
      managedPaths: ["baseUrl", "models", "timeout"],
    };

    const config = makeProviderConfig({
      baseUrl: "https://api.new.com",
      models: ["gpt-4o"],
      timeoutMs: 60000,
    });

    const result = render(config, "sk-plaintext-1234", JSON.stringify(existing), mapping);
    const merged = JSON.parse(result.mergedContent) as Tree;

    // 受管字段被更新为新配置值
    expect(getByPointer(merged, "/provider/options/baseURL")).toBe("https://api.new.com");
    expect(getByPointer(merged, "/provider/options/models")).toStrictEqual(["gpt-4o"]);
    expect(getByPointer(merged, "/provider/options/timeout")).toBe(60000);

    // 非受管字段完整保留（逐一核对，含嵌套结构）
    expect(getByPointer(merged, "/theme")).toBe("dark");
    expect(getByPointer(merged, "/keybindings/save")).toBe("Ctrl+S");
    expect(getByPointer(merged, "/keybindings/quit")).toBe("Ctrl+Q");
    expect(getByPointer(merged, "/mcp/servers/fs/command")).toBe("mcp-fs");
    expect(getByPointer(merged, "/mcp/servers/fs/args")).toStrictEqual(["--root", "/data"]);
    expect(getByPointer(merged, "/editor/fontSize")).toBe(14);
    expect(getByPointer(merged, "/editor/wordWrap")).toBe(true);
    // provider 块内的非受管兄弟字段也保留
    expect(getByPointer(merged, "/provider/label")).toBe("我的供应商");
  });

  it("既有文件不存在（existingContent 为 null）时也只写入受管字段，产出合法内容", () => {
    const mapping: FormatMapping = {
      format: "json",
      fieldPaths: { baseUrl: "/options/baseURL", models: "/options/models" },
      managedPaths: ["baseUrl", "models"],
    };
    const config = makeProviderConfig({ baseUrl: "https://a.com", models: ["m1"] });

    const result = render(config, "", null, mapping);
    const merged = JSON.parse(result.mergedContent) as Tree;

    expect(getByPointer(merged, "/options/baseURL")).toBe("https://a.com");
    expect(getByPointer(merged, "/options/models")).toStrictEqual(["m1"]);
  });
});

// ===========================================================================
// 属性测试辅助：随机既有树、随机 Provider、随机受管路径的生成器
// ===========================================================================

/** 可安全比较的标量值生成器（排除会与容器混淆的 object/array） */
const scalarArb: fc.Arbitrary<unknown> = fc.oneof(fc.string(), fc.integer(), fc.boolean());

/** 合法对象属性名：非空、不含 "/" 与 "~"、且不是纯数字（避免被当作数组下标） */
const objectKeyArb: fc.Arbitrary<string> = fc
  .string({ minLength: 1, maxLength: 6 })
  .filter((s) => !s.includes("/") && !s.includes("~") && !/^[0-9]+$/.test(s));

/**
 * 随机生成一棵「非受管的既有配置树」（模拟用户已有的 theme/keybindings/mcp 等设置）。
 * 树的根为对象，其下为若干标量或一层嵌套对象字段。
 */
const existingTreeArb: fc.Arbitrary<Tree> = fc.dictionary(
  objectKeyArb,
  fc.oneof(scalarArb, fc.dictionary(objectKeyArb, scalarArb, { maxKeys: 4 })),
  { maxKeys: 6 },
);

/** 随机 ProviderConfig（只随机化会被 render 写入的中立字段） */
const providerConfigArb: fc.Arbitrary<ProviderConfig> = fc.record({
  baseUrl: fc.webUrl(),
  models: fc.array(fc.string({ minLength: 1, maxLength: 10 }), { minLength: 1, maxLength: 5 }),
  timeoutMs: fc.integer({ min: 1, max: 600000 }),
  name: objectKeyArb,
}).map((r) =>
  makeProviderConfig({
    baseUrl: r.baseUrl,
    models: r.models,
    timeoutMs: r.timeoutMs,
    name: r.name,
  }),
);

/**
 * 收集一棵树中所有「叶子」的绝对指针与值快照（用于写入后比对非受管字段不变）。
 * 仅递归对象；数组与标量视为叶子整体快照。
 */
function snapshotLeaves(tree: unknown, prefix: string, out: Array<{ pointer: string; value: unknown }>): void {
  if (tree !== null && typeof tree === "object" && !Array.isArray(tree)) {
    for (const [key, value] of Object.entries(tree as Tree)) {
      const pointer = `${prefix}/${key.replace(/~/g, "~0").replace(/\//g, "~1")}`;
      snapshotLeaves(value, pointer, out);
    }
  } else {
    // 标量或数组：作为整体叶子快照
    out.push({ pointer: prefix, value: tree });
  }
}

// ===========================================================================
// Property 2: 字段级合并保真
// 随机既有配置树 + 随机 ProviderConfig，断言 render 后非 managedPaths 字段值不变。
// Validates: Requirements 10.1 / Property 2
// ===========================================================================

describe("render 属性测试 - Property 2: 字段级合并保真", () => {
  it("Property 2：render 后不属于 managedPaths 的既有字段值保持不变", () => {
    fcAssert(
      fc.property(existingTreeArb, providerConfigArb, (existing, config) => {
        // 受管字段统一写入一个与既有树不冲突的独立命名空间 "__managed__" 下，
        // 这样「受管路径」与「既有的非受管字段」互不重叠，可严格断言后者不变。
        const mapping: FormatMapping = {
          format: "json",
          fieldPaths: {
            baseUrl: "/__managed__/baseURL",
            models: "/__managed__/models",
            timeout: "/__managed__/timeout",
          },
          managedPaths: ["baseUrl", "models", "timeout"],
        };

        // 先对既有树的全部叶子做快照（排除受管命名空间；此处既有树随机生成，
        // 几乎不会含 "__managed__" 键，若恰好含则其属于受管区域，不纳入断言）。
        const snapshots: Array<{ pointer: string; value: unknown }> = [];
        snapshotLeaves(existing, "", snapshots);
        const nonManaged = snapshots.filter((s) => !s.pointer.startsWith("/__managed__"));

        const result = render(config, "sk-abcdefghijklmnop", JSON.stringify(existing), mapping);
        const merged = JSON.parse(result.mergedContent) as Tree;

        // 断言 1：所有非受管字段值在合并后保持不变
        for (const { pointer, value } of nonManaged) {
          expect(getByPointer(merged, pointer)).toStrictEqual(value);
        }

        // 断言 2：受管字段确被写入为新配置值（合并确实生效）
        expect(getByPointer(merged, "/__managed__/baseURL")).toBe(config.baseUrl);
        expect(getByPointer(merged, "/__managed__/models")).toStrictEqual(config.models);
        expect(getByPointer(merged, "/__managed__/timeout")).toBe(config.timeoutMs);

        return true;
      }),
    );
  });
});

// ===========================================================================
// Property 1: 密钥不泄露
// 随机 apiKey，断言 render 产出的 maskedDiff 不含明文（覆盖 inline 与 env 凭据形态）。
// Validates: Requirements 2.8 / Property 1
// ===========================================================================

/**
 * 随机 apiKey 生成器：模拟真实 API Key 的语义——带固定可识别前缀 "sk-" 的、
 * 长度足够（>= 20）的随机串，字符集为字母数字加少量符号。
 *
 * 为何不用任意短串（如单字符 "a"）：真实密钥是长且独特的随机串；而极短子串
 * 几乎必然偶然出现在 baseUrl、字段名等无关文本中，会让「maskedDiff 是否含明文」
 * 这一判定产生假阳性（子串恰好重合而非真正泄露）。使用带独特前缀的长串可让
 * 「明文是否出现在 diff」成为可严格判定的属性——它只会在真正写入明文时出现。
 */
const apiKeyArb: fc.Arbitrary<string> = fc
  .array(
    fc.constantFrom(...'abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789_-'.split('')),
    { minLength: 20, maxLength: 60 },
  )
  .map((chars) => `sk-${chars.join('')}`);

describe("render 属性测试 - Property 1: 密钥不泄露", () => {
  it("Property 1：inline 凭据形态下 maskedDiff 不含明文密钥", () => {
    fcAssert(
      fc.property(apiKeyArb, (apiKey) => {
        // inline 形态：key 直接以明文写入配置文件（mergedContent），
        // 但 maskedDiff 必须对其掩码，绝不出现明文。
        const mapping: FormatMapping = {
          format: "json",
          fieldPaths: { baseUrl: "/options/baseURL" },
          managedPaths: ["baseUrl"],
          credential: {
            targetPointer: "/options/apiKey",
            form: "inline",
            valueTemplate: "{key}",
          },
        };

        const config = makeProviderConfig();
        const result = render(config, apiKey, JSON.stringify({ theme: "dark" }), mapping);

        // 核心断言：maskedDiff 不含明文
        expect(result.maskedDiff.includes(apiKey)).toBe(false);
        return true;
      }),
    );
  });

  it("Property 1：env 凭据形态下 maskedDiff 与 mergedContent 均不含明文（仅引用占位）", () => {
    fcAssert(
      fc.property(apiKeyArb, (apiKey) => {
        // env 形态：配置文件只写环境变量引用占位，明文经 writeEnv 落到内存 store。
        const mapping: FormatMapping = {
          format: "json",
          fieldPaths: { baseUrl: "/options/baseURL" },
          managedPaths: ["baseUrl"],
          credential: {
            targetPointer: "/options/apiKey",
            form: "env",
            valueTemplate: "{env:MY_API_KEY}",
            envVarName: "MY_API_KEY",
          },
        };

        const { writeEnv, store } = createInMemoryWriteEnv();
        const config = makeProviderConfig();
        const result = render(config, apiKey, JSON.stringify({ theme: "dark" }), mapping, {
          writeEnv,
        });

        // maskedDiff 不含明文（env 占位不含明文）
        expect(result.maskedDiff.includes(apiKey)).toBe(false);
        // mergedContent（配置文件本身）也不含明文，只有引用占位
        expect(result.mergedContent.includes(apiKey)).toBe(false);
        // 明文确实经 writeEnv 落到了声明的环境变量目标（而非进配置文件）
        expect(store.get("MY_API_KEY")).toBe(apiKey);
        return true;
      }),
    );
  });

  it("Property 1：secrets-file 凭据形态下 maskedDiff 与 mergedContent 均不含明文", () => {
    fcAssert(
      fc.property(apiKeyArb, (apiKey) => {
        // secrets-file 形态：配置文件只写对独立 secrets 文件的引用占位，
        // 明文经 writeSecretsFile 落到内存 store。
        const mapping: FormatMapping = {
          format: "json",
          fieldPaths: { baseUrl: "/options/baseURL" },
          managedPaths: ["baseUrl"],
          credential: {
            targetPointer: "/options/apiKeyRef",
            form: "secrets-file",
            valueTemplate: "secrets://token",
            secretsFile: { path: "/tmp/secrets.json", entryKey: "token" },
          },
        };

        const { writeSecretsFile, store } = createInMemoryWriteSecretsFile();
        const config = makeProviderConfig();
        const result = render(config, apiKey, JSON.stringify({ theme: "dark" }), mapping, {
          writeSecretsFile,
        });

        expect(result.maskedDiff.includes(apiKey)).toBe(false);
        expect(result.mergedContent.includes(apiKey)).toBe(false);
        // 明文经 writeSecretsFile 落到声明的 secrets 文件条目
        expect(store.get("/tmp/secrets.json")?.get("token")).toBe(apiKey);
        return true;
      }),
    );
  });
});
