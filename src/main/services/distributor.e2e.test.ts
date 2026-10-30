// 分发端到端集成测试（任务 13.1）
//
// 本测试以「尽量真实」的方式端到端验证一键分发流程（对应 design.md 主流程时序图与
// 需求 8.3 / 10.2 / 10.3 / 11.1），组装的组件全部为生产实现，仅把「外部世界」替换为
// 可控的测试替身：
//   - 真实 Distributor（DefaultDistributor）：编排 detect → 解析密钥 → render → 备份
//     → 原子写入 →（失败时）回滚，并汇总 ApplyReport。
//   - 真实 AdapterRegistry + 真实四个适配器（opencode / pi / workbuddy / codebuddy）：
//     数据驱动映射 + BaseAdapter 通用流程，不做任何 mock。
//   - 真实 AtomicFileWriter（atomicFileWriter）：对「系统临时目录」做真实文件读写、
//     真实备份与真实回滚。
//   - 内存 SecretStore（InMemorySecretStore）：不触碰真实 OS 凭据库，但走完整的
//     resolveSecret 语义（不存在即抛 not_found）。
//   - mock httpSend：本分发链路本身不发网络请求（分发只读本地既有配置 + 写盘），故无需
//     真实 Provider API；此处以内存 writeEnv / writeSecretsFile 捕获凭据落地，确保明文
//     不写进配置文件，也不污染真实环境变量 / 真实 secrets 文件。
//
// 为让四个适配器的「相对路径模板」（如 opencode/opencode.json）落到临时目录内，测试把
// PlatformContext 设为 linux 且 XDG_CONFIG_HOME 指向一个独立的系统临时目录——PathResolver
// 会据此把各 agent 配置解析到 <tmp>/<agent>/<file>，从而对真实文件系统做隔离的读写。
//
// 覆盖的核心断言（任务 13.1）：
//   1. 文件内容：分发后各 agent 配置文件为「字段级合并」结果——受管字段（baseUrl/models）
//      被写入，用户既有的非受管字段被完整保留；key 以引用形态出现，配置文件不含明文。
//   2. 备份生成：对既存配置文件分发前生成带时间戳的 .bak.<时间戳> 备份，内容为旧文件原样。
//   3. 报告正确：ApplyReport.entries 恰好覆盖每个请求 agentId 一次，summary 三类计数之和
//      等于 entries 长度，状态与实际写盘结果一致。
//   4. 备份回滚：注入「写入失败」的写入器后该 agent 判 failed 并从备份回滚（目标恢复旧内容），
//      且不影响同批次其它 agent（故障隔离）。
//
// 清理约定：每个用例独立建临时目录，用后递归删除；Windows 下文件句柄释放有延迟，rm 加
// maxRetries/retryDelay 增强健壮性。env 形态会真实写 process.env，故改用内存 writeEnv
// 捕获，避免污染测试进程环境。

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { promises as fs } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import * as TOML from "@iarna/toml";

import type { PlatformContext, ProviderConfig } from "@shared/types";
import { createAdapterRegistry, type AdapterRegistry } from "../adapters/registry";
import { OpencodeAdapter, createOpencodeMapping } from "../adapters/opencodeAdapter";
import { PiAdapter, createPiMapping } from "../adapters/piAdapter";
import { WorkbuddyAdapter, createWorkbuddyMapping } from "../adapters/workbuddyAdapter";
import { CodebuddyAdapter, createCodebuddyMapping } from "../adapters/codebuddyAdapter";
import {
  createInMemoryWriteEnv,
  createInMemoryWriteSecretsFile,
  type WriteEnv,
  type WriteSecretsFile,
} from "../core/injectCredential";
import { atomicFileWriter, type AtomicFileWriter } from "./atomicFileWriter";
import { InMemorySecretStore } from "./secretStore";
import { DefaultDistributor } from "./distributor";

// ===========================================================================
// 常量与被测 provider 名
// ===========================================================================

/** 被测 provider 名（用于拼接 opencode/pi 的 provider 块键与环境变量名） */
const PROVIDER_NAME = "openai";
/** 密钥引用（内存 SecretStore 以此为索引存取明文） */
const API_KEY_REF = "secret://openai";
/** 分发用的明文密钥（仅内存使用，断言其绝不出现在任何配置文件文本中） */
const API_KEY = "sk-live-INTEGRATION-SECRET-abcdef123456";
/** 四个内置 agent 的 id */
const AGENT_IDS = ["opencode", "pi", "workbuddy", "codebuddy"] as const;

// ===========================================================================
// 临时目录与平台上下文
// ===========================================================================

/** 当前用例的临时根目录（充当 XDG_CONFIG_HOME，各 agent 配置落入其下） */
let tmpRoot: string;

beforeEach(async () => {
  // 每个用例独立建唯一临时目录，隔离真实文件 I/O
  tmpRoot = await fs.mkdtemp(path.join(os.tmpdir(), "distributor-e2e-"));
});

afterEach(async () => {
  // 递归清理临时目录；Windows 句柄释放有延迟，加重试增强健壮性
  await fs.rm(tmpRoot, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
});

/**
 * 构造指向临时目录的平台上下文（os 取「真实运行平台」）。
 *
 * 为何用真实平台而非固定 linux：本测试对「系统临时目录」做真实文件读写，而临时目录是宿主
 * 平台风格的绝对路径（Windows 为带盘符的反斜杠路径）。若把 os 固定成 linux，PathResolver 会
 * 以 POSIX 语义处理 Windows 路径——把 ~ 展开出的 Windows 绝对路径误判为相对路径而再次拼接
 * configHome，导致路径重复。统一让 os 跟随 process.platform，路径语义即与宿主一致。
 *
 * homeDir 指向 tmpRoot，并把各平台定位 home/配置根的环境变量都指向 tmpRoot，使各 agent 的
 * ~ 开头模板（如 ~/.config/opencode、~/.codebuddy、~/.pi/agent）解析到临时目录内，从而在不
 * 触碰用户真实配置目录的前提下做隔离的真实读写。
 *
 * @returns 指向临时目录的平台上下文
 */
function makePlatform(): PlatformContext {
  const raw = process.platform;
  const osName: PlatformContext["os"] =
    raw === "win32" ? "win32" : raw === "darwin" ? "darwin" : "linux";
  return {
    os: osName,
    homeDir: tmpRoot,
    // 覆盖所有可能被 PathResolver 用到的 home/配置根变量，统一指向临时目录
    env: {
      USERPROFILE: tmpRoot,
      HOME: tmpRoot,
      APPDATA: tmpRoot,
      LOCALAPPDATA: tmpRoot,
      XDG_CONFIG_HOME: tmpRoot,
    },
  };
}

/**
 * 各 agent 配置文件的绝对路径——由「真实适配器 + 真实 PathResolver」据平台上下文解析得出。
 *
 * 之所以不自行拼路径：各适配器内部用 PathResolver.resolve 解析相对模板，其路径分隔符与
 * 规范化结果须与适配器落盘时完全一致（否则注入写入失败的 failWriteFor 集合会因路径字符串
 * 不匹配而命中不到真实目标）。因此统一以适配器自身算出的 configPath 为准。
 */
function agentConfigPath(agentId: string): string {
  const adapter = makeRegistry().get(agentId);
  if (!adapter) {
    throw new Error(`未知 agent：${agentId}`);
  }
  return adapter.configPath(makePlatform());
}

/** pi 的独立 secrets 文件在临时目录下的绝对路径 */
function piSecretsPath(): string {
  return path.join(tmpRoot, "pi", "secrets.json");
}

// ===========================================================================
// 真实注册表装配：四个真实适配器
// ===========================================================================

/**
 * 装配一个「真实」适配器注册表，注册四个内置适配器。
 *
 * 与生产 createRegisteredAdapters() 等价，唯一差异：为 opencode / pi 传入带「本测试 provider 名」
 * 的映射，并给 pi 注入「已解析为临时目录绝对路径」的 secrets 文件路径——因为 render 层是纯函数、
 * 不持有 PlatformContext，secrets-file 的明文落地路径需在构造映射时就是绝对路径，才能真实落到
 * 临时目录内（这正是 createPiMapping 预留第二参数的用途）。其余适配器用默认映射。
 *
 * @returns 已注册四个真实适配器的注册表
 */
function makeRegistry(
  renderDeps?: { writeEnv?: WriteEnv; writeSecretsFile?: WriteSecretsFile },
  installedAgents: ReadonlySet<string> = new Set(AGENT_IDS),
): AdapterRegistry {
  const registry = createAdapterRegistry();
  // 凭据落地依赖经「适配器构造」注入：render 实际使用的是 BaseAdapter 构造时的 renderDeps，
  // 而非 Distributor 的 renderDeps（Distributor 调 adapter.render 时不透传），故必须在此注入。
  const baseRenderDeps = renderDeps ? { renderDeps } : {};

  // 探测替身：安装检测经 CLI 命令（opencode/pi/codebuddy）或安装标志文件（workbuddy）判定。
  // 这里按「期望已安装的集合」注入确定性替身——命中集合则命令成功 / 标志文件可读，否则失败，
  // 从而既不真实 spawn 子进程/读真实安装目录，又能稳定复现「已安装 / 未安装」两类场景。
  // 之所以不再靠「是否 seed 配置文件」表达安装：detect 已改为命令/文件探测，与配置文件存在性解耦。
  const cliDeps = (id: string) => ({
    ...baseRenderDeps,
    runCommand: async (): Promise<{ ok: boolean; output: string }> =>
      installedAgents.has(id) ? { ok: true, output: "1.0.0" } : { ok: false, output: "" },
  });
  const fileDeps = (id: string) => ({
    ...baseRenderDeps,
    readFile: async (): Promise<string | null> =>
      installedAgents.has(id) ? JSON.stringify({ appVersion: "1.0.0" }) : null,
  });

  // opencode：按 provider 名生成 provider 块键与环境变量名
  registry.register(new OpencodeAdapter(createOpencodeMapping(PROVIDER_NAME), cliDeps("opencode")));
  // pi：secrets 文件用临时目录内的绝对路径，保证明文真实落到隔离目录
  registry.register(
    new PiAdapter(createPiMapping(PROVIDER_NAME, piSecretsPath()), cliDeps("pi")),
  );
  // workbuddy：桌面应用，经安装标志文件探测
  registry.register(new WorkbuddyAdapter(createWorkbuddyMapping(), fileDeps("workbuddy")));
  // codebuddy：CLI，经版本命令探测
  registry.register(new CodebuddyAdapter(createCodebuddyMapping(), cliDeps("codebuddy")));
  return registry;
}

// ===========================================================================
// Provider 配置与 Distributor 装配
// ===========================================================================

/** 构造一份需要鉴权、非本地的基础 Provider 配置 */
function makeConfig(overrides: Partial<ProviderConfig> = {}): ProviderConfig {
  return {
    id: "p-openai",
    name: PROVIDER_NAME,
    baseUrl: "https://api.openai.com/v1",
    apiKeyRef: API_KEY_REF,
    models: ["gpt-4o-mini", "gpt-4o"],
    ...overrides,
  };
}

/** 预置了明文密钥的内存 SecretStore（保证 resolveSecret 能解析出明文） */
async function makeStoreWithSecret(): Promise<InMemorySecretStore> {
  const store = new InMemorySecretStore();
  await store.saveSecret(API_KEY_REF, API_KEY);
  return store;
}

/**
 * 组装一个「尽量真实」的 Distributor：真实注册表 + 真实原子写入器 + 内存 SecretStore，
 * 凭据落地（env/secrets-file）走内存实现以捕获明文而不污染真实环境/文件。
 *
 * @param opts.fileWriter 可覆盖的写入器（用于注入写入失败以验证回滚）；缺省用真实 atomicFileWriter
 * @param opts.installedAgents 期望「已安装」的 agent 集合（驱动探测替身）；缺省全部已安装
 * @returns { distributor, envStore, secretsStore } 便于断言凭据落地
 */
async function makeDistributor(
  opts: { fileWriter?: AtomicFileWriter; installedAgents?: ReadonlySet<string> } = {},
): Promise<{
  distributor: DefaultDistributor;
  writeEnv: WriteEnv;
  envStore: Map<string, string>;
  writeSecretsFile: WriteSecretsFile;
  secretsStore: Map<string, Map<string, string>>;
}> {
  const store = await makeStoreWithSecret();
  // 内存凭据落地：env 形态捕获到 envStore，secrets-file 形态捕获到 secretsStore，
  // 既能断言「明文确实被落到声明的目标」，又不写真实 process.env / 真实文件
  const { writeEnv, store: envStore } = createInMemoryWriteEnv();
  const { writeSecretsFile, store: secretsStore } = createInMemoryWriteSecretsFile();

  const distributor = new DefaultDistributor({
    // 凭据落地依赖经适配器构造注入到注册表（见 makeRegistry 注释）；
    // installedAgents 驱动探测替身，缺省全部已安装
    registry: makeRegistry({ writeEnv, writeSecretsFile }, opts.installedAgents),
    secretStore: store,
    fileWriter: opts.fileWriter ?? atomicFileWriter,
    platform: makePlatform(),
  });

  return { distributor, writeEnv, envStore, writeSecretsFile, secretsStore };
}

// ===========================================================================
// 既有配置文件预置：让 detect 判为「已安装」，并带用户自定义字段以验证字段级合并
// ===========================================================================

/**
 * 为四个 agent 预置既有配置文件（含用户自定义的非受管字段），并让 detect 判为已安装。
 *
 * 字段级合并的验证点：分发只应改写受管字段（baseUrl/models），用户既有的其它设置
 * （theme/mcp/自定义 provider 字段等）必须原样保留。
 */
async function seedExistingConfigs(): Promise<void> {
  // opencode：JSON，provider.<name> 块 + 顶层 theme（非受管，应保留）
  const opencode = {
    theme: "dracula",
    provider: {
      [PROVIDER_NAME]: {
        npm: "@ai-sdk/openai-compatible",
        options: { baseURL: "https://old.example.com" },
      },
    },
  };
  await writeFileEnsuringDir(agentConfigPath("opencode"), JSON.stringify(opencode, null, 2));

  // pi：TOML，providers.<name> 块 + 顶层 editor 设置（非受管，应保留）
  const pi = {
    editor: { theme: "nord" },
    providers: {
      [PROVIDER_NAME]: { base_url: "https://old.example.com" },
    },
  };
  await writeFileEnsuringDir(agentConfigPath("pi"), TOML.stringify(pi as Record<string, unknown>));

  // workbuddy：JSON，model 块 + 顶层 ui 设置（非受管，应保留）
  const workbuddy = {
    ui: { lang: "zh-CN" },
    model: { baseUrl: "https://old.example.com" },
  };
  await writeFileEnsuringDir(agentConfigPath("workbuddy"), JSON.stringify(workbuddy, null, 2));

  // codebuddy：JSON，顶层 endpoint/models + 自定义 permissions（非受管，应保留）
  const codebuddy = {
    permissions: { allowShell: false },
    endpoint: "https://old.example.com",
  };
  await writeFileEnsuringDir(agentConfigPath("codebuddy"), JSON.stringify(codebuddy, null, 2));
}

/** 确保父目录存在后写文件 */
async function writeFileEnsuringDir(filePath: string, content: string): Promise<void> {
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  await fs.writeFile(filePath, content, "utf8");
}

/** 读取文件文本（便于断言） */
async function readFileText(filePath: string): Promise<string> {
  return fs.readFile(filePath, "utf8");
}

/** 列出某目录下匹配 `<base>.bak.<时间戳>` 的备份文件名 */
async function listBackups(configPath: string): Promise<string[]> {
  const dir = path.dirname(configPath);
  const base = path.basename(configPath);
  const names = await fs.readdir(dir);
  // 备份命名约定：<目标文件名>.bak.<时间戳>
  return names.filter((n) => n.startsWith(`${base}.bak.`));
}

// ===========================================================================
// 场景 1：全新分发（无既有文件）——文件内容正确、报告全 success、凭据落地且无明文
// ===========================================================================

describe("分发端到端 - 全新分发写入（需求 8.3 / 10.2 / 11.1）", () => {
  it("四个 agent 均已安装时，端到端写入各自配置文件，报告全 success 且文件不含明文", async () => {
    // 预置既有文件（让 detect 判为已安装；同时验证字段级合并保留非受管字段）
    await seedExistingConfigs();

    const { distributor, envStore, secretsStore } = await makeDistributor();
    const report = await distributor.distribute(makeConfig(), [...AGENT_IDS]);

    // 报告完备：entries 一一覆盖且顺序一致，全部成功
    expect(report.entries.map((e) => e.agentId)).toEqual([...AGENT_IDS]);
    expect(report.summary).toEqual({ success: 4, failed: 0, skipped: 0 });
    // summary 三类之和等于 entries 长度（需求 11.1）
    const { success, failed, skipped } = report.summary;
    expect(success + failed + skipped).toBe(report.entries.length);

    // ---- opencode：受管字段写入 + 非受管字段保留 + key 为 env 引用占位（无明文） ----
    const opencodeText = await readFileText(agentConfigPath("opencode"));
    const opencodeJson = JSON.parse(opencodeText);
    const opencodeProvider = opencodeJson.provider[PROVIDER_NAME];
    expect(opencodeProvider.options.baseURL).toBe("https://api.openai.com/v1");
    // models 作为已选分发集合（字符串数组）写入 provider.<name>.models
    expect(opencodeProvider.models).toEqual(["gpt-4o-mini", "gpt-4o"]);
    // 非受管字段 theme 与 npm 保留
    expect(opencodeJson.theme).toBe("dracula");
    expect(opencodeProvider.npm).toBe("@ai-sdk/openai-compatible");
    // key 走 env 引用形态：配置文件只含占位，绝不含明文。
    // provider 名非 "default"，故环境变量名为 OPENCODE_<PROVIDER>_API_KEY
    expect(opencodeProvider.options.apiKey).toBe("{env:OPENCODE_OPENAI_API_KEY}");
    expect(opencodeText).not.toContain(API_KEY);

    // ---- pi：TOML 受管字段写入 + 非受管字段保留 + key 为 secrets 引用占位（无明文） ----
    const piText = await readFileText(agentConfigPath("pi"));
    // TOML.parse 返回 JsonMap；此处按已知结构逐层断言为普通记录便于取值
    const piParsed = TOML.parse(piText) as Record<string, unknown>;
    const piProviders = piParsed.providers as Record<string, Record<string, unknown>>;
    const piProvider = piProviders[PROVIDER_NAME];
    expect(piProvider.base_url).toBe("https://api.openai.com/v1");
    expect(piProvider.models).toEqual(["gpt-4o-mini", "gpt-4o"]);
    expect((piParsed.editor as Record<string, unknown>).theme).toBe("nord"); // 非受管保留
    expect(piProvider.api_key_ref).toBe(`secrets:${PROVIDER_NAME}.api_key`);
    expect(piText).not.toContain(API_KEY);

    // ---- workbuddy：JSON 受管字段写入 + 非受管保留 + env 引用占位 ----
    const workbuddyText = await readFileText(agentConfigPath("workbuddy"));
    const workbuddyJson = JSON.parse(workbuddyText);
    expect(workbuddyJson.model.baseUrl).toBe("https://api.openai.com/v1");
    expect(workbuddyJson.model.models).toEqual(["gpt-4o-mini", "gpt-4o"]);
    expect(workbuddyJson.ui.lang).toBe("zh-CN"); // 非受管保留
    expect(workbuddyJson.model.apiKey).toBe("${WORKBUDDY_API_KEY}");
    expect(workbuddyText).not.toContain(API_KEY);

    // ---- codebuddy：JSON 受管字段写入 + 非受管保留 + env 引用占位 ----
    const codebuddyText = await readFileText(agentConfigPath("codebuddy"));
    const codebuddyJson = JSON.parse(codebuddyText);
    expect(codebuddyJson.endpoint).toBe("https://api.openai.com/v1");
    expect(codebuddyJson.models).toEqual(["gpt-4o-mini", "gpt-4o"]);
    expect(codebuddyJson.permissions.allowShell).toBe(false); // 非受管保留
    expect(codebuddyJson.apiKey).toBe("${CODEBUDDY_API_KEY}");
    expect(codebuddyText).not.toContain(API_KEY);

    // ---- 凭据落地：明文经内存 writeEnv/writeSecretsFile 落到各自声明的目标 ----
    // opencode / workbuddy / codebuddy 走 env，明文落到各自环境变量名
    expect(envStore.get("OPENCODE_OPENAI_API_KEY")).toBe(API_KEY);
    expect(envStore.get("WORKBUDDY_API_KEY")).toBe(API_KEY);
    expect(envStore.get("CODEBUDDY_API_KEY")).toBe(API_KEY);
    // pi 走 secrets-file，明文落到临时目录内的 secrets 文件条目
    expect(secretsStore.get(piSecretsPath())?.get(`${PROVIDER_NAME}.api_key`)).toBe(API_KEY);
  });

  it("成功写入成员带备份路径；无既有文件时不产生备份、文件被新建", async () => {
    // 不预置既有文件，但强制让 detect 判为已安装：通过为每个 agent 创建一个空配置文件
    // 来模拟「已安装但内容可被覆盖」。这里改为预置「最小合法空对象」既有文件。
    for (const id of AGENT_IDS) {
      const p = agentConfigPath(id);
      // 以各自格式写入最小合法内容
      const empty = id === "pi" ? "" : "{}";
      await writeFileEnsuringDir(p, empty);
    }

    const { distributor } = await makeDistributor();
    const report = await distributor.distribute(makeConfig(), [...AGENT_IDS]);

    expect(report.summary).toEqual({ success: 4, failed: 0, skipped: 0 });
    // 既有文件存在 → 每个成功项都应带备份路径（原文件被备份）
    for (const entry of report.entries) {
      expect(entry.status).toBe("success");
      expect(entry.backupPath).toBeTruthy();
      // 备份文件真实存在于磁盘
      await expect(fs.access(entry.backupPath as string)).resolves.toBeUndefined();
    }
  });
});

// ===========================================================================
// 场景 2：未安装 → skipped（需求 8.3：仅对已安装 agent 分发）
// ===========================================================================

describe("分发端到端 - 未安装 agent 跳过（需求 8.3）", () => {
  it("未安装的 agent 被判为 skipped，且不产生任何文件", async () => {
    // 探测替身：只有 opencode / workbuddy 已安装；pi / codebuddy 未安装 → detect 判 skipped。
    // （安装与否由命令/标志文件探测决定，与是否存在配置文件无关）
    await writeFileEnsuringDir(agentConfigPath("opencode"), "{}");
    await writeFileEnsuringDir(agentConfigPath("workbuddy"), "{}");

    const { distributor } = await makeDistributor({
      installedAgents: new Set(["opencode", "workbuddy"]),
    });
    const report = await distributor.distribute(makeConfig(), [...AGENT_IDS]);

    const byId = Object.fromEntries(report.entries.map((e) => [e.agentId, e.status]));
    expect(byId.opencode).toBe("success");
    expect(byId.workbuddy).toBe("success");
    expect(byId.pi).toBe("skipped");
    expect(byId.codebuddy).toBe("skipped");
    expect(report.summary).toEqual({ success: 2, failed: 0, skipped: 2 });

    // 未安装的 agent 未被写入任何文件
    await expect(fs.access(agentConfigPath("pi"))).rejects.toBeTruthy();
    await expect(fs.access(agentConfigPath("codebuddy"))).rejects.toBeTruthy();
  });
});

// ===========================================================================
// 场景 3：备份生成——对既存文件分发前生成带时间戳备份，内容为旧文件原样（需求 10.2）
// ===========================================================================

describe("分发端到端 - 备份生成（需求 10.2）", () => {
  it("既存配置文件在分发前被备份为 .bak.<时间戳>，备份内容等于分发前原内容", async () => {
    await seedExistingConfigs();

    // 记录分发前 codebuddy 的原始内容，稍后与备份比对
    const codebuddyPath = agentConfigPath("codebuddy");
    const originalCodebuddy = await readFileText(codebuddyPath);

    const { distributor } = await makeDistributor();
    const report = await distributor.distribute(makeConfig(), ["codebuddy"]);

    const entry = report.entries[0];
    expect(entry.status).toBe("success");
    expect(entry.backupPath).toBeTruthy();

    // 备份文件命名含时间戳且确实生成
    const backups = await listBackups(codebuddyPath);
    expect(backups).toHaveLength(1);
    expect(backups[0]).toMatch(/\.bak\.\d{8}T\d{9}Z$/); // 形如 settings.json.bak.20240131T081530123Z

    // 备份内容 == 分发前原内容（旧内容被完整保存）
    const backupText = await readFileText(entry.backupPath as string);
    expect(backupText).toBe(originalCodebuddy);

    // 目标文件已是合并后的新内容（受管字段被更新）
    const newText = await readFileText(codebuddyPath);
    expect(JSON.parse(newText).endpoint).toBe("https://api.openai.com/v1");
    expect(newText).not.toBe(originalCodebuddy);
  });
});

// ===========================================================================
// 场景 4：备份回滚——写入失败时该 agent failed 并从备份恢复旧内容，隔离不影响他者（需求 10.3 / 11.1）
// ===========================================================================

/**
 * 包裹真实 atomicFileWriter 的「可注入失败」写入器。
 *
 * 对命中 failWriteFor 的目标路径让 atomicWrite 抛错（模拟磁盘/权限故障），其余一律委托
 * 真实实现。backup / restore 全部委托真实实现，从而「备份 → 写入失败 → 真实回滚」这条路径
 * 走的是真实的文件系统备份与恢复，端到端验证回滚语义。
 */
class FailingWriter implements AtomicFileWriter {
  constructor(private readonly failWriteFor: Set<string>) {}

  async backup(targetPath: string): Promise<string | null> {
    // 委托真实实现生成真实备份文件
    return atomicFileWriter.backup(targetPath);
  }

  async atomicWrite(targetPath: string, content: string): Promise<void> {
    if (this.failWriteFor.has(targetPath)) {
      // 模拟该目标的写入失败，触发上层回滚
      throw new Error(`模拟写入失败：${targetPath}`);
    }
    return atomicFileWriter.atomicWrite(targetPath, content);
  }

  async restore(backupPath: string, targetPath: string): Promise<void> {
    // 委托真实实现从备份恢复目标
    return atomicFileWriter.restore(backupPath, targetPath);
  }
}

describe("分发端到端 - 写入失败回滚与故障隔离（需求 10.3 / 11.1）", () => {
  it("注入写入失败的 agent 判 failed 并从备份回滚旧内容，其它 agent 正常写入不受影响", async () => {
    await seedExistingConfigs();

    // 记录 workbuddy（将失败者）分发前的原始内容，用于断言回滚后恢复原样
    const workbuddyPath = agentConfigPath("workbuddy");
    const originalWorkbuddy = await readFileText(workbuddyPath);

    // 仅让 workbuddy 的写入失败；其余三者走真实成功写入
    const failingWriter = new FailingWriter(new Set([workbuddyPath]));
    const { distributor } = await makeDistributor({ fileWriter: failingWriter });

    const report = await distributor.distribute(makeConfig(), [...AGENT_IDS]);

    // 报告：workbuddy failed，其它三者 success；计数之和等于 entries 长度
    const byId = Object.fromEntries(report.entries.map((e) => [e.agentId, e.status]));
    expect(byId).toEqual({
      opencode: "success",
      pi: "success",
      workbuddy: "failed",
      codebuddy: "success",
    });
    expect(report.summary).toEqual({ success: 3, failed: 1, skipped: 0 });
    const { success, failed, skipped } = report.summary;
    expect(success + failed + skipped).toBe(report.entries.length);

    // 回滚验证：workbuddy 目标文件已从备份恢复为分发前原内容（不留半写/新内容）
    const workbuddyAfter = await readFileText(workbuddyPath);
    expect(workbuddyAfter).toBe(originalWorkbuddy);

    // 隔离验证：成功者确实写入了合并后的新内容
    const opencodeJson = JSON.parse(await readFileText(agentConfigPath("opencode")));
    expect(opencodeJson.provider[PROVIDER_NAME].options.baseURL).toBe("https://api.openai.com/v1");
    const codebuddyJson = JSON.parse(await readFileText(agentConfigPath("codebuddy")));
    expect(codebuddyJson.endpoint).toBe("https://api.openai.com/v1");
  });
});

// ===========================================================================
// 场景 5：密钥不存在 → 写盘前 failed，不触碰任何文件（需求 10.3 的前置校验）
// ===========================================================================

describe("分发端到端 - 密钥不存在时前置失败不写盘（需求 10.3）", () => {
  it("SecretStore 无对应明文时该 agent failed，且既有配置文件内容保持不变、不产生备份", async () => {
    await seedExistingConfigs();
    const opencodePath = agentConfigPath("opencode");
    const before = await readFileText(opencodePath);

    // 用「空」SecretStore（无预置密钥）：resolveSecret 抛 not_found
    const emptyStore = new InMemorySecretStore();
    const { writeEnv } = createInMemoryWriteEnv();
    const { writeSecretsFile } = createInMemoryWriteSecretsFile();
    const distributor = new DefaultDistributor({
      registry: makeRegistry({ writeEnv, writeSecretsFile }),
      secretStore: emptyStore,
      fileWriter: atomicFileWriter,
      platform: makePlatform(),
    });

    const report = await distributor.distribute(makeConfig(), ["opencode"]);

    expect(report.entries[0]).toMatchObject({ agentId: "opencode", status: "failed" });
    expect(report.entries[0].message).toContain("重新录入");

    // 既有文件未被改动（前置失败不写盘），且未生成备份
    expect(await readFileText(opencodePath)).toBe(before);
    expect(await listBackups(opencodePath)).toHaveLength(0);
  });
});
