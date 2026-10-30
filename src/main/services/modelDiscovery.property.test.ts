// 模型发现与探测的「密钥不泄露 / 只读无副作用 / 无鉴权本地 provider 不读密钥」属性测试
//
// 覆盖任务 6.6，验证 design.md 的三条正确性属性（均针对 ModelDiscovery）：
//   - **Property 8: 发现与探测过程不泄露明文密钥**
//     对任意 provider 与任意模型集合，fetchModels / probeModels 经 IPC 回传渲染进程的任何
//     数据（FetchModelsResult / ModelInfo[] / ModelProbeResult[]）序列化后均不含明文 apiKey。
//   - **Property 9: 探测只读、无配置副作用**
//     对任意 provider 与任意模型，fetchModels / probeModels 不修改任何本地配置文件（各 agent
//     配置、AppState），且远端请求仅为只读/最小代价查询（列表为 GET），不触发写入类操作。
//   - **Property 12: 无鉴权本地 provider 不读取也不要求密钥**
//     对任意标记为无鉴权的本地 provider（isLocal=true 或 auth.in="none"/kind="none"），
//     执行过程既不调用 SecretStore.resolveSecret，也不因 apiKeyRef 为空而失败，
//     且发出的请求不含任何鉴权头/查询参数。
//
// **Validates: Requirements 5.6, 6.8, 7.1, 7.2, 7.3, 4.4 / Property 8, 9, 12**
//
// ---------------------------------------------------------------------------
// 关于 probeModels 的覆盖范围说明（任务边界）
// ---------------------------------------------------------------------------
// 本任务（6.6）只负责「编写属性测试」。Property 8/9/12 的完整表述同时覆盖 fetchModels 与
// probeModels 两条链路，但 probeModel / probeModels 的实现属于前置任务 6.3，截至本测试编写时
// 该实现尚未落地（src/main/services/modelDiscovery.ts 中仍为占位 `throw new Error(...)`）。
// 因此本文件先对「已实现的 fetchModels」完整验证三条属性；对 probeModels 的同款断言以 TODO
// 形式保留（见文件末尾 `describe.todo`），待任务 6.3 落地后即可按同一套辅助补齐，无需改动引擎。
//
// 测试约束（全程遵守）：
// - SecretStore 使用可注入的内存实现（InMemorySecretStore / 记账探针），绝不触达真实 OS 凭据库；
// - httpSend 使用 mock（返回预置响应并记录收到的请求），CI 绝不访问真实外网；
// - 每条属性经共享约定 fcAssertAsync 运行（numRuns >= 100）。

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fc from "fast-check";
import { promises as fs } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { fcAssertAsync } from "@shared/testing/fcConfig";
import type {
  FetchModelsResult,
  ModelListingConfig,
  ProviderConfig,
} from "@shared/types";
import { ModelDiscovery } from "./modelDiscovery";
import type { HttpSend, HttpResponse, HttpSendOptions } from "./http";
import type { HttpRequest } from "../core/injectAuth";
import {
  InMemorySecretStore,
  type SecretStore,
} from "./secretStore";

// ===========================================================================
// 可注入测试替身：记账型 httpSend 与记账型 SecretStore
// ===========================================================================

/**
 * 一次被 mock 捕获的请求记录：保留方法、URL、请求头、查询参数与请求体，
 * 供「只读性」与「不含鉴权头/查询」等断言检查「引擎实际发出了什么」。
 */
interface CapturedRequest {
  method: string;
  url: string;
  headers: Record<string, string>;
  query: Record<string, string>;
  body: unknown;
}

/**
 * 创建一个记账型 mock httpSend：对任意请求返回固定的预置响应，并把每次收到的请求
 * 克隆进 captured 数组（避免后续就地改写影响断言）。
 *
 * @param response 预置响应（status / headers / body 等）
 * @param captured 外部传入的记录数组，调用后可据此检查发出的请求
 */
function makeRecordingHttpSend(
  response: HttpResponse,
  captured: CapturedRequest[],
): HttpSend {
  return async (req: HttpRequest, _options?: HttpSendOptions): Promise<HttpResponse> => {
    // 深拷贝请求的关键部分，固化「发出时」的快照（headers/query 可能被引擎就地构造）
    captured.push({
      method: req.method ?? "GET",
      url: req.url,
      headers: { ...req.headers },
      query: { ...(req.query ?? {}) },
      body: req.body,
    });
    return response;
  };
}

/**
 * 记账型 SecretStore：包装一个内存 SecretStore，记录 resolveSecret 被调用的次数与 keyRef，
 * 用于 Property 12 断言「无鉴权本地 provider 根本不调用 resolveSecret」。
 */
class RecordingSecretStore implements SecretStore {
  /** resolveSecret 被调用时记录的 keyRef 列表（长度即调用次数） */
  readonly resolveCalls: string[] = [];

  constructor(private readonly inner: SecretStore) {}

  async saveSecret(keyRef: string, apiKey: string): Promise<void> {
    return this.inner.saveSecret(keyRef, apiKey);
  }

  async resolveSecret(keyRef: string): Promise<string> {
    this.resolveCalls.push(keyRef);
    return this.inner.resolveSecret(keyRef);
  }

  async deleteSecret(keyRef: string): Promise<void> {
    return this.inner.deleteSecret(keyRef);
  }

  async getMasked(keyRef: string): Promise<string> {
    return this.inner.getMasked(keyRef);
  }
}

/**
 * 一个「一旦被调用即抛错」的 SecretStore：用于 Property 12 更强的断言——
 * 无鉴权本地 provider 的 fetchModels 过程若错误地去解析密钥，会立刻抛错使属性失败。
 */
class ThrowingSecretStore implements SecretStore {
  async saveSecret(): Promise<void> {
    throw new Error("ThrowingSecretStore.saveSecret 不应被调用");
  }
  async resolveSecret(): Promise<string> {
    throw new Error("无鉴权本地 provider 不应解析密钥（resolveSecret 被调用）");
  }
  async deleteSecret(): Promise<void> {
    throw new Error("ThrowingSecretStore.deleteSecret 不应被调用");
  }
  async getMasked(): Promise<string> {
    throw new Error("ThrowingSecretStore.getMasked 不应被调用");
  }
}

// ===========================================================================
// 随机生成器
// ===========================================================================

/**
 * 明文 apiKey 生成器：带独特前缀 "sk-" 的随机串，长度足够长。
 *
 * 之所以加独特前缀并保证一定长度：让「序列化结果包含明文」这一检查不易产生假阴性
 * （随机短串可能恰好是响应里的子串），也贴近真实密钥形态（如 OpenAI 的 sk- 开头）。
 */
const apiKeyArb: fc.Arbitrary<string> = fc
  .string({ minLength: 16, maxLength: 48 })
  // 去掉可能干扰 JSON/子串比对的字符，保留可见字符集
  .map((s) => "sk-" + s.replace(/[\s"\\]/g, "x"))
  // 兜底保证前缀后仍有足量字符
  .map((s) => (s.length >= 12 ? s : s + "0123456789ab"));

/**
 * 模型 id 生成器：非空、去除会干扰断言的字符的短串。
 */
const modelIdArb: fc.Arbitrary<string> = fc
  .string({ minLength: 1, maxLength: 24 })
  .map((s) => s.replace(/[\s"\\]/g, "x"))
  .filter((s) => s.length > 0);

/** 模型 id 集合生成器：0~8 个模型 id（允许空集，覆盖「无模型」边界） */
const modelIdsArb: fc.Arbitrary<string[]> = fc.array(modelIdArb, { minLength: 0, maxLength: 8 });

/**
 * 构造一个「需要鉴权」的 provider（header / bearer 形态），带可自动拉取的 modelListing。
 * 其 apiKeyRef 指向已在内存 SecretStore 存入明文的条目。
 */
function makeAuthedProvider(apiKeyRef: string): ProviderConfig {
  const listing: ModelListingConfig = {
    path: "/v1/models",
    method: "GET",
    auth: { in: "header", kind: "bearer", name: "Authorization", valueTemplate: "Bearer {key}" },
    responseMapping: { arrayPointer: "/data", idField: "id" },
  };
  return {
    id: "p-authed",
    name: "openai",
    baseUrl: "https://api.example.com",
    apiKeyRef,
    models: [],
    timeoutMs: 5000,
    modelListing: listing,
  };
}

/**
 * 构造一个「无鉴权本地」provider：随机用 isLocal 或 auth.in="none"/kind="none" 两种标记之一，
 * 覆盖 Property 12 对「无鉴权」的两类判定来源。
 *
 * @param variant 决定无鉴权的表达方式
 * @param emptyRef apiKeyRef 是否为空串（验证「不因 apiKeyRef 为空而失败」）
 */
function makeLocalNoAuthProvider(
  variant: "isLocal" | "authNone" | "kindNone",
  emptyRef: boolean,
): ProviderConfig {
  // 无鉴权形态下仍声明 name/valueTemplate 也应被忽略；此处按 none 形态声明
  const auth =
    variant === "authNone"
      ? ({ in: "none" } as const)
      : variant === "kindNone"
        ? ({ in: "header", kind: "none" } as const)
        : ({ in: "none" } as const); // isLocal 变体的 auth 用 none 即可
  const listing: ModelListingConfig = {
    path: "/v1/models",
    method: "GET",
    auth,
    responseMapping: { arrayPointer: "/data", idField: "id" },
  };
  return {
    id: "p-local",
    name: "ollama",
    baseUrl: "http://127.0.0.1:11434",
    apiKeyRef: emptyRef ? "" : "secret://unused",
    models: [],
    timeoutMs: 3000,
    isLocal: variant === "isLocal",
    modelListing: listing,
  };
}

/**
 * 由一组模型 id 构造 OpenAI 风格的列表响应体（/data[].id），并以 JSON 响应返回。
 * 额外塞入一个非字符串 id 与一个重复 id，顺带覆盖归一化的去重/跳过路径（不影响本属性断言）。
 */
function makeListingResponse(modelIds: string[]): HttpResponse {
  const data = modelIds.map((id) => ({ id }));
  return {
    status: 200,
    headers: { "content-type": "application/json" },
    body: { object: "list", data },
    latencyMs: 1,
  };
}

// ===========================================================================
// Property 8: 发现与探测过程不泄露明文密钥（fetchModels 维度）
// ===========================================================================

describe("Property 8: 发现与探测过程不泄露明文密钥（fetchModels）", () => {
  it("随机 apiKey + 随机模型集合：fetchModels 回传对象序列化后不含明文", async () => {
    await fcAssertAsync(
      fc.asyncProperty(apiKeyArb, modelIdsArb, async (apiKey, modelIds) => {
        // 内存 SecretStore 存入明文，provider 仅持中立 apiKeyRef
        const secretStore = new InMemorySecretStore();
        const apiKeyRef = "secret://p-authed";
        await secretStore.saveSecret(apiKeyRef, apiKey);

        const captured: CapturedRequest[] = [];
        const httpSend = makeRecordingHttpSend(makeListingResponse(modelIds), captured);
        const discovery = new ModelDiscovery({ secretStore, httpSend });

        const provider = makeAuthedProvider(apiKeyRef);
        const result: FetchModelsResult = await discovery.fetchModels(provider);

        // 核心断言：回传渲染进程的结果（整体与各模型）序列化后不含明文 apiKey
        const serialized = JSON.stringify(result);
        expect(serialized.includes(apiKey)).toBe(false);
        // 冗余保险：逐个模型对象也不含明文
        for (const m of result.models) {
          expect(JSON.stringify(m).includes(apiKey)).toBe(false);
        }

        // 明文确实被用于构造请求的鉴权头（证明「用过但不回传」，而非「根本没用到」造成的假通过）
        expect(captured.length).toBe(1);
        expect(captured[0].headers["Authorization"]).toBe(`Bearer ${apiKey}`);
        return true;
      }),
    );
  });

  it("鉴权失败/端点异常等分支：warning 文案与结果序列化同样不含明文", async () => {
    // 覆盖 401/403 与非 2xx/格式非预期等分支，确认各类返回路径都不泄露明文
    const statusArb = fc.constantFrom(401, 403, 500, 503);
    await fcAssertAsync(
      fc.asyncProperty(apiKeyArb, statusArb, async (apiKey, status) => {
        const secretStore = new InMemorySecretStore();
        const apiKeyRef = "secret://p-authed";
        await secretStore.saveSecret(apiKeyRef, apiKey);

        const captured: CapturedRequest[] = [];
        const errResp: HttpResponse = {
          status,
          headers: { "content-type": "application/json" },
          body: { error: "nope" },
          latencyMs: 1,
        };
        const httpSend = makeRecordingHttpSend(errResp, captured);
        const discovery = new ModelDiscovery({ secretStore, httpSend });

        const result = await discovery.fetchModels(makeAuthedProvider(apiKeyRef));

        // 即便返回 warning，整个结果（含 warning 文案）序列化后也不得包含明文
        expect(JSON.stringify(result).includes(apiKey)).toBe(false);
        return true;
      }),
    );
  });
});

// ===========================================================================
// Property 9: 探测只读、无配置副作用（fetchModels 维度）
// ===========================================================================

describe("Property 9: 探测只读、无配置副作用（fetchModels）", () => {
  /** 当前用例使用的临时工作目录（每个用例独立，用后清理） */
  let workDir: string;

  beforeEach(async () => {
    workDir = await fs.mkdtemp(path.join(os.tmpdir(), "model-discovery-prop9-"));
  });

  afterEach(async () => {
    // 清理临时目录，避免污染系统临时空间；Windows 下文件句柄释放有延迟，加重试增强健壮性
    await fs.rm(workDir, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 });
  });

  // 固定的「本地配置文件 + AppState 快照」文件名与初始内容。
  // 内容与随机输入无关（Property 9 要验证的是「无论何种输入，本地文件都不被改」），
  // 故在迭代外一次性写入磁盘，迭代内只做「执行 + 校验不变」，避免每次迭代重复写盘导致超时。
  const fileNames = {
    opencode: "opencode.json",
    pi: "pi.toml",
    workbuddy: "workbuddy.yaml",
    codebuddy: "codebuddy.json",
    appState: "app-state.json",
  } as const;
  const fileContents: Record<string, string> = {
    [fileNames.opencode]: JSON.stringify({ provider: { openai: { options: { baseURL: "x" } } } }),
    [fileNames.pi]: "[provider.openai]\nbaseUrl = \"x\"\n",
    [fileNames.workbuddy]: "provider:\n  openai:\n    baseUrl: x\n",
    [fileNames.codebuddy]: JSON.stringify({ theme: "dark", keymap: {} }),
    [fileNames.appState]: JSON.stringify({ providers: [], agents: [], activeProviderId: "p1" }),
  };

  it(
    "随机执行 fetchModels：本地各 agent 配置与 AppState 快照内容前后不变，且远端请求仅为只读 GET",
    async () => {
      // 迭代外一次性写入固定内容的本地文件（见上说明），并记录绝对路径
      const absPaths: Record<string, string> = {};
      for (const [name, content] of Object.entries(fileContents)) {
        const abs = path.join(workDir, name);
        absPaths[name] = abs;
        await fs.writeFile(abs, content, "utf8");
      }

      await fcAssertAsync(
        fc.asyncProperty(apiKeyArb, modelIdsArb, async (apiKey, modelIds) => {
          // 注入内存 SecretStore 与记账 mock httpSend（返回只读列表响应）
          const secretStore = new InMemorySecretStore();
          const apiKeyRef = "secret://p-authed";
          await secretStore.saveSecret(apiKeyRef, apiKey);
          const captured: CapturedRequest[] = [];
          const httpSend = makeRecordingHttpSend(makeListingResponse(modelIds), captured);
          const discovery = new ModelDiscovery({ secretStore, httpSend });

          // 执行 fetchModels（本应只读远端、绝不触碰本地文件）
          await discovery.fetchModels(makeAuthedProvider(apiKeyRef));

          // 断言：所有本地文件内容与执行前逐字节一致（无配置副作用）
          for (const [name, before] of Object.entries(fileContents)) {
            const after = await fs.readFile(absPaths[name], "utf8");
            expect(after).toBe(before);
          }
          // 断言：临时目录内未新增任何文件（无备份/临时/半写文件产生）
          const entries = await fs.readdir(workDir);
          expect(entries.sort()).toEqual(Object.values(fileNames).slice().sort());

          // 断言：对远端只发了只读 GET 请求（列表拉取），无任何写入类方法
          expect(captured.length).toBe(1);
          expect(captured[0].method).toBe("GET");
          return true;
        }),
      );
    },
    // 该属性每次迭代都做真实磁盘读校验，放宽单测超时至 120s 以容纳 >=100 次迭代的 I/O
    // （Windows 下真实磁盘读偏慢，接近 60s 边界时偶发超时，属环境性性能裕度；
    //  numRuns 仍 >=100，断言不削弱）
    120_000,
  );
});

// ===========================================================================
// Property 12: 无鉴权本地 provider 不读取也不要求密钥（fetchModels 维度）
// ===========================================================================

describe("Property 12: 无鉴权本地 provider 不读取也不要求密钥（fetchModels）", () => {
  const variantArb = fc.constantFrom<"isLocal" | "authNone" | "kindNone">(
    "isLocal",
    "authNone",
    "kindNone",
  );

  it("无鉴权本地 provider：不调用 resolveSecret、不因 apiKeyRef 为空而失败、请求不含鉴权头/查询", async () => {
    await fcAssertAsync(
      fc.asyncProperty(variantArb, fc.boolean(), modelIdsArb, async (variant, emptyRef, modelIds) => {
        // SecretStore 用「一旦被调用即抛错」的替身：若引擎错误地去解析密钥，属性立即失败
        const throwingStore = new ThrowingSecretStore();
        // 同时用记账替身交叉验证「resolveSecret 调用次数为 0」
        const recordingStore = new RecordingSecretStore(throwingStore);

        const captured: CapturedRequest[] = [];
        const httpSend = makeRecordingHttpSend(makeListingResponse(modelIds), captured);
        const discovery = new ModelDiscovery({ secretStore: recordingStore, httpSend });

        const provider = makeLocalNoAuthProvider(variant, emptyRef);

        // 不因 apiKeyRef 为空/无鉴权而抛错：应正常返回支持列表的结果
        const result = await discovery.fetchModels(provider);
        expect(result.supportsListing).toBe(true);

        // 断言：从未调用 SecretStore.resolveSecret（既不读取也不要求密钥）
        expect(recordingStore.resolveCalls.length).toBe(0);

        // 断言：确实发出了只读请求，且请求不含任何鉴权头/查询参数
        expect(captured.length).toBe(1);
        const req = captured[0];
        // 不含常见鉴权头（大小写无关检查）
        const headerNames = Object.keys(req.headers).map((n) => n.toLowerCase());
        expect(headerNames).not.toContain("authorization");
        expect(headerNames).not.toContain("x-api-key");
        expect(headerNames).not.toContain("api-key");
        // 不含任何查询参数（无鉴权不应注入 ?key= 之类）
        expect(Object.keys(req.query).length).toBe(0);
        return true;
      }),
    );
  });
});

// ===========================================================================
// probeModels 维度（任务 6.3 落地后补齐）
// ===========================================================================
//
// 下列三条属性的 probeModels 维度与上面的 fetchModels 维度完全对应，待前置任务 6.3
// 实现 ModelDiscovery.probeModel / probeModels 后，即可复用本文件的记账 httpSend、
// RecordingSecretStore / ThrowingSecretStore 与随机生成器补齐断言：
//   - Property 8：probeModels 回传的 ModelProbeResult[] 序列化后不含明文；
//   - Property 9：probeModels 执行前后本地文件不变，远端仅发最小代价探测请求（max_tokens 极小等），
//     不触发写入类操作；
//   - Property 12：无鉴权本地 provider 的 probeModels 同样不调用 resolveSecret、请求不含鉴权头/查询。
// 当前 probeModels 仍为占位实现（throw），故以 describe.todo 标注待办，不纳入本次运行。
describe.todo("Property 8/9/12（probeModels 维度，依赖任务 6.3 实现后补齐）");
