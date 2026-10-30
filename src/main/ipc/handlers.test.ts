// 主进程 IPC handlers 的单元测试
//
// 覆盖任务 11.1 与需求 3.2 / 3.4 / 2.6 / 2.7：
// - registerIpcHandlers 把 IpcApi 全部方法注册到 ipcMain，并正确编排到各服务；
// - 回传渲染进程的数据「不含明文密钥」：getMaskedSecret 只返回掩码串、loadAppState/
//   preview/distribute/fetchModels/probeModels 结果均不夹带明文。
//
// 测试策略：
// - 注入替身 ipcMain（捕获 channel→handler 映射，可直接调用以模拟渲染进程发起的 invoke）；
// - 注入内存 SecretStore（不触达真实凭据库）、内存 ConfigStore（注入内存 fs）、
//   替身 Distributor / ModelDiscovery（返回预置、已掩码的结果）、含捕获型适配器的注册表；
// - 不依赖真实 Electron 运行时。

import { describe, it, expect } from "vitest";
import type {
  AppState,
  ApplyReport,
  DetectResult,
  FetchModelsResult,
  ModelProbeResult,
  PlatformContext,
  PreviewResult,
  ProviderConfig,
  RenderResult,
} from "@shared/types";

import {
  registerIpcHandlers,
  IPC_CHANNELS,
  type IpcMainLike,
  type IpcHandlerDeps,
} from "./handlers";
import { InMemorySecretStore } from "../services/secretStore";
import { createConfigStore, type ConfigStoreFs } from "../services/configStore";
import type { Distributor } from "../services/distributor";
import type { ModelDiscovery } from "../services/modelDiscovery";
import { createAdapterRegistry, type AdapterRegistry } from "../adapters/registry";
import type { AgentAdapter } from "../adapters/base";
import type { AtomicFileWriter } from "../services/atomicFileWriter";

// ---------------------------------------------------------------------------
// 替身 ipcMain：捕获注册的 handler，提供 invoke 以模拟渲染进程调用
// ---------------------------------------------------------------------------

/** 捕获型 ipcMain：记录每个 channel 的 handler，并可按 channel 直接调用 */
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

  /** 已注册的 channel 集合（用于断言覆盖面） */
  registeredChannels(): string[] {
    return Array.from(this.handlers.keys());
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
// 捕获型适配器：仅为 detect/list 提供可控结果
// ---------------------------------------------------------------------------

/** 可配置 installed 的最小适配器替身 */
function makeFakeAdapter(id: string, displayName: string, installed: boolean): AgentAdapter {
  const configPath = `/fake/${id}/config.json`;
  return {
    id,
    displayName,
    configPath: (): string => configPath,
    async detect(): Promise<DetectResult> {
      return { installed, configPath, fileExists: installed };
    },
    render(): RenderResult {
      return { mergedContent: "{}", maskedDiff: "" };
    },
    async apply(_path, _r, _w: AtomicFileWriter) {
      return { agentId: id, status: "success" as const };
    },
  };
}

// ---------------------------------------------------------------------------
// 测试固定数据与装配
// ---------------------------------------------------------------------------

/** 明文密钥：测试断言「任何回传都不含它」 */
const PLAINTEXT_KEY = "sk-plaintext-SUPER-SECRET-1234";

const PLATFORM: PlatformContext = {
  os: "linux",
  homeDir: "/home/tester",
  env: {},
};

function makeProviderConfig(): ProviderConfig {
  return {
    id: "p1",
    name: "openai",
    baseUrl: "https://api.example.com",
    apiKeyRef: "ref-p1",
    models: ["gpt-4o-mini"],
  };
}

/** 替身 Distributor：返回已掩码、不含明文的预置结果 */
function makeFakeDistributor(): Distributor {
  return {
    async preview(_config, agentIds): Promise<PreviewResult[]> {
      return agentIds.map((agentId) => ({
        agentId,
        configPath: `/fake/${agentId}/config.json`,
        installed: true,
        // render 已掩码：此处模拟不含明文的 diff
        maskedDiff: `+ apiKey: sk-****1234`,
      }));
    },
    async distribute(_config, agentIds): Promise<ApplyReport> {
      return {
        timestamp: "2024-01-01T00:00:00.000Z",
        entries: agentIds.map((agentId) => ({ agentId, status: "success" as const })),
        summary: { success: agentIds.length, failed: 0, skipped: 0 },
      };
    },
  };
}

/** 替身 ModelDiscovery：返回不含明文的模型元信息 */
function makeFakeModelDiscovery(): ModelDiscovery {
  return {
    async fetchModels(): Promise<FetchModelsResult> {
      return {
        supportsListing: true,
        models: [{ id: "gpt-4o-mini", source: "fetched", availability: "unknown" }],
      };
    },
    async probeModel(): Promise<ModelProbeResult> {
      return { modelId: "gpt-4o-mini", availability: "available", probedAt: "2024-01-01T00:00:00.000Z" };
    },
    async probeModels(_config: ProviderConfig, modelIds: string[]): Promise<ModelProbeResult[]> {
      return modelIds.map((modelId) => ({
        modelId,
        availability: "available" as const,
        latencyMs: 12,
        probedAt: "2024-01-01T00:00:00.000Z",
      }));
    },
  } as unknown as ModelDiscovery;
}

interface Harness {
  ipc: FakeIpcMain;
  secretStore: InMemorySecretStore;
  registry: AdapterRegistry;
}

function setup(): Harness {
  const ipc = new FakeIpcMain();
  const secretStore = new InMemorySecretStore();
  const configStore = createConfigStore({ dataDir: "/data", fs: createMemoryConfigFs() });
  const registry = createAdapterRegistry();
  registry.register(makeFakeAdapter("opencode", "OpenCode", true));
  registry.register(makeFakeAdapter("pi", "Pi", false));

  const deps: IpcHandlerDeps = {
    ipcMain: ipc,
    configStore,
    secretStore,
    modelDiscovery: makeFakeModelDiscovery(),
    distributor: makeFakeDistributor(),
    registry,
    platform: PLATFORM,
  };
  registerIpcHandlers(deps);
  return { ipc, secretStore, registry };
}

/** 递归断言某个序列化后的回传对象不含明文密钥 */
function expectNoPlaintext(value: unknown): void {
  expect(JSON.stringify(value)).not.toContain(PLAINTEXT_KEY);
}

// ===========================================================================
// 用例
// ===========================================================================

describe("registerIpcHandlers：channel 覆盖", () => {
  it("注册 IpcApi 契约的全部 10 个 channel", () => {
    const { ipc } = setup();
    const expected = Object.values(IPC_CHANNELS).sort();
    expect(ipc.registeredChannels().sort()).toEqual(expected);
  });
});

describe("应用状态 load/save 编排", () => {
  it("saveAppState 后 loadAppState 往返一致，且不含明文", async () => {
    const { ipc } = setup();
    const state: AppState = {
      providers: [makeProviderConfig()],
      agents: [{ agentId: "opencode", enabled: true }],
      activeProviderId: "p1",
    };
    await ipc.invoke(IPC_CHANNELS.saveAppState, state);
    const loaded = (await ipc.invoke(IPC_CHANNELS.loadAppState)) as AppState;

    expect(loaded.providers[0]?.id).toBe("p1");
    expect(loaded.agents[0]?.agentId).toBe("opencode");
    expect(loaded.activeProviderId).toBe("p1");
    // AppState 只含中立 apiKeyRef，绝不含明文
    expectNoPlaintext(loaded);
  });
});

describe("密钥 save/getMasked 编排（不回传明文）", () => {
  it("saveSecret 存入后 getMaskedSecret 只返回掩码串，不含明文", async () => {
    const { ipc } = setup();
    await ipc.invoke(IPC_CHANNELS.saveSecret, "ref-p1", PLAINTEXT_KEY);

    const masked = (await ipc.invoke(IPC_CHANNELS.getMaskedSecret, "ref-p1")) as string | null;
    expect(masked).toBeTypeOf("string");
    // 掩码串不等于明文，也不包含明文中段
    expect(masked).not.toBe(PLAINTEXT_KEY);
    expectNoPlaintext(masked);
  });

  it("getMaskedSecret 对不存在的 keyRef 返回 null（不抛错、不泄露）", async () => {
    const { ipc } = setup();
    const masked = await ipc.invoke(IPC_CHANNELS.getMaskedSecret, "no-such-ref");
    expect(masked).toBeNull();
  });
});

describe("Agent detect / list 编排", () => {
  it("detectAgents 与请求 id 一一对应，含未注册 id 的占位", async () => {
    const { ipc } = setup();
    const results = (await ipc.invoke(IPC_CHANNELS.detectAgents, [
      "opencode",
      "pi",
      "unknown",
    ])) as DetectResult[];

    expect(results).toHaveLength(3);
    expect(results[0]?.installed).toBe(true); // opencode 已安装
    expect(results[1]?.installed).toBe(false); // pi 未安装
    expect(results[2]).toEqual({ installed: false, configPath: "", fileExists: false }); // 未注册占位
  });

  it("listAgents 只投影 id/displayName", async () => {
    const { ipc } = setup();
    const list = (await ipc.invoke(IPC_CHANNELS.listAgents)) as {
      id: string;
      displayName: string;
    }[];
    expect(list).toEqual(
      expect.arrayContaining([
        { id: "opencode", displayName: "OpenCode" },
        { id: "pi", displayName: "Pi" },
      ]),
    );
  });
});

describe("分发 preview / distribute 编排（maskedDiff 不含明文）", () => {
  it("preview 返回每个 agent 的掩码差异，不含明文", async () => {
    const { ipc } = setup();
    const results = (await ipc.invoke(IPC_CHANNELS.preview, makeProviderConfig(), [
      "opencode",
    ])) as PreviewResult[];
    expect(results[0]?.agentId).toBe("opencode");
    expectNoPlaintext(results);
  });

  it("distribute 返回完备报告，不含明文", async () => {
    const { ipc } = setup();
    const report = (await ipc.invoke(IPC_CHANNELS.distribute, makeProviderConfig(), [
      "opencode",
      "pi",
    ])) as ApplyReport;
    expect(report.entries).toHaveLength(2);
    expect(report.summary.success + report.summary.failed + report.summary.skipped).toBe(2);
    expectNoPlaintext(report);
  });
});

describe("模型 fetch / probe 编排（结果不含明文）", () => {
  it("fetchModels 返回候选清单，不含明文", async () => {
    const { ipc } = setup();
    const result = (await ipc.invoke(
      IPC_CHANNELS.fetchModels,
      makeProviderConfig(),
    )) as FetchModelsResult;
    expect(result.supportsListing).toBe(true);
    expect(result.models[0]?.id).toBe("gpt-4o-mini");
    expectNoPlaintext(result);
  });

  it("probeModels 与 modelIds 一一对应，不含明文", async () => {
    const { ipc } = setup();
    const results = (await ipc.invoke(IPC_CHANNELS.probeModels, makeProviderConfig(), [
      "a",
      "b",
    ])) as ModelProbeResult[];
    expect(results.map((r) => r.modelId)).toEqual(["a", "b"]);
    expectNoPlaintext(results);
  });
});
