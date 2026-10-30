// 主进程 IPC handlers（IPC 处理层）
//
// 本模块实现 design.md「IPC 处理层（IPCHandler）」：在主进程用 ipcMain.handle 注册
// IpcApi 契约声明的全部方法（loadAppState / saveAppState / saveSecret /
// getMaskedSecret / detectAgents / preview / distribute / listAgents / fetchModels /
// probeModels），并把每个调用编排到对应的主进程服务上——ConfigStore、SecretStore、
// ModelDiscovery、Distributor、AdapterRegistry。渲染进程经 preload 的 contextBridge
// 白名单（任务 11.2）调用这些 channel，主进程在此集中承接并委派。
//
// 关键安全约束（对应需求 2.6 / 2.7 / 3.2 / 3.4、Property 1 / Property 8）：
// - 回传渲染进程的任何数据都「不含明文密钥」：
//   · getMaskedSecret 只经 SecretStore.getMasked 返回掩码串；
//   · preview / distribute 的 maskedDiff 由 render 内部掩码保证不含明文；
//   · fetchModels / probeModels 的结果仅含模型元信息，不回传密钥；
//   · loadAppState 返回的 AppState 只含中立的 apiKeyRef 引用。
// - 明文密钥仅在主进程内存中短暂存在：saveSecret 接收渲染进程输入的明文后立即交
//   SecretStore 存入凭据管理器；分发/发现/探测所需的明文由各服务在主进程内部经
//   SecretStore.resolveSecret 解析、用后即弃，绝不跨进程回传。
//
// 装配风格（与既有服务一致——依赖可注入）：
// - registerIpcHandlers(deps) 接收已装配好的服务与 ipcMain，便于主进程启动时装配、
//   也便于测试注入内存实现与替身，不依赖真实 Electron 运行时。
// - createMainServices() 提供一份面向生产的默认装配（safeStorage 密钥存储、基于 fetch
//   的 HTTP、已注册四个适配器的注册表、从 process 读取的平台上下文）。

import type {
  AppState,
  ApplyReport,
  DetectResult,
  FetchModelsResult,
  ModelProbeResult,
  PlatformContext,
  PreviewResult,
  ProbeOptions,
  ProviderConfig,
} from "@shared/types";
// IPC channel 名称常量：已上提到 src/shared 作为跨进程协议，主进程与预加载脚本共用同一处声明。
// 此处从 @shared 引入并向下重新导出，保持对既有引用方（主进程入口、单元测试）的 API 兼容。
import { IPC_CHANNELS } from "@shared/ipcChannels";

import type { ConfigStore } from "../services/configStore";
import type { SecretStore, EncryptedStorePersistence } from "../services/secretStore";
import type { ModelDiscovery } from "../services/modelDiscovery";
import type { Distributor } from "../services/distributor";
import type { AdapterRegistry } from "../adapters/registry";

// ===========================================================================
// IPC channel 名称常量：主进程 handle 与 preload invoke 共用，避免字符串漂移
// ===========================================================================

// IPC channel 名称常量与其派生类型现统一在 @shared/ipcChannels 声明（跨进程协议同源）。
// 这里向下重新导出，使既有从本模块导入 IPC_CHANNELS / IpcChannel 的代码无需改动。
export { IPC_CHANNELS };
export type { IpcChannel } from "@shared/ipcChannels";

// ===========================================================================
// 可注入依赖
// ===========================================================================

/**
 * ipcMain 的最小接口：仅声明本模块用到的 handle / removeHandler。
 *
 * 本地声明而非直接依赖 electron 的类型：使本模块可在无 Electron 运行时的单元测试里注入
 * 替身 ipcMain（记录注册的 handler 并可直接调用），从而无需拉起真实主进程即可验证编排。
 */
export interface IpcMainLike {
  /**
   * 注册一个可返回值的 IPC 处理器。
   * @param channel  channel 名称
   * @param listener 处理函数；首参为 IPC 事件（本模块不使用，以 unknown 占位），其后为渲染进程传参
   */
  handle(
    channel: string,
    listener: (event: unknown, ...args: unknown[]) => unknown,
  ): void;
  /** 移除某 channel 的处理器（用于热重载/测试清理，可选实现） */
  removeHandler?(channel: string): void;
}

/**
 * registerIpcHandlers 的可注入依赖集合。
 *
 * 全部服务与 ipcMain 均注入：主进程启动时传入生产装配（见 createMainServices），
 * 测试传入内存实现/替身。platform 作为快照注入而非在 handler 内全局读取 process，
 * 便于测试模拟不同平台。
 */
export interface IpcHandlerDeps {
  /** ipcMain（或其替身）：用于注册各 channel 的 handle */
  ipcMain: IpcMainLike;
  /** 配置存储服务：加载/保存 AppState（不含明文密钥） */
  configStore: ConfigStore;
  /** 密钥服务：保存明文、返回掩码串（明文绝不回传渲染进程） */
  secretStore: SecretStore;
  /** 模型发现与探测服务：拉取模型清单、探测可用性 */
  modelDiscovery: ModelDiscovery;
  /** 分发编排器：preview（不写盘）/ distribute（写盘并回报告） */
  distributor: Distributor;
  /** 适配器注册表：detectAgents / listAgents 所需 */
  registry: AdapterRegistry;
  /** 当前运行平台上下文：供 detectAgents 解析各 agent 配置文件路径 */
  platform: PlatformContext;
}

// ===========================================================================
// 注册：把 IpcApi 全部方法编排到各服务
// ===========================================================================

/**
 * 在主进程注册 IpcApi 契约的全部 IPC 处理器。
 *
 * 每个 channel 的处理器都是对渲染进程传参的薄编排：转调对应服务并返回其结果。本函数不做
 * 业务判断，只负责「承接 IPC → 委派服务 → 回传结果」，并严守「回传不含明文密钥」的边界：
 * - getMaskedSecret 走 SecretStore.getMasked（不存在返回 null，不抛给渲染进程以免泄露栈）；
 * - preview/distribute 的 maskedDiff 已由 render 掩码；
 * - fetchModels/probeModels 的结果仅含模型元信息。
 *
 * @param deps 可注入的服务与 ipcMain（及平台上下文）
 */
export function registerIpcHandlers(deps: IpcHandlerDeps): void {
  const { ipcMain, configStore, secretStore, modelDiscovery, distributor, registry, platform } =
    deps;

  // --- 应用状态：加载 ---------------------------------------------------
  // ConfigStore.loadAppState 以结果对象承载成功/失败；IPC 契约要求返回 AppState，
  // 故这里在失败时回退到当前内存快照（getState），保证渲染进程总能拿到可用状态而非异常。
  ipcMain.handle(IPC_CHANNELS.loadAppState, async (): Promise<AppState> => {
    const result = await configStore.loadAppState();
    if (result.ok) {
      return result.state;
    }
    // 加载失败（读/解析错误）：返回内存既有快照（首次为空初始状态），不向渲染进程抛错
    return configStore.getState();
  });

  // --- 应用状态：保存 ---------------------------------------------------
  // 传入的 AppState 本身只含中立 apiKeyRef（类型约束 + ConfigStore 归一化），不含明文。
  // 保存失败时抛出可读错误，渲染进程据此提示「持久化失败」。
  ipcMain.handle(IPC_CHANNELS.saveAppState, async (_event, state): Promise<void> => {
    const result = await configStore.saveAppState(state as AppState);
    if (!result.ok) {
      throw new Error(result.error.message);
    }
  });

  // --- 密钥：保存明文（明文仅在此交 SecretStore 存入凭据管理器，不回传） ------
  ipcMain.handle(IPC_CHANNELS.saveSecret, async (_event, keyRef, apiKey): Promise<void> => {
    await secretStore.saveSecret(keyRef as string, apiKey as string);
  });

  // --- 密钥：取掩码串（从不回传明文；keyRef 不存在时返回 null） ----------------
  ipcMain.handle(
    IPC_CHANNELS.getMaskedSecret,
    async (_event, keyRef): Promise<string | null> => {
      try {
        return await secretStore.getMasked(keyRef as string);
      } catch {
        // keyRef 不存在/读取失败：返回 null 供 UI 显示「未设置」，绝不泄露明文或错误细节
        return null;
      }
    },
  );

  // --- Agent：探测安装与配置文件状态 ------------------------------------
  ipcMain.handle(IPC_CHANNELS.detectAgents, async (_event, agentIds): Promise<DetectResult[]> => {
    return detectAgents(registry, platform, agentIds as string[]);
  });

  // --- 分发：仅预览（不写盘，maskedDiff 已掩码） --------------------------
  ipcMain.handle(
    IPC_CHANNELS.preview,
    async (_event, config, agentIds): Promise<PreviewResult[]> => {
      return distributor.preview(config as ProviderConfig, agentIds as string[]);
    },
  );

  // --- 分发：执行写盘并返回报告（ApplyReport 不含明文） --------------------
  ipcMain.handle(
    IPC_CHANNELS.distribute,
    async (_event, config, agentIds): Promise<ApplyReport> => {
      return distributor.distribute(config as ProviderConfig, agentIds as string[]);
    },
  );

  // --- Agent：列出所有已注册适配器（供 UI 展示可管理的 agent） ------------
  ipcMain.handle(
    IPC_CHANNELS.listAgents,
    async (): Promise<{ id: string; displayName: string }[]> => {
      // 只投影 id/displayName 两个展示字段，不泄露适配器内部实现
      return registry.list().map((adapter) => ({
        id: adapter.id,
        displayName: adapter.displayName,
      }));
    },
  );

  // --- 模型：自动拉取清单（内部解析明文请求端点，结果不含明文） --------------
  ipcMain.handle(
    IPC_CHANNELS.fetchModels,
    async (_event, config): Promise<FetchModelsResult> => {
      return modelDiscovery.fetchModels(config as ProviderConfig);
    },
  );

  // --- 模型：批量探测可用性（结果与 modelIds 一一对应，不含明文） ------------
  ipcMain.handle(
    IPC_CHANNELS.probeModels,
    async (_event, config, modelIds, options): Promise<ModelProbeResult[]> => {
      return modelDiscovery.probeModels(
        config as ProviderConfig,
        modelIds as string[],
        options as ProbeOptions | undefined,
      );
    },
  );
}

/**
 * 探测一组 agent 的安装与配置文件状态。
 *
 * 逐个按 agentId 从注册表取适配器并调用其 detect；未注册的 agentId 收敛为一条
 * 「未安装」的 DetectResult（configPath 为空、fileExists=false），保证返回结果与请求的
 * agentIds 一一对应、不因个别未知 id 抛错中断整体探测。
 *
 * @param registry 适配器注册表
 * @param platform 当前平台上下文
 * @param agentIds 待探测的 agent id 列表
 * @returns 与 agentIds 顺序对应的 DetectResult 列表
 */
async function detectAgents(
  registry: AdapterRegistry,
  platform: PlatformContext,
  agentIds: string[],
): Promise<DetectResult[]> {
  // 并行探测各 agent：detect 现在多经 CLI 版本命令完成，个别 CLI 启动较慢（如 codebuddy
  // 的 `--version` 可达十余秒）。串行会把各 agent 的耗时累加，并行则使总时长≈最慢的一个。
  // Promise.all 保持结果与 agentIds 顺序一一对应。
  return Promise.all(
    agentIds.map(async (agentId): Promise<DetectResult> => {
      const adapter = registry.get(agentId);
      if (!adapter) {
        // 未注册的 agent：以「未安装」占位，保持与请求一一对应
        return { installed: false, configPath: "", fileExists: false };
      }
      return adapter.detect(platform);
    }),
  );
}

// ===========================================================================
// 生产装配：createMainServices / createPlatformContext
// ===========================================================================

/**
 * createMainServices 装配出的全部主进程服务（供 registerIpcHandlers 消费）。
 */
export interface MainServices {
  /** 配置存储服务 */
  configStore: ConfigStore;
  /** 密钥服务（safeStorage 后端） */
  secretStore: SecretStore;
  /** 模型发现与探测服务 */
  modelDiscovery: ModelDiscovery;
  /** 分发编排器 */
  distributor: Distributor;
  /** 已注册四个内置适配器的注册表 */
  registry: AdapterRegistry;
  /** 从 process 读取的平台上下文 */
  platform: PlatformContext;
}

/**
 * 从 Node process 构造当前运行平台上下文。
 *
 * 之所以在装配期一次性快照：PlatformContext 需要 os / homeDir / env 三要素供 PathResolver
 * 展开各 agent 配置路径中的平台变量（~、%APPDATA%、$XDG_CONFIG_HOME 等）。把它作为快照注入
 * 到各服务，既与既有「注入而非全局读取」的风格一致，也便于测试替换。
 *
 * 平台归一化：process.platform 为 win32/darwin 时原样采用，其余（linux 及各类 Unix）统一按
 * "linux" 处理——本程序的路径解析只区分这三类配置根目录约定。
 *
 * @returns 当前平台上下文
 */
export function createPlatformContext(): PlatformContext {
  const raw = process.platform;
  const os: PlatformContext["os"] = raw === "win32" ? "win32" : raw === "darwin" ? "darwin" : "linux";
  return {
    os,
    // 用户主目录：优先 USERPROFILE（Windows）/ HOME（类 Unix），兜底空串交由路径解析报错
    homeDir: process.env.USERPROFILE ?? process.env.HOME ?? "",
    // 环境变量快照：PathResolver 需要 APPDATA / XDG_CONFIG_HOME / ProgramData 等
    env: { ...process.env },
  };
}

/**
 * 装配面向生产的全部主进程服务。
 *
 * 装配内容：
 * - ConfigStore：默认落在 Electron userData 目录（createConfigStore 内部惰性解析）。
 * - SecretStore：基于 Electron safeStorage 加密 + userData 下的 JSON 文件持久化密文；
 *   明文永不落盘（见 secretStore 模块说明）。
 * - ModelDiscovery：注入 SecretStore 与基于全局 fetch 的 httpSend。
 * - Distributor：注入已注册适配器的注册表、SecretStore、默认原子写入器、平台上下文。
 * - AdapterRegistry：createRegisteredAdapters 一次注册 opencode/pi/workbuddy/codebuddy。
 *
 * 延迟 import electron 与各服务工厂，避免在无 Electron 运行时的测试里误触真实运行时；
 * 本函数只应由主进程启动流程调用。
 *
 * @returns 装配完成、可直接交 registerIpcHandlers 的服务集合
 */
export async function createMainServices(): Promise<MainServices> {
  // 延迟引入 electron 与各服务工厂，隔离导入期副作用
  const { app, safeStorage } = await import("electron");
  const { createConfigStore } = await import("../services/configStore");
  const { createSafeStorageSecretStore } = await import("../services/secretStore");
  const { createModelDiscovery } = await import("../services/modelDiscovery");
  const { createDefaultHttpSend } = await import("../services/http");
  const { createDistributor } = await import("../services/distributor");
  const { atomicFileWriter } = await import("../services/atomicFileWriter");
  const { createRegisteredAdapters } = await import("../adapters");
  const { join } = await import("node:path");
  const fsp = await import("node:fs/promises");

  const platform = createPlatformContext();
  const userDataDir = app.getPath("userData");

  // 配置存储：默认 userData/app-state.json（不含明文密钥）
  const configStore = createConfigStore();

  // 密钥持久化：把 keyRef→密文(base64) 映射存到 userData/secrets.json；明文经 safeStorage 加密
  const secretsFilePath = join(userDataDir, "secrets.json");
  const persistence: EncryptedStorePersistence = {
    async load(): Promise<Record<string, string>> {
      try {
        const raw = await fsp.readFile(secretsFilePath, "utf8");
        return JSON.parse(raw) as Record<string, string>;
      } catch (error) {
        // 首次无文件（ENOENT）视为空映射；其它读取错误向上抛出交由 SecretStore 归类
        if (
          typeof error === "object" &&
          error !== null &&
          (error as NodeJS.ErrnoException).code === "ENOENT"
        ) {
          return {};
        }
        throw error;
      }
    },
    async save(data: Record<string, string>): Promise<void> {
      await fsp.mkdir(userDataDir, { recursive: true });
      await fsp.writeFile(secretsFilePath, `${JSON.stringify(data, null, 2)}\n`, "utf8");
    },
  };
  const secretStore = createSafeStorageSecretStore(safeStorage, persistence);

  // HTTP 发送：生产用全局 fetch（Electron 主进程内置 undici）
  const httpSend = createDefaultHttpSend();

  // 模型发现与探测
  const modelDiscovery = createModelDiscovery({ secretStore, httpSend });

  // 适配器注册表 + 分发编排器
  const registry = createRegisteredAdapters();
  const distributor = createDistributor({
    registry,
    secretStore,
    fileWriter: atomicFileWriter,
    platform,
  });

  return { configStore, secretStore, modelDiscovery, distributor, registry, platform };
}
