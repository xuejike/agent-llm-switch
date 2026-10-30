// 适配器与注册表属性测试（Property 2 / 5 / 14 —— 适配器维度）
//
// 覆盖任务 9.3，验证 design.md 的三条设计属性在「四个具体适配器 + 注册表」这一维度成立：
//
//   - Property 5（扩展不变 / 隔离性）：向注册表注册一个「新增适配器」后，断言其它已注册
//     agent 的分发行为（detect/configPath/render 的产出）与注册前完全一致——新增一个 agent
//     不改变其它 agent 的任何行为（对应需求 8.2）。
//   - Property 2（字段级合并保真 —— 适配器维度）：对每个适配器的 FormatMapping，用随机既有
//     配置运行其 render，断言既有文件中「非 managedPaths」的字段值在合并后原样保留
//     （对应需求 10.1）。
//   - Property 14（key 适配收敛于适配器 —— 适配器维度）：对每个适配器运行 render，断言 key
//     以该适配器 CredentialMapping 声明的字段名/位置/引用形式出现，且 env/secrets-file 形态下
//     mergedContent 与 maskedDiff 均不含明文（明文只落到注入的内存 store）（对应需求 9.7）。
//
// Validates: Requirements 8.2, 10.1, 9.7 / Property 2, 5, 14
//
// 测试约定：
//   - 统一经共享约定 fcAssert 运行，numRuns >= 100（需求 14.4）。
//   - 四个内置适配器均以「env 引用」或「secrets-file 引用」形态表达 key（安全优先）；为使测试
//     不触碰真实环境变量/文件系统，统一注入 injectCredential 的内存 store 实现（writeEnv /
//     writeSecretsFile），断言明文只落到内存 store。
//   - 不触碰真实外网与真实 OS 凭据库；render 为纯函数，仅在内存中运行。

import { describe, it, expect } from "vitest";
import fc from "fast-check";
import { fcAssert } from "@shared/testing/fcConfig";
import { getByPointer } from "../core/pointer";
import {
  createInMemoryWriteEnv,
  createInMemoryWriteSecretsFile,
} from "../core/injectCredential";
import type { RenderDeps } from "../core/render";
import type {
  FormatMapping,
  PlatformContext,
  ProviderConfig,
  RenderResult,
} from "@shared/types";
import { createAdapterRegistry } from "./registry";
import type { AgentAdapter } from "./base";
import { BaseAdapter } from "./base";
import { OpencodeAdapter, createOpencodeMapping } from "./opencodeAdapter";
import { PiAdapter, createPiMapping } from "./piAdapter";
import { WorkbuddyAdapter, createWorkbuddyMapping } from "./workbuddyAdapter";
import { CodebuddyAdapter, createCodebuddyMapping } from "./codebuddyAdapter";
import * as TOML from "@iarna/toml";

/** 文档树通用类型别名 */
type Tree = Record<string, unknown>;

// ===========================================================================
// 被测适配器清单与「随机既有配置 / 渲染依赖」的构造
// ===========================================================================

/**
 * 单个被测适配器的描述：适配器实例、其 FormatMapping、以及一个能解析该格式文本的解析器。
 *
 * Property 2 需要读取「合并后文本」里非受管字段是否保留，故需知道 format 对应的解析方式；
 * Property 14 需要知道 CredentialMapping 的目标指针/形态来断言 key 落位与不泄露明文。
 */
interface AdapterCase {
  /** 用例名（出现在测试输出里） */
  readonly name: string;
  /** 被测适配器实例 */
  readonly adapter: AgentAdapter;
  /** 该适配器声明的 FormatMapping（与适配器实例一致） */
  readonly mapping: FormatMapping;
  /** 把该 format 的文本解析为对象树，用于断言合并保真 */
  readonly parse: (text: string) => Tree;
}

/**
 * 构造「env 引用形态」适配器用例所需的渲染依赖（注入内存 writeEnv）。
 * 返回依赖与内存 store，便于断言明文只落到 store、未进配置文件。
 */
function makeEnvDeps(): { deps: RenderDeps; envStore: Map<string, string> } {
  const { writeEnv, store } = createInMemoryWriteEnv();
  return { deps: { writeEnv }, envStore: store };
}

/**
 * 构造「secrets-file 引用形态」适配器用例所需的渲染依赖（注入内存 writeSecretsFile）。
 * 返回依赖与内存 store，便于断言明文只落到 store、未进配置文件。
 */
function makeSecretsDeps(): {
  deps: RenderDeps;
  secretsStore: Map<string, Map<string, string>>;
} {
  const { writeSecretsFile, store } = createInMemoryWriteSecretsFile();
  return { deps: { writeSecretsFile }, secretsStore: store };
}

/** JSON 解析器：用于 opencode / workbuddy / codebuddy（format=json） */
const parseJson = (text: string): Tree => JSON.parse(text) as Tree;

/** TOML 解析器：用于 pi（format=toml） */
const parseToml = (text: string): Tree => TOML.parse(text) as unknown as Tree;

/**
 * 构造固定的四个内置适配器用例（供 Property 2 / 14 遍历）。
 *
 * 每次调用新建适配器实例与内存 store，保证各属性迭代相互独立、互不污染。
 * 对 env 形态注入 writeEnv，对 secrets-file 形态（pi）注入 writeSecretsFile。
 */
function buildAdapterCases(): Array<
  AdapterCase & {
    /** env store（env 形态适配器才有） */
    envStore?: Map<string, string>;
    /** secrets store（secrets-file 形态适配器才有） */
    secretsStore?: Map<string, Map<string, string>>;
    /** 该适配器 render 时应传入的依赖 */
    deps: RenderDeps;
  }
> {
  // opencode：env 引用形态
  const opencodeMapping = createOpencodeMapping();
  const opencodeEnv = makeEnvDeps();

  // workbuddy：env 引用形态
  const workbuddyMapping = createWorkbuddyMapping();
  const workbuddyEnv = makeEnvDeps();

  // codebuddy：env 引用形态
  const codebuddyMapping = createCodebuddyMapping();
  const codebuddyEnv = makeEnvDeps();

  // pi：secrets-file 引用形态（TOML 格式）
  const piMapping = createPiMapping();
  const piSecrets = makeSecretsDeps();

  return [
    {
      name: "opencode",
      adapter: new OpencodeAdapter(opencodeMapping, { renderDeps: opencodeEnv.deps }),
      mapping: opencodeMapping,
      parse: parseJson,
      deps: opencodeEnv.deps,
      envStore: opencodeEnv.envStore,
    },
    {
      name: "workbuddy",
      adapter: new WorkbuddyAdapter(workbuddyMapping, { renderDeps: workbuddyEnv.deps }),
      mapping: workbuddyMapping,
      parse: parseJson,
      deps: workbuddyEnv.deps,
      envStore: workbuddyEnv.envStore,
    },
    {
      name: "codebuddy",
      adapter: new CodebuddyAdapter(codebuddyMapping, { renderDeps: codebuddyEnv.deps }),
      mapping: codebuddyMapping,
      parse: parseJson,
      deps: codebuddyEnv.deps,
      envStore: codebuddyEnv.envStore,
    },
    {
      name: "pi",
      adapter: new PiAdapter(piMapping, { renderDeps: piSecrets.deps }),
      mapping: piMapping,
      parse: parseToml,
      deps: piSecrets.deps,
      secretsStore: piSecrets.secretsStore,
    },
  ];
}

// ===========================================================================
// 随机生成器
// ===========================================================================

/**
 * 随机 apiKey 生成器：带固定可识别前缀 "sk-" 的长随机串（>= 20）。
 *
 * 复用 injectCredential.property.test 的理由：真实密钥长而独特，极短子串会偶然出现在
 * baseUrl / 字段名 / 引用占位里，导致「是否含明文」的判定假阳性；独特长串让「明文是否
 * 出现」成为可严格判定的属性。
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
 * 随机「中立 ProviderConfig」生成器（供应商中立，不含 agent 专属 key 字段）。
 *
 * baseUrl / models 随机但语义合法；name 固定为字母串（避免影响 env 变量名拼接的断言）；
 * apiKeyRef 为中立引用。此配置用于驱动各适配器 render。
 */
const providerConfigArb: fc.Arbitrary<ProviderConfig> = fc.record({
  id: fc.constant("p1"),
  name: fc.constant("openai"),
  baseUrl: fc
    .webUrl({ validSchemes: ["http", "https"] })
    .filter((u) => u.length > 0),
  apiKeyRef: fc.constant("secret://p1"),
  models: fc.array(fc.stringMatching(/^[a-zA-Z0-9._-]{1,20}$/), {
    minLength: 1,
    maxLength: 6,
  }),
  timeoutMs: fc.integer({ min: 1000, max: 120000 }),
});

/**
 * 随机「非受管字段」的叶子值生成器：字符串 / 数字 / 布尔（避免对象/数组以简化保真断言）。
 */
const scalarArb: fc.Arbitrary<string | number | boolean> = fc.oneof(
  fc.stringMatching(/^[a-zA-Z0-9 _.-]{0,20}$/),
  fc.integer({ min: -1000, max: 1000 }),
  fc.boolean(),
);

/**
 * 顶层「非受管字段名」段：字母串，且刻意避开各适配器受管字段会占用的顶层键
 * （provider / providers / model / models / endpoint / apiKey），避免随机字段与受管路径
 * 的顶层容器相撞而被合并改写——那属于受管区域，不是 Property 2 要保护的非受管字段。
 */
const RESERVED_TOP_KEYS = new Set([
  "provider",
  "providers",
  "model",
  "models",
  "endpoint",
  "apiKey",
  "api_key_ref",
]);

/** 单个非受管顶层字段名生成器 */
const unmanagedKeyArb: fc.Arbitrary<string> = fc
  .stringMatching(/^[a-zA-Z]{1,10}$/)
  .filter((k) => !RESERVED_TOP_KEYS.has(k));

/**
 * 随机「既有配置的非受管部分」：一组顶层非受管字段（1~5 个），模拟用户已有的主题、
 * 快捷键、MCP 等与 API 无关的设置。合并后这些字段必须原样保留（Property 2）。
 */
const unmanagedTreeArb: fc.Arbitrary<Tree> = fc
  .dictionary(unmanagedKeyArb, scalarArb, { minKeys: 1, maxKeys: 5 })
  .map((d) => ({ ...d }));

// ===========================================================================
// Property 2（适配器维度）: 字段级合并保真——非 managedPaths 字段原样保留
// ===========================================================================

describe("适配器属性测试 - Property 2（适配器维度）: 字段级合并保真", () => {
  it("每个适配器 render 后，既有文件中的非 managedPaths 字段值原样保留", () => {
    // Validates: Requirements 10.1 / Property 2
    fcAssert(
      fc.property(
        providerConfigArb,
        unmanagedTreeArb,
        apiKeyArb,
        (config, unmanaged, apiKey) => {
          // 每次迭代新建适配器用例，保证内存 store 独立、互不污染
          for (const c of buildAdapterCases()) {
            // 既有配置文件内容：仅含非受管字段（JSON/TOML 分别按各适配器格式序列化）
            const existingContent =
              c.mapping.format === "toml"
                ? TOML.stringify(unmanaged as Record<string, unknown>)
                : JSON.stringify(unmanaged);

            const result: RenderResult = c.adapter.render(config, apiKey, existingContent);
            const merged = c.parse(result.mergedContent);

            // 断言：每个非受管顶层字段在合并后值不变（受管路径顶层键已被 RESERVED_TOP_KEYS 排除）
            for (const [key, value] of Object.entries(unmanaged)) {
              expect(merged[key]).toStrictEqual(value);
            }
          }
          return true;
        },
      ),
    );
  });
});

// ===========================================================================
// Property 14（适配器维度）: key 以声明形态出现且不泄露明文
// ===========================================================================

describe("适配器属性测试 - Property 14（适配器维度）: key 适配收敛于适配器且不泄露明文", () => {
  it("每个适配器 render 后，key 以其 CredentialMapping 声明的引用形态出现，且 mergedContent/maskedDiff 均不含明文", () => {
    // Validates: Requirements 9.7 / Property 14
    fcAssert(
      fc.property(providerConfigArb, apiKeyArb, (config, apiKey) => {
        for (const c of buildAdapterCases()) {
          // 既有内容给一个与 API 无关的字段，确保合并路径被真实走到
          const existingContent =
            c.mapping.format === "toml"
              ? TOML.stringify({ theme: "dark" })
              : JSON.stringify({ theme: "dark" });

          const result: RenderResult = c.adapter.render(config, apiKey, existingContent);
          const merged = c.parse(result.mergedContent);

          const credential = c.mapping.credential;
          // 四个内置适配器均声明 credential；若未声明则跳过（本断言针对声明式凭据）
          expect(credential).toBeDefined();
          if (!credential) {
            continue;
          }

          // (a) key 以声明的字段名/位置/引用形式出现在 targetPointer 处（{providerName} 已展开）
          const expectedRef = credential.valueTemplate
            .split("{providerName}")
            .join(config.name);
          expect(getByPointer(merged, credential.targetPointer)).toBe(expectedRef);

          // (b) env / secrets-file 形态下，配置文件与掩码 diff 均不含明文（仅引用占位）
          expect(result.mergedContent.includes(apiKey)).toBe(false);
          expect(result.maskedDiff.includes(apiKey)).toBe(false);
          // (c) 回传渲染进程的 RenderResult 整体序列化后不含明文
          expect(JSON.stringify(result).includes(apiKey)).toBe(false);

          // (b) 明文只落到注入的内存 store（env 或 secrets-file），未进配置文件
          if (credential.form === "env") {
            expect(c.envStore?.get(credential.envVarName!)).toBe(apiKey);
          } else if (credential.form === "secrets-file") {
            const sf = credential.secretsFile!;
            expect(c.secretsStore?.get(sf.path)?.get(sf.entryKey)).toBe(apiKey);
          }
        }
        return true;
      }),
    );
  });
});

// ===========================================================================
// Property 5: 扩展不变——注册新增适配器不改变其它已注册 agent 的分发行为
// ===========================================================================

/**
 * 一个「新增适配器」：声明与四个内置适配器不同的 id 与映射，用于模拟扩展一个新 agent。
 *
 * 其 render 走 env 引用形态（注入内存 writeEnv），确保注册它本身不触碰真实环境。
 */
function makeNewcomerAdapter(): AgentAdapter {
  const { writeEnv } = createInMemoryWriteEnv();
  const mapping: FormatMapping = {
    format: "json",
    fieldPaths: {
      baseUrl: "/newcomer/baseURL",
      models: "/newcomer/models",
    },
    managedPaths: ["baseUrl", "models"],
    credential: {
      targetPointer: "/newcomer/apiKey",
      form: "env",
      valueTemplate: "${NEWCOMER_API_KEY}",
      envVarName: "NEWCOMER_API_KEY",
    },
  };
  // 复用通用基类，仅声明差异；新增一个 agent 在真实工程里也只是多一份声明
  class NewcomerAdapter extends BaseAdapter {
    constructor() {
      super(
        {
          id: "newcomer",
          displayName: "newcomer",
          configPathTemplate: "newcomer/config.json",
          mapping,
        },
        { renderDeps: { writeEnv } },
      );
    }
  }
  return new NewcomerAdapter();
}

/**
 * 捕获某适配器在给定输入下的「分发行为快照」：configPath + detect + render 的全部产出。
 *
 * 这三者构成一次分发对单个 agent 的可观察行为面。若注册新适配器前后该快照完全相等，
 * 即证明「新增 agent 未改变此 agent 的分发行为」（Property 5 / 隔离性）。
 *
 * @param adapter  被观测的适配器
 * @param platform 平台上下文（驱动 detect/configPath）
 * @param config   provider 配置（驱动 render）
 * @param apiKey   明文密钥（驱动 render）
 * @param existing 既有配置文件内容（驱动 render 合并）
 */
async function captureBehavior(
  adapter: AgentAdapter,
  platform: PlatformContext,
  config: ProviderConfig,
  apiKey: string,
  existing: string | null,
): Promise<{ configPath: string; detect: unknown; render: RenderResult }> {
  const configPath = adapter.configPath(platform);
  const detect = await adapter.detect(platform);
  const render = adapter.render(config, apiKey, existing);
  return { configPath, detect, render };
}

/** 固定的平台上下文生成器（三平台随机），用于驱动 detect/configPath */
const platformArb: fc.Arbitrary<PlatformContext> = fc.record({
  os: fc.constantFrom<"win32" | "darwin" | "linux">("win32", "darwin", "linux"),
  homeDir: fc.constantFrom("/home/u", "C:\\Users\\u", "/Users/u"),
  env: fc.constant({
    APPDATA: "C:\\Users\\u\\AppData\\Roaming",
    XDG_CONFIG_HOME: "/home/u/.config",
  }),
});

describe("适配器属性测试 - Property 5: 扩展不变（注册新增适配器不影响其它 agent）", () => {
  it("向注册表注册一个新增适配器后，其它已注册 agent 的 configPath/detect/render 产出不变", async () => {
    // Validates: Requirements 8.2 / Property 5
    // detect 为异步，用 fc.asyncProperty + fc.assert（经 fcAssert 的同步形态无法 await），
    // 此处直接以 numRuns>=100 的异步断言执行。
    await fc.assert(
      fc.asyncProperty(
        providerConfigArb,
        apiKeyArb,
        platformArb,
        unmanagedTreeArb,
        async (config, apiKey, platform, unmanaged) => {
          // 1. 先用四个内置适配器建一个注册表（每个注入独立内存 store，detect 用恒真的内存检查）
          const registry = createAdapterRegistry();
          const { writeEnv: ocEnv } = createInMemoryWriteEnv();
          const { writeEnv: wbEnv } = createInMemoryWriteEnv();
          const { writeEnv: cbEnv } = createInMemoryWriteEnv();
          const { writeSecretsFile: piSec } = createInMemoryWriteSecretsFile();
          // 恒定的内存文件存在性检查：避免 detect 触碰真实文件系统，且结果稳定可比
          const fileExists = async (): Promise<boolean> => true;
          // 确定性命令执行器：让 CLI 型 adapter 的 detect 脱离真实环境（稳定可比、不 spawn 进程）
          const runCommand = async (): Promise<{ ok: boolean; output: string }> => ({
            ok: true,
            output: "1.0.0",
          });
          // 确定性文件读取器：让桌面应用型 adapter（workbuddy）的 detectFile 读到稳定的版本
          const readFile = async (): Promise<string | null> =>
            JSON.stringify({ appVersion: "1.0.0" });

          const opencode = new OpencodeAdapter(createOpencodeMapping(), {
            renderDeps: { writeEnv: ocEnv },
            fileExists,
            runCommand,
          });
          const workbuddy = new WorkbuddyAdapter(createWorkbuddyMapping(), {
            renderDeps: { writeEnv: wbEnv },
            fileExists,
            readFile,
          });
          const codebuddy = new CodebuddyAdapter(createCodebuddyMapping(), {
            renderDeps: { writeEnv: cbEnv },
            fileExists,
            runCommand,
          });
          const pi = new PiAdapter(createPiMapping(), {
            renderDeps: { writeSecretsFile: piSec },
            fileExists,
            runCommand,
          });

          registry.register(opencode);
          registry.register(workbuddy);
          registry.register(codebuddy);
          registry.register(pi);

          const existing = JSON.stringify(unmanaged);
          const existingToml = TOML.stringify(unmanaged as Record<string, unknown>);

          // 2. 注册「新增适配器」前，捕获每个已注册 agent 的分发行为快照
          const before = new Map<string, { configPath: string; detect: unknown; render: RenderResult }>();
          for (const a of registry.list()) {
            const content = a.id === "pi" ? existingToml : existing;
            before.set(a.id, await captureBehavior(a, platform, config, apiKey, content));
          }

          // 3. 注册一个全新的 newcomer 适配器（模拟扩展一个新 agent）
          registry.register(makeNewcomerAdapter());

          // 4. 再次捕获同样一组已注册 agent（排除 newcomer 自身）的分发行为快照
          for (const [id, snapshot] of before) {
            const a = registry.get(id)!;
            const content = id === "pi" ? existingToml : existing;
            const after = await captureBehavior(a, platform, config, apiKey, content);

            // 隔离性断言：configPath / detect / render 三项产出与注册新适配器前完全一致
            expect(after.configPath).toBe(snapshot.configPath);
            expect(after.detect).toStrictEqual(snapshot.detect);
            expect(after.render).toStrictEqual(snapshot.render);
          }

          // 5. 新增适配器确实被纳入注册表（扩展生效），且不改变既有条目数量语义
          expect(registry.get("newcomer")).toBeDefined();
          expect(registry.list().some((a) => a.id === "newcomer")).toBe(true);

          return true;
        },
      ),
      { numRuns: 100 },
    );
  });
});
