// Distributor 故障隔离单元测试（任务 10.3）
//
// 覆盖 design.md 组件 3 分发编排器在各类单点故障下的「故障隔离」行为，验证需求
// 8.5 / 10.4 / 10.5 / 11.4 / 11.5 对应的五个核心场景：
//
//   1. 未安装 → skipped：detect 判定未安装的 agent 标记为 skipped、记录原因、不写任何文件
//      （需求 8.5）。
//   2. 部分失败隔离：多个 agent 中一个失败回滚，不影响其它成功者；成功者正常写入，
//      失败者各自隔离（需求 11.4 / 11.5）。
//   3. 密钥解析失败前置校验：非无鉴权场景下 SecretStore 无法解析 apiKeyRef 时，在进入写盘
//      阶段前即判 failed，绝不触碰磁盘（不调用 render / 不调用写入器）（需求 10.5）。
//   4. 既有文件损坏 → failed：render 解析既有内容抛错时该 agent failed，且不覆盖原文件
//      （render 抛错发生在写盘前，天然不触碰磁盘）（需求 10.4）。
//   5. 凭据引用目标写入失败 → failed 并回滚：适配器 apply（写入器 atomicWrite）失败时，
//      该 agent failed 并执行回滚（restore / 删除），不影响其它 agent（需求 11.5）。
//
// 测试约定：
//   - 依赖全部用内存测试替身：FakeRegistry（返回预置 adapter）、内存 SecretStore
//     （InMemorySecretStore，可模拟不存在 / 存储失败）、FakeWriter（记录调用并可注入写入失败）、
//     可注入 readExisting（内存既有内容）、固定 PlatformContext。
//   - 绝不触碰真实文件系统与真实 OS 凭据库：没有任何真实 fs / safeStorage 调用。
//   - 适配器用轻量 FakeAdapter 替身，精确控制 detect / render / apply 的行为以隔离被测点，
//     把「分发编排器自身的故障隔离逻辑」与「适配器内部实现」解耦。

import { describe, it, expect } from "vitest";
import type {
  ApplyEntry,
  DetectResult,
  PlatformContext,
  ProviderConfig,
  RenderResult,
} from "@shared/types";
import type { AgentAdapter } from "../adapters/base";
import type { AdapterRegistry } from "../adapters/registry";
import type { AtomicFileWriter } from "./atomicFileWriter";
import { InMemorySecretStore, SecretStoreError, type SecretStore } from "./secretStore";
import { DefaultDistributor, type DistributorDeps, type ReadExistingFile } from "./distributor";

// ===========================================================================
// 测试替身：注册表 / 适配器 / 写入器
// ===========================================================================

/**
 * 内存适配器注册表替身：按 id 返回预置适配器，未命中返回 undefined。
 *
 * 只实现被测路径用到的 get / register / list，不触碰真实文件系统。
 */
class FakeRegistry implements AdapterRegistry {
  private readonly map = new Map<string, AgentAdapter>();

  constructor(adapters: AgentAdapter[] = []) {
    for (const a of adapters) {
      this.map.set(a.id, a);
    }
  }

  register(adapter: AgentAdapter): void {
    this.map.set(adapter.id, adapter);
  }

  get(agentId: string): AgentAdapter | undefined {
    return this.map.get(agentId);
  }

  list(): AgentAdapter[] {
    return Array.from(this.map.values());
  }
}

/**
 * 记录调用的写入器替身：默认 atomicWrite 成功；可注入在 atomicWrite 时抛错以模拟
 * 「凭据引用目标写入失败」。backup/restore 以内存记录调用参数，供断言回滚是否被触发。
 *
 * 不进行任何真实文件 I/O。
 */
class FakeWriter implements AtomicFileWriter {
  /** backup 的调用记录（目标路径） */
  readonly backupCalls: string[] = [];
  /** atomicWrite 的调用记录（目标路径 + 内容） */
  readonly writeCalls: Array<{ target: string; content: string }> = [];
  /** restore 的调用记录（备份路径 → 目标路径） */
  readonly restoreCalls: Array<{ backup: string; target: string }> = [];

  /**
   * @param options.backupReturns backup 返回的备份路径；null 表示「分发前目标不存在」
   * @param options.failWriteFor   命中集合内的目标路径时 atomicWrite 抛错，模拟写入失败
   */
  constructor(
    private readonly options: {
      backupReturns?: string | null;
      failWriteFor?: Set<string>;
    } = {},
  ) {}

  async backup(targetPath: string): Promise<string | null> {
    this.backupCalls.push(targetPath);
    // 默认返回一个假的备份路径（表示原文件存在、已备份），便于断言失败时走 restore 回滚
    return this.options.backupReturns ?? `${targetPath}.bak.TEST`;
  }

  async atomicWrite(targetPath: string, content: string): Promise<void> {
    if (this.options.failWriteFor?.has(targetPath)) {
      // 模拟凭据引用目标写入失败（如磁盘错误 / 权限不足）
      throw new Error(`模拟写入失败：${targetPath}`);
    }
    this.writeCalls.push({ target: targetPath, content });
  }

  async restore(backupPath: string, targetPath: string): Promise<void> {
    this.restoreCalls.push({ backup: backupPath, target: targetPath });
  }
}

/**
 * 轻量适配器替身：精确控制 detect / render / apply 行为，用于隔离被测的分发编排逻辑。
 *
 * - detect：由 installed 决定「是否安装」，configPath 固定可预测；
 * - render：默认产出可预测的合并内容；可注入抛错以模拟「既有文件损坏」；
 * - apply：默认复刻基类语义——backup → atomicWrite（失败则 restore/删除回滚）→ 返回 ApplyEntry，
 *   从而让「写入器 atomicWrite 失败 → 该 agent failed 并回滚」这一真实路径被覆盖。
 */
class FakeAdapter implements AgentAdapter {
  readonly id: string;
  readonly displayName: string;

  /** 该 agent 的固定配置路径 */
  private readonly path: string;
  /** detect 返回的安装状态 */
  private readonly installed: boolean;
  /** render 是否抛错（模拟既有文件无法解析）及其错误消息 */
  private readonly renderError?: string;
  /** render 被调用的次数（用于断言「密钥解析失败时不进入 render」） */
  renderCalls = 0;

  constructor(opts: {
    id: string;
    installed?: boolean;
    path?: string;
    renderError?: string;
  }) {
    this.id = opts.id;
    this.displayName = opts.id;
    this.installed = opts.installed ?? true;
    this.path = opts.path ?? `/fake/${opts.id}/config.json`;
    this.renderError = opts.renderError;
  }

  async detect(_platform: PlatformContext): Promise<DetectResult> {
    return {
      installed: this.installed,
      configPath: this.path,
      fileExists: this.installed,
    };
  }

  configPath(_platform: PlatformContext): string {
    return this.path;
  }

  render(config: ProviderConfig, _apiKey: string, _existing: string | null): RenderResult {
    this.renderCalls += 1;
    if (this.renderError) {
      // 模拟既有文件格式损坏 / 无法解析：render 抛错（发生在写盘前）
      throw new Error(this.renderError);
    }
    // 可预测的合并内容（不含明文密钥；本测试不校验凭据写法，仅校验编排行为）
    const merged = JSON.stringify({ agent: this.id, models: config.models });
    return { mergedContent: merged, maskedDiff: `diff(${this.id})` };
  }

  /**
   * 复刻 BaseAdapter.apply 的核心语义（备份 → 原子写 → 失败回滚），但不触碰真实 fs：
   * - 成功：返回 success 并带 backupPath；
   * - atomicWrite 抛错：有备份则 restore 回滚、无备份则视为删除回滚，返回 failed。
   */
  async apply(
    configPath: string,
    renderResult: RenderResult,
    writer: AtomicFileWriter,
  ): Promise<ApplyEntry> {
    const backupPath = await writer.backup(configPath);
    try {
      await writer.atomicWrite(configPath, renderResult.mergedContent);
      return {
        agentId: this.id,
        status: "success",
        backupPath: backupPath ?? undefined,
      };
    } catch (error) {
      // 写入失败：回滚该 agent 的局部改动（有备份则从备份恢复）
      if (backupPath !== null) {
        await writer.restore(backupPath, configPath);
      }
      return {
        agentId: this.id,
        status: "failed",
        message: error instanceof Error ? error.message : String(error),
      };
    }
  }
}

// ===========================================================================
// 公共夹具：固定平台上下文、基础 Provider 配置、内存既有内容读取
// ===========================================================================

/** 固定平台上下文（linux），仅用于驱动 detect/configPath，不参与真实路径解析 */
const platform: PlatformContext = {
  os: "linux",
  homeDir: "/home/u",
  env: { XDG_CONFIG_HOME: "/home/u/.config" },
};

/** 构造一个需要鉴权的基础 Provider 配置（apiKeyRef 非空、非本地） */
function makeConfig(overrides: Partial<ProviderConfig> = {}): ProviderConfig {
  return {
    id: "p1",
    name: "openai",
    baseUrl: "https://api.openai.com",
    apiKeyRef: "secret://p1",
    models: ["gpt-4o-mini"],
    ...overrides,
  };
}

/**
 * 构造一个固定返回预置内容的 readExisting 替身（内存既有内容，不碰真实 fs）。
 * 默认对任意路径返回 null（文件不存在）。
 */
function makeReadExisting(
  contentByPath: Record<string, string | null> = {},
): ReadExistingFile {
  return async (absolutePath: string): Promise<string | null> => {
    return absolutePath in contentByPath ? contentByPath[absolutePath] : null;
  };
}

/** 组装 Distributor 依赖，缺省项用安全的内存替身填充 */
function makeDeps(partial: Partial<DistributorDeps>): DistributorDeps {
  return {
    registry: partial.registry ?? new FakeRegistry(),
    secretStore: partial.secretStore ?? new InMemorySecretStore(),
    fileWriter: partial.fileWriter ?? new FakeWriter(),
    platform: partial.platform ?? platform,
    readExisting: partial.readExisting ?? makeReadExisting(),
    renderDeps: partial.renderDeps,
  };
}

/** 预置了密钥的内存 SecretStore（保证需要鉴权场景能解析出明文） */
async function makeStoreWithSecret(
  keyRef: string,
  apiKey: string,
): Promise<SecretStore> {
  const store = new InMemorySecretStore();
  await store.saveSecret(keyRef, apiKey);
  return store;
}

// ===========================================================================
// 场景 1：未安装 → skipped，不写任何文件（需求 8.5）
// ===========================================================================

describe("Distributor 故障隔离 - 未安装 → skipped（需求 8.5）", () => {
  it("未安装的 agent 标记为 skipped、记录原因，且绝不触发任何写入", async () => {
    const adapter = new FakeAdapter({ id: "opencode", installed: false });
    const writer = new FakeWriter();
    const store = await makeStoreWithSecret("secret://p1", "sk-live-xxxxxxxx");

    const distributor = new DefaultDistributor(
      makeDeps({
        registry: new FakeRegistry([adapter]),
        secretStore: store,
        fileWriter: writer,
      }),
    );

    const report = await distributor.distribute(makeConfig(), ["opencode"]);

    // 恰一条 entry，状态为 skipped 并带原因说明
    expect(report.entries).toHaveLength(1);
    expect(report.entries[0]).toMatchObject({ agentId: "opencode", status: "skipped" });
    expect(report.entries[0].message).toContain("未安装");
    // summary 计数正确
    expect(report.summary).toEqual({ success: 0, failed: 0, skipped: 1 });

    // 未安装不应进入 render，也不应触发任何备份/写入
    expect(adapter.renderCalls).toBe(0);
    expect(writer.backupCalls).toHaveLength(0);
    expect(writer.writeCalls).toHaveLength(0);
  });
});

// ===========================================================================
// 场景 2：部分失败隔离——成功者保留、失败者回滚，互不影响（需求 11.4 / 11.5）
// ===========================================================================

describe("Distributor 故障隔离 - 部分失败隔离（需求 11.4 / 11.5）", () => {
  it("一个 agent 写入失败并回滚，不影响其它成功 agent 的正常写入", async () => {
    // ok：写入成功；bad：atomicWrite 失败（命中 failWriteFor）
    const okAdapter = new FakeAdapter({ id: "ok", path: "/fake/ok/config.json" });
    const badAdapter = new FakeAdapter({ id: "bad", path: "/fake/bad/config.json" });
    // 只让 bad 的目标路径写入失败；backup 返回假备份路径以便触发 restore 回滚
    const writer = new FakeWriter({
      backupReturns: undefined, // 使用默认假备份路径（表示原文件存在）
      failWriteFor: new Set(["/fake/bad/config.json"]),
    });
    const store = await makeStoreWithSecret("secret://p1", "sk-live-abcdefgh1234");

    const distributor = new DefaultDistributor(
      makeDeps({
        registry: new FakeRegistry([okAdapter, badAdapter]),
        secretStore: store,
        fileWriter: writer,
      }),
    );

    const report = await distributor.distribute(makeConfig(), ["ok", "bad"]);

    // 两条 entry，一一对应且顺序与请求一致
    expect(report.entries.map((e) => e.agentId)).toEqual(["ok", "bad"]);
    // ok 成功、bad 失败——失败被隔离，未波及 ok
    expect(report.entries[0]).toMatchObject({ agentId: "ok", status: "success" });
    expect(report.entries[1]).toMatchObject({ agentId: "bad", status: "failed" });
    expect(report.summary).toEqual({ success: 1, failed: 1, skipped: 0 });

    // ok 的内容确实被写入（成功者保留）
    expect(writer.writeCalls).toEqual([
      { target: "/fake/ok/config.json", content: JSON.stringify({ agent: "ok", models: ["gpt-4o-mini"] }) },
    ]);
    // bad 触发了回滚（restore 被调用、目标为 bad 的配置路径）
    expect(writer.restoreCalls).toEqual([
      { backup: "/fake/bad/config.json.bak.TEST", target: "/fake/bad/config.json" },
    ]);
  });
});

// ===========================================================================
// 场景 3：密钥解析失败前置校验——写盘前判 failed，不写文件（需求 10.5）
// ===========================================================================

describe("Distributor 故障隔离 - 密钥解析失败前置校验（需求 10.5）", () => {
  it("SecretStore 无法解析 apiKeyRef（不存在）时，写盘前即 failed，且不 render、不写盘", async () => {
    const adapter = new FakeAdapter({ id: "opencode" });
    const writer = new FakeWriter();
    // 空的内存 store：secret://p1 不存在，resolveSecret 抛 not_found
    const store = new InMemorySecretStore();

    const distributor = new DefaultDistributor(
      makeDeps({
        registry: new FakeRegistry([adapter]),
        secretStore: store,
        fileWriter: writer,
      }),
    );

    const report = await distributor.distribute(makeConfig(), ["opencode"]);

    // 判为 failed，并给出「重新录入密钥」的可操作提示
    expect(report.entries).toHaveLength(1);
    expect(report.entries[0]).toMatchObject({ agentId: "opencode", status: "failed" });
    expect(report.entries[0].message).toContain("API Key");
    expect(report.entries[0].message).toContain("重新录入");
    expect(report.summary).toEqual({ success: 0, failed: 1, skipped: 0 });

    // 关键：密钥解析失败发生在写盘前——不进入 render，也不触发任何备份/写入
    expect(adapter.renderCalls).toBe(0);
    expect(writer.backupCalls).toHaveLength(0);
    expect(writer.writeCalls).toHaveLength(0);
  });

  it("SecretStore 读取后端失败（storage_failure）时，同样前置 failed、不写盘", async () => {
    const adapter = new FakeAdapter({ id: "opencode" });
    const writer = new FakeWriter();
    // 注入一个 resolveSecret 抛 storage_failure 的 SecretStore 替身
    const store: SecretStore = {
      async saveSecret(): Promise<void> {},
      async resolveSecret(keyRef: string): Promise<string> {
        throw new SecretStoreError("storage_failure", keyRef, "模拟读取后端失败");
      },
      async deleteSecret(): Promise<void> {},
      async getMasked(): Promise<string> {
        return "****";
      },
    };

    const distributor = new DefaultDistributor(
      makeDeps({
        registry: new FakeRegistry([adapter]),
        secretStore: store,
        fileWriter: writer,
      }),
    );

    const report = await distributor.distribute(makeConfig(), ["opencode"]);

    expect(report.entries[0]).toMatchObject({ agentId: "opencode", status: "failed" });
    expect(report.entries[0].message).toContain("读取凭据存储失败");
    // 读取失败同样不进入写盘
    expect(adapter.renderCalls).toBe(0);
    expect(writer.writeCalls).toHaveLength(0);
  });

  it("本地/无鉴权 provider（isLocal=true）不要求密钥，空 store 也能正常写入", async () => {
    const adapter = new FakeAdapter({ id: "ollama" });
    const writer = new FakeWriter();
    // 空 store：若错误地去解析密钥会抛错；isLocal 应跳过解析
    const store = new InMemorySecretStore();

    const distributor = new DefaultDistributor(
      makeDeps({
        registry: new FakeRegistry([adapter]),
        secretStore: store,
        fileWriter: writer,
      }),
    );

    const report = await distributor.distribute(
      makeConfig({ isLocal: true, apiKeyRef: "" }),
      ["ollama"],
    );

    // 无鉴权本地场景：不因密钥缺失失败，正常写入成功
    expect(report.entries[0]).toMatchObject({ agentId: "ollama", status: "success" });
    expect(adapter.renderCalls).toBe(1);
    expect(writer.writeCalls).toHaveLength(1);
  });
});

// ===========================================================================
// 场景 4：既有文件损坏 → failed，不覆盖原文件（需求 10.4）
// ===========================================================================

describe("Distributor 故障隔离 - 既有文件损坏 → failed（需求 10.4）", () => {
  it("render 解析既有内容抛错时该 agent failed，且绝不写盘（不覆盖原文件）", async () => {
    // 既有文件存在但内容损坏：readExisting 返回非法内容，render 对其抛错
    const adapter = new FakeAdapter({
      id: "opencode",
      path: "/fake/opencode/config.json",
      renderError: "既有配置解析失败：非法 JSON",
    });
    const writer = new FakeWriter();
    const store = await makeStoreWithSecret("secret://p1", "sk-live-zzzzzzzz9999");
    // 既有内容为损坏文本（模拟磁盘上已有一份坏文件）
    const readExisting = makeReadExisting({
      "/fake/opencode/config.json": "{ this is : not json",
    });

    const distributor = new DefaultDistributor(
      makeDeps({
        registry: new FakeRegistry([adapter]),
        secretStore: store,
        fileWriter: writer,
        readExisting,
      }),
    );

    const report = await distributor.distribute(makeConfig(), ["opencode"]);

    // failed，且消息体现「不覆盖原文件」
    expect(report.entries[0]).toMatchObject({ agentId: "opencode", status: "failed" });
    expect(report.entries[0].message).toContain("不覆盖原文件");
    expect(report.summary).toEqual({ success: 0, failed: 1, skipped: 0 });

    // render 失败发生在写盘前：render 被调用过一次，但绝无备份/写入（原文件不被覆盖）
    expect(adapter.renderCalls).toBe(1);
    expect(writer.backupCalls).toHaveLength(0);
    expect(writer.writeCalls).toHaveLength(0);
    expect(writer.restoreCalls).toHaveLength(0);
  });
});

// ===========================================================================
// 场景 5：凭据引用目标写入失败 → failed 并回滚（需求 11.5）
// ===========================================================================

describe("Distributor 故障隔离 - 凭据引用目标写入失败 → failed 并回滚（需求 11.5）", () => {
  it("写入阶段失败时该 agent failed，并从备份回滚，不留写入痕迹", async () => {
    const adapter = new FakeAdapter({ id: "opencode", path: "/fake/opencode/config.json" });
    // 让该目标路径的 atomicWrite 必然失败；backup 返回假备份路径（表示原文件存在）
    const writer = new FakeWriter({
      failWriteFor: new Set(["/fake/opencode/config.json"]),
    });
    const store = await makeStoreWithSecret("secret://p1", "sk-live-rrrrrrrr7777");

    const distributor = new DefaultDistributor(
      makeDeps({
        registry: new FakeRegistry([adapter]),
        secretStore: store,
        fileWriter: writer,
      }),
    );

    const report = await distributor.distribute(makeConfig(), ["opencode"]);

    // failed
    expect(report.entries[0]).toMatchObject({ agentId: "opencode", status: "failed" });
    expect(report.summary).toEqual({ success: 0, failed: 1, skipped: 0 });

    // 先备份 → 写入失败 → 回滚（restore）被触发，目标为该 agent 的配置路径
    expect(writer.backupCalls).toEqual(["/fake/opencode/config.json"]);
    expect(writer.restoreCalls).toEqual([
      { backup: "/fake/opencode/config.json.bak.TEST", target: "/fake/opencode/config.json" },
    ]);
    // 写入未成功落盘（writeCalls 不含该目标）
    expect(writer.writeCalls).toHaveLength(0);
  });

  it("写入失败的 agent 不影响同批次其它 agent（隔离性再验证）", async () => {
    const ok = new FakeAdapter({ id: "ok", path: "/fake/ok/config.json" });
    const bad = new FakeAdapter({ id: "bad", path: "/fake/bad/config.json" });
    const writer = new FakeWriter({ failWriteFor: new Set(["/fake/bad/config.json"]) });
    const store = await makeStoreWithSecret("secret://p1", "sk-live-pppppppp5555");

    const distributor = new DefaultDistributor(
      makeDeps({
        registry: new FakeRegistry([bad, ok]), // 故意把失败者排在前面
        secretStore: store,
        fileWriter: writer,
      }),
    );

    const report = await distributor.distribute(makeConfig(), ["bad", "ok"]);

    // 失败者在前也不阻断后续成功者
    expect(report.entries.map((e) => `${e.agentId}:${e.status}`)).toEqual([
      "bad:failed",
      "ok:success",
    ]);
    expect(report.summary).toEqual({ success: 1, failed: 1, skipped: 0 });
    // ok 正常写入
    expect(writer.writeCalls).toEqual([
      { target: "/fake/ok/config.json", content: JSON.stringify({ agent: "ok", models: ["gpt-4o-mini"] }) },
    ]);
  });
});

// ===========================================================================
// 报告完备性：entries 恰覆盖每个请求 agentId 一次，summary 之和等于 entries 长度
// ===========================================================================

describe("Distributor 故障隔离 - 报告完备性（需求 11.1）", () => {
  it("混合场景下 entries 一一覆盖且 summary 计数之和等于 entries 长度", async () => {
    const installed = new FakeAdapter({ id: "a", path: "/fake/a/config.json" });
    const notInstalled = new FakeAdapter({ id: "b", installed: false });
    const willFail = new FakeAdapter({ id: "c", path: "/fake/c/config.json" });
    const writer = new FakeWriter({ failWriteFor: new Set(["/fake/c/config.json"]) });
    const store = await makeStoreWithSecret("secret://p1", "sk-live-mmmmmmmm3333");

    const distributor = new DefaultDistributor(
      makeDeps({
        registry: new FakeRegistry([installed, notInstalled, willFail]),
        secretStore: store,
        fileWriter: writer,
      }),
    );

    // 含一个未注册的 agent "missing"，应被计为 failed（未找到适配器）
    const report = await distributor.distribute(makeConfig(), ["a", "b", "c", "missing"]);

    // entries 恰覆盖请求中每个 agentId 一次，顺序一致
    expect(report.entries.map((e) => e.agentId)).toEqual(["a", "b", "c", "missing"]);
    // a 成功 / b 跳过 / c 失败 / missing 失败
    const byId = Object.fromEntries(report.entries.map((e) => [e.agentId, e.status]));
    expect(byId).toEqual({ a: "success", b: "skipped", c: "failed", missing: "failed" });
    // summary 三类计数之和等于 entries 长度
    const { success, failed, skipped } = report.summary;
    expect(success + failed + skipped).toBe(report.entries.length);
    expect(report.summary).toEqual({ success: 1, failed: 2, skipped: 1 });
  });
});
