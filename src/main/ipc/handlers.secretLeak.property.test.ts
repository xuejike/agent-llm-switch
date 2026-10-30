// IPC 边界「密钥不泄露」测试（handlers.secretLeak.property.test）
//
// 覆盖任务 11.4 与需求 2.6 / 3.4、Property 1 / Property 8：
//   断言经 IPC channel 回传渲染进程的 getMaskedSecret、preview/distribute 的 maskedDiff、
//   fetchModels / probeModels 的结果，序列化后均「不含明文密钥」。
//
// 与既有 handlers.test.ts 的区别（互补而非重复）：
//   handlers.test.ts 用「返回预置已掩码结果」的替身 Distributor / ModelDiscovery 验证编排；
//   本文件改用「真实」的 Distributor 与 ModelDiscovery（经真实 OpencodeAdapter 的 render、
//   真实的鉴权注入与 mock httpSend），把已知明文密钥存入内存 SecretStore 后，走完整的主进程
//   编排链路，断言跨进程边界回传的数据端到端不含明文。由此更贴近真实运行时的「不泄露」保证。
//
// 测试替身与隔离（遵循全局约定：不触达真实外网、真实 OS 凭据库、真实文件系统）：
//   - SecretStore：内存实现 InMemorySecretStore，存入已知明文密钥；
//   - ModelDiscovery：真实实现 + 注入 mock httpSend（返回 OpenAI 风格模型清单与探测响应），
//     真实解析明文并注入鉴权，但绝不回传明文；
//   - Distributor：真实实现 + 内存 AtomicFileWriter（捕获写盘内容，不碰真实磁盘）+ 内存
//     readExisting（提供既有配置文本）+ 内存 writeEnv（捕获 env 形态落地的明文，不污染
//     process.env）；注册注入 fileExists:()=>true 的真实 OpencodeAdapter，使 preview/
//     distribute 真正走到 render 产出真实 maskedDiff；
//   - ipcMain：捕获型替身 FakeIpcMain，可按 channel 直接 invoke 模拟渲染进程调用。
//
// **Validates: Requirements 2.6, 3.4 / Property 1, Property 8**

import { describe, it, expect } from "vitest";
import fc from "fast-check";
import { fcAssertAsync } from "@shared/testing/fcConfig";
import type {
  ApplyReport,
  FetchModelsResult,
  ModelProbeResult,
  PlatformContext,
  PreviewResult,
  ProviderConfig,
} from "@shared/types";

import {
  registerIpcHandlers,
  IPC_CHANNELS,
  type IpcMainLike,
  type IpcHandlerDeps,
} from "./handlers";
import { InMemorySecretStore } from "../services/secretStore";
import { createConfigStore, type ConfigStoreFs } from "../services/configStore";
import { createDistributor, type ReadExistingFile } from "../services/distributor";
import { createModelDiscovery } from "../services/modelDiscovery";
import type { HttpSend, HttpResponse } from "../services/http";
import { createAdapterRegistry, type AdapterRegistry } from "../adapters/registry";
import { OpencodeAdapter, createOpencodeMapping } from "../adapters/opencodeAdapter";
import type { WriteEnv } from "../core/render";
import type { AtomicFileWriter } from "../services/atomicFileWriter";

// ---------------------------------------------------------------------------
// 捕获型 ipcMain 替身：记录各 channel 的 handler，支持按 channel 直接 invoke
// ---------------------------------------------------------------------------

/** 捕获型 ipcMain：记录每个 channel 的 handler，并可模拟渲染进程发起的一次 invoke */
class FakeIpcMain implements IpcMainLike {
  private readonly handlers = new Map<
    string,
    (event: unknown, ...args: unknown[]) => unknown
  >();

  handle(channel: string, listener: (event: unknown, ...args: unknown[]) => unknown): void {
    this.handlers.set(channel, listener);
  }

  /** 模拟渲染进程经 preload 发起的一次 invoke（event 以 null 占位） */
  async invoke(channel: string, ...args: unknown[]): Promise<unknown> {
    const handler = this.handlers.get(channel);
    if (!handler) {
      throw new Error(`未注册的 channel：${channel}`);
    }
    return handler(null, ...args);
  }
}

// ---------------------------------------------------------------------------
// 内存版 ConfigStoreFs：以 Map 模拟磁盘，避免真实 I/O 与 Electron 依赖
// ---------------------------------------------------------------------------

function createMemoryConfigFs(): ConfigStoreFs {
  const files = new Map<string, string>();
  return {
    async ensureDir(): Promise<void> {
      // 内存实现无需真实建目录
    },
    async readFile(path: string): Promise<string> {
      if (!files.has(path)) {
        const err = new Error("ENOENT") as NodeJS.ErrnoException;
        err.code = "ENOENT";
        throw err;
      }
      return files.get(path) as string;
    },
    async writeFile(path: string, data: string): Promise<void> {
      files.set(path, data);
    },
    async rename(from: string, to: string): Promise<void> {
      files.set(to, files.get(from) as string);
      files.delete(from);
    },
  };
}

// ---------------------------------------------------------------------------
// 内存 AtomicFileWriter：捕获写盘内容，绝不触达真实磁盘
// ---------------------------------------------------------------------------

/**
 * 内存文件写入器：distribute 的真实适配器 apply 会调用它完成「备份→原子写入」。
 * 把写入内容保存在 Map 中以便断言，既隔离真实磁盘，也能检查最终落盘文本是否含明文。
 */
function createMemoryFileWriter(): { writer: AtomicFileWriter; files: Map<string, string> } {
  const files = new Map<string, string>();
  const writer: AtomicFileWriter = {
    async backup(targetPath: string): Promise<string | null> {
      // 既有则生成一个备份名（内容不复制也无妨，测试不校验备份内容），否则返回 null
      return files.has(targetPath) ? `${targetPath}.bak` : null;
    },
    async atomicWrite(targetPath: string, content: string): Promise<void> {
      files.set(targetPath, content);
    },
    async restore(_backupPath: string, _targetPath: string): Promise<void> {
      // 测试不触发失败回滚；留空实现即可
    },
  };
  return { writer, files };
}

// ---------------------------------------------------------------------------
// 固定装配数据
// ---------------------------------------------------------------------------

const PLATFORM: PlatformContext = {
  os: "linux",
  homeDir: "/home/tester",
  env: {},
};

/** 测试用的密钥引用 */
const KEY_REF = "ref-openai";

/**
 * 构造一个声明了模型列表/探测端点的 OpenAI 风格 ProviderConfig。
 *
 * 带 modelListing / modelProbe 使 fetchModels/probeModels 走真实的「解析密钥→注入鉴权→
 * httpSend」链路；bearer 鉴权要求解析明文，正好检验明文不被回传。
 */
function makeProviderConfig(overrides: Partial<ProviderConfig> = {}): ProviderConfig {
  return {
    id: "p1",
    name: "openai",
    baseUrl: "https://api.example.com",
    apiKeyRef: KEY_REF,
    models: ["gpt-4o-mini"],
    modelListing: {
      path: "/v1/models",
      method: "GET",
      auth: { in: "header", kind: "bearer", name: "Authorization", valueTemplate: "Bearer {key}" },
      responseMapping: { arrayPointer: "/data", idField: "id" },
    },
    modelProbe: {
      path: "/v1/chat/completions",
      method: "POST",
      auth: { in: "header", kind: "bearer", name: "Authorization", valueTemplate: "Bearer {key}" },
      bodyTemplate: { model: "{model}", max_tokens: 1 },
    },
    ...overrides,
  };
}

/**
 * 构造一个返回 OpenAI 风格模型清单与「可用」探测响应的 mock httpSend。
 *
 * 响应体只含模型元信息、不回显任何请求头/密钥，模拟真实服务的典型响应；
 * 无论请求头里注入了什么明文，响应中都不含明文——这正是「不泄露」要验证的前提。
 */
function makeMockHttpSend(modelIds: string[]): HttpSend {
  return async (req): Promise<HttpResponse> => {
    // 列表端点（GET /v1/models）：返回 OpenAI 风格 { data: [{ id }] }
    if (req.method === "GET") {
      return {
        status: 200,
        headers: { "content-type": "application/json" },
        body: { object: "list", data: modelIds.map((id) => ({ id, object: "model" })) },
        latencyMs: 10,
      };
    }
    // 探测端点（POST /v1/chat/completions）：返回 2xx 表示可用
    return {
      status: 200,
      headers: { "content-type": "application/json" },
      body: { id: "chatcmpl-x", object: "chat.completion", choices: [] },
      latencyMs: 12,
    };
  };
}

interface Harness {
  ipc: FakeIpcMain;
  secretStore: InMemorySecretStore;
  files: Map<string, string>;
  /** 内存 writeEnv 捕获到的 env 落地明文（用于必要时的内部校验，不经 IPC 回传） */
  capturedEnv: Map<string, string>;
}

/**
 * 装配一套以「真实」Distributor + ModelDiscovery 为核心的 IPC handler 测试台。
 *
 * @param modelIds mock 列表端点返回的模型 id 集合
 * @returns 测试台（含可 invoke 的 ipc、内存 secretStore、落盘文件 Map 等）
 */
function setup(modelIds: string[] = ["gpt-4o-mini", "gpt-4o"]): Harness {
  const ipc = new FakeIpcMain();
  const secretStore = new InMemorySecretStore();
  const configStore = createConfigStore({ dataDir: "/data", fs: createMemoryConfigFs() });

  // 内存文件写入器：捕获 distribute 真实写盘内容
  const { writer, files } = createMemoryFileWriter();

  // 内存 writeEnv：opencode 为 env 凭据形态，render 会把明文落到环境变量引用目标。
  // 注入内存实现捕获明文，既避免污染真实 process.env，也便于确认明文确实只落在了
  // 「引用目标」而非经 IPC 回传（maskedDiff/mergedContent 只含 {env:VAR} 占位）。
  const capturedEnv = new Map<string, string>();
  const writeEnv: WriteEnv = (name: string, value: string): void => {
    capturedEnv.set(name, value);
  };

  // 注册真实 OpencodeAdapter，但注入确定性 runCommand 使其 detect 判为「已安装」（opencode 经
  // CLI 版本命令探测安装；注入成功替身避免真实 spawn 子进程），从而 preview/distribute 真正进入
  // render 产出真实 maskedDiff；render 依赖注入内存 writeEnv。
  const registry: AdapterRegistry = createAdapterRegistry();
  registry.register(
    new OpencodeAdapter(createOpencodeMapping("openai"), {
      runCommand: async () => ({ ok: true, output: "1.0.0" }),
      renderDeps: { writeEnv },
    }),
  );

  // 内存 readExisting：提供一份含「非受管字段」的既有 opencode 配置，既覆盖字段级合并，
  // 也保证 render 有既有内容可读（不碰真实文件系统）。
  const readExisting: ReadExistingFile = async () =>
    JSON.stringify({ theme: "dark", provider: { openai: { npm: "@ai-sdk/openai-compatible" } } });

  // 真实 Distributor：注入内存写入器、内存 readExisting、内存 writeEnv 的 renderDeps
  const distributor = createDistributor({
    registry,
    secretStore,
    fileWriter: writer,
    platform: PLATFORM,
    renderDeps: { writeEnv },
    readExisting,
  });

  // 真实 ModelDiscovery：注入内存 secretStore 与 mock httpSend
  const modelDiscovery = createModelDiscovery({
    secretStore,
    httpSend: makeMockHttpSend(modelIds),
  });

  const deps: IpcHandlerDeps = {
    ipcMain: ipc,
    configStore,
    secretStore,
    modelDiscovery,
    distributor,
    registry,
    platform: PLATFORM,
  };
  registerIpcHandlers(deps);

  return { ipc, secretStore, files, capturedEnv };
}

/** 断言某个「将经 IPC 回传渲染进程」的值序列化后不含明文密钥 */
function expectNoPlaintext(value: unknown, plaintext: string): void {
  expect(JSON.stringify(value)).not.toContain(plaintext);
}

// ===========================================================================
// 定点用例：用一个固定的已知明文密钥，走真实链路验证各回传通道均不含明文
// ===========================================================================

describe("IPC 边界密钥不泄露（真实 Distributor/ModelDiscovery，定点用例）", () => {
  const PLAINTEXT = "sk-plaintext-SUPER-SECRET-abcdefghijklmnop-1234";

  it("getMaskedSecret 只回传掩码串，不含明文（需求 2.6 / 3.4）", async () => {
    const { ipc } = setup();
    await ipc.invoke(IPC_CHANNELS.saveSecret, KEY_REF, PLAINTEXT);

    const masked = (await ipc.invoke(IPC_CHANNELS.getMaskedSecret, KEY_REF)) as string | null;
    expect(masked).toBeTypeOf("string");
    expect(masked).not.toBe(PLAINTEXT);
    expectNoPlaintext(masked, PLAINTEXT);
  });

  it("preview 的 maskedDiff 经真实 render 产出，不含明文（Property 1）", async () => {
    const { ipc } = setup();
    await ipc.invoke(IPC_CHANNELS.saveSecret, KEY_REF, PLAINTEXT);

    const results = (await ipc.invoke(
      IPC_CHANNELS.preview,
      makeProviderConfig(),
      ["opencode"],
    )) as PreviewResult[];

    // 真实适配器已安装、真实走 render，maskedDiff 为非空真实差异
    expect(results).toHaveLength(1);
    expect(results[0]?.installed).toBe(true);
    expectNoPlaintext(results, PLAINTEXT);
  });

  it("distribute 的报告与落盘内容均不含明文（Property 1）", async () => {
    const { ipc, files } = setup();
    await ipc.invoke(IPC_CHANNELS.saveSecret, KEY_REF, PLAINTEXT);

    const report = (await ipc.invoke(
      IPC_CHANNELS.distribute,
      makeProviderConfig(),
      ["opencode"],
    )) as ApplyReport;

    // 报告回传渲染进程：不含明文
    expectNoPlaintext(report, PLAINTEXT);
    // 真实落盘的配置文本（env 凭据形态只写 {env:VAR} 引用占位）也不含明文
    for (const content of files.values()) {
      expect(content).not.toContain(PLAINTEXT);
    }
  });

  it("fetchModels 结果（真实解析密钥+注入鉴权）不含明文（Property 8）", async () => {
    const { ipc } = setup(["gpt-4o-mini", "gpt-4o"]);
    await ipc.invoke(IPC_CHANNELS.saveSecret, KEY_REF, PLAINTEXT);

    const result = (await ipc.invoke(
      IPC_CHANNELS.fetchModels,
      makeProviderConfig(),
    )) as FetchModelsResult;

    expect(result.supportsListing).toBe(true);
    expect(result.models.map((m) => m.id)).toContain("gpt-4o-mini");
    expectNoPlaintext(result, PLAINTEXT);
  });

  it("probeModels 结果（真实解析密钥+注入鉴权）不含明文（Property 8）", async () => {
    const { ipc } = setup();
    await ipc.invoke(IPC_CHANNELS.saveSecret, KEY_REF, PLAINTEXT);

    const results = (await ipc.invoke(
      IPC_CHANNELS.probeModels,
      makeProviderConfig(),
      ["gpt-4o-mini", "gpt-4o"],
    )) as ModelProbeResult[];

    expect(results.map((r) => r.modelId)).toEqual(["gpt-4o-mini", "gpt-4o"]);
    expectNoPlaintext(results, PLAINTEXT);
  });
});

// ===========================================================================
// Property 1：随机 apiKey → 掩码与 maskedDiff 均不含明文
// ===========================================================================

describe("Property 1: 密钥不泄露（IPC 回传的 maskedDiff / 掩码串）", () => {
  // 随机 apiKey 生成器：模拟真实 API Key 的典型样貌——固定前缀 "sk-" + 足够长的高熵随机段。
  //
  // 刻意约束长度 >= 8 且带高熵随机段，是为了让断言只检验「真正的密钥泄露」这一语义：
  // 若放任生成单字符/空格等退化明文，它们会与 JSON 结构字符、缩进等「合法非密钥内容」
  // 发生偶然子串碰撞，使「不含明文」失去意义（这类碰撞属测试构造不当，而非被测代码泄露）。
  // 前缀 "sk-" 也保证明文不会恰好等于某个普通短标识符。
  const apiKeyArb = fc
    .string({ minLength: 16, maxLength: 64, unit: fc.constantFrom(..."ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789") })
    .map((s) => `sk-${s}`);

  it("随机 apiKey：getMaskedSecret 与 preview.maskedDiff 序列化均不含明文", async () => {
    // **Validates: Requirements 2.6 / Property 1**（numRuns >= 100，见 fcConfig）
    await fcAssertAsync(
      fc.asyncProperty(apiKeyArb, async (plaintext) => {
        const { ipc } = setup();
        await ipc.invoke(IPC_CHANNELS.saveSecret, KEY_REF, plaintext);

        // 通道 1：getMaskedSecret
        const masked = await ipc.invoke(IPC_CHANNELS.getMaskedSecret, KEY_REF);
        expect(JSON.stringify(masked)).not.toContain(plaintext);

        // 通道 2：preview 的 maskedDiff（真实 render 产出）
        const previews = (await ipc.invoke(
          IPC_CHANNELS.preview,
          makeProviderConfig(),
          ["opencode"],
        )) as PreviewResult[];
        expect(JSON.stringify(previews)).not.toContain(plaintext);
      }),
    );
  });
});

// ===========================================================================
// Property 8：随机 apiKey + 随机模型集合 → fetch/probe 回传均不含明文
// ===========================================================================

describe("Property 8: 发现与探测过程不泄露明文密钥（经 IPC 回传）", () => {
  // 同 Property 1：明文模拟真实 API Key（"sk-" 前缀 + 高熵随机段），避免与模型 id 碰撞。
  const apiKeyArb = fc
    .string({ minLength: 16, maxLength: 64, unit: fc.constantFrom(..."ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789") })
    .map((s) => `sk-${s}`);
  // 随机模型 id 集合：非空、去重、限定字符集以构成合法 OpenAI 风格 id。
  // 不以 "sk-" 开头，从构造上保证模型 id 与明文密钥不可能相等/互为子串（避免偶然碰撞）。
  const modelIdsArb = fc.uniqueArray(
    fc.stringMatching(/^(model|gpt|claude)[A-Za-z0-9._-]{0,20}$/),
    { minLength: 1, maxLength: 6 },
  );

  it("随机 apiKey + 随机模型集合：fetchModels / probeModels 结果均不含明文", async () => {
    // **Validates: Requirements 3.4 / Property 8**（numRuns >= 100，见 fcConfig）
    await fcAssertAsync(
      fc.asyncProperty(apiKeyArb, modelIdsArb, async (plaintext, modelIds) => {
        const { ipc } = setup(modelIds);
        await ipc.invoke(IPC_CHANNELS.saveSecret, KEY_REF, plaintext);

        const config = makeProviderConfig();

        // fetchModels：真实解析明文密钥并注入 bearer 鉴权后请求 mock 端点
        const fetched = await ipc.invoke(IPC_CHANNELS.fetchModels, config);
        expect(JSON.stringify(fetched)).not.toContain(plaintext);

        // probeModels：真实解析明文密钥并注入 bearer 鉴权后探测 mock 端点
        const probed = await ipc.invoke(IPC_CHANNELS.probeModels, config, modelIds);
        expect(JSON.stringify(probed)).not.toContain(plaintext);
      }),
    );
  });
});
