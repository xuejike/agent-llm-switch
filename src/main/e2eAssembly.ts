// E2E（端到端 GUI 测试）专用的主进程服务装配
//
// 目的：为 Playwright 驱动的 GUI 自动化测试提供「确定性、零外部副作用」的运行环境，
// 使每条用例的断言稳定可复现，且绝不污染真实用户目录 / 真实 agent 配置 / 真实外网。
//
// 启用方式：仅当环境变量 LLM_SWITCH_E2E === '1' 时，src/main/index.ts 会改用本模块装配
// 服务（见 index.ts 的条件分支）。生产运行（未设置该变量）完全不触及本模块，故对生产
// 行为零影响。
//
// 本装配与生产装配（createMainServices）的差异：
// - ConfigStore：数据目录重定向到 LLM_SWITCH_E2E_DATA_DIR 指定的临时目录（Playwright 为
//   每次运行创建），app-state.json 落在该临时目录，不碰 Electron userData。
// - SecretStore：使用内存实现 InMemorySecretStore，不依赖 safeStorage（在 headless/CI
//   环境 safeStorage 可能不可用），保存/掩码行为确定，明文仅在内存，进程退出即消失。
// - ModelDiscovery：替身实现，返回固定的候选模型与探测结果，不发起任何网络请求。
// - Distributor：替身实现，preview/distribute 返回确定性的掩码 diff 与报告，不写任何
//   真实 agent 配置文件。
// - registry：沿用真实的四个内置适配器注册表（仅用于 listAgents 的 id/displayName 展示，
//   detect 不走真实文件系统——由替身 Distributor/假 detect 决定状态）。

import type {
  ApplyReport,
  FetchModelsResult,
  ModelInfo,
  ModelProbeResult,
  PlatformContext,
  PreviewResult,
  ProbeOptions,
  ProviderConfig,
} from '@shared/types';
import type { MainServices } from './ipc/handlers';

/**
 * 装配 E2E 专用的主进程服务集合。
 *
 * 延迟 import 各服务工厂，避免在无需 E2E 的生产路径上加载这些模块。
 *
 * @returns 可直接交 registerIpcHandlers 的确定性服务集合
 */
export async function createE2eServices(): Promise<MainServices> {
  const { createConfigStore } = await import('./services/configStore');
  const { InMemorySecretStore } = await import('./services/secretStore');
  const { createRegisteredAdapters } = await import('./adapters');

  // 数据目录：Playwright 为本次运行准备的临时目录；未提供时兜底到系统临时目录下的子目录
  const dataDir = await resolveE2eDataDir();

  // ConfigStore：app-state.json 落在临时目录，完全隔离真实 userData
  const configStore = createConfigStore({ dataDir });

  // SecretStore：内存实现，保存/掩码确定，不依赖 safeStorage
  const secretStore = new InMemorySecretStore();

  // 适配器注册表：真实的四个内置适配器（opencode / pi / workbuddy / codebuddy），
  // 仅供 listAgents 展示 id/displayName
  const registry = createRegisteredAdapters();

  // 平台上下文：os 原样采用当前平台，homeDir/env 指向临时目录，杜绝真实路径泄露
  const platform: PlatformContext = {
    os: process.platform === 'win32' ? 'win32' : process.platform === 'darwin' ? 'darwin' : 'linux',
    homeDir: dataDir,
    env: { HOME: dataDir, USERPROFILE: dataDir, APPDATA: dataDir, XDG_CONFIG_HOME: dataDir },
  };

  // ModelDiscovery / Distributor：确定性替身
  const modelDiscovery = new FakeModelDiscovery();
  const distributor = new FakeDistributor(registry, platform);

  return { configStore, secretStore, modelDiscovery, distributor, registry, platform };
}

/**
 * 装配「真实服务 + 临时数据目录」的 E2E 环境（LLM_SWITCH_E2E_LIVE=1 时使用）。
 *
 * 与 createE2eServices 的区别：ModelDiscovery 与 Distributor 使用真实实现（真实 fetch、
 * 真实字段合并渲染），从而在 GUI 里验证「获取清单 / 探测可用性」真的打到配置的网关。
 * SecretStore 仍用内存实现（不依赖 safeStorage，headless 环境更稳），ConfigStore 仍落在
 * 临时目录。Distributor 的写盘目标由 PlatformContext（指向临时目录）约束，不碰真实用户目录。
 *
 * @returns 可直接交 registerIpcHandlers 的「真实服务 + 隔离副作用」集合
 */
export async function createE2eLiveServices(): Promise<MainServices> {
  const { createConfigStore } = await import('./services/configStore');
  const { InMemorySecretStore } = await import('./services/secretStore');
  const { createRegisteredAdapters } = await import('./adapters');
  const { createModelDiscovery } = await import('./services/modelDiscovery');
  const { createDefaultHttpSend } = await import('./services/http');
  const { createDistributor } = await import('./services/distributor');
  const { atomicFileWriter } = await import('./services/atomicFileWriter');

  const dataDir = await resolveE2eDataDir();
  const configStore = createConfigStore({ dataDir });
  const secretStore = new InMemorySecretStore();
  const registry = createRegisteredAdapters();

  const platform: PlatformContext = {
    os: process.platform === 'win32' ? 'win32' : process.platform === 'darwin' ? 'darwin' : 'linux',
    homeDir: dataDir,
    env: { HOME: dataDir, USERPROFILE: dataDir, APPDATA: dataDir, XDG_CONFIG_HOME: dataDir },
  };

  // 真实模型发现：真实 fetch 打到配置的网关
  const modelDiscovery = createModelDiscovery({
    secretStore,
    httpSend: createDefaultHttpSend(),
  });

  // 真实分发编排：写盘目标受 platform（临时目录）约束
  const distributor = createDistributor({
    registry,
    secretStore,
    fileWriter: atomicFileWriter,
    platform,
  });

  return { configStore, secretStore, modelDiscovery, distributor, registry, platform };
}

/** 解析 E2E 数据目录：优先用注入的环境变量，兜底到系统临时目录下的固定子目录 */
async function resolveE2eDataDir(): Promise<string> {
  const injected = process.env.LLM_SWITCH_E2E_DATA_DIR;
  if (injected && injected.trim().length > 0) {
    return injected;
  }
  // 兜底：未注入时用 os.tmpdir() 下的子目录（正常情况下 Playwright 一定会注入）
  const os = await import('node:os');
  const path = await import('node:path');
  return path.join(os.tmpdir(), 'llm-switch-e2e');
}

// ===========================================================================
// 确定性替身：ModelDiscovery
// ===========================================================================

/**
 * ModelDiscovery 的 E2E 替身：返回固定的候选模型与探测结果，不发起网络请求。
 *
 * 与真实 ModelDiscovery 类型兼容（同名公有方法），以便直接注入到 MainServices。
 */
class FakeModelDiscovery {
  /**
   * 返回固定的三个候选模型。
   * 若 provider 未声明 modelListing（不支持列表 API），返回 supportsListing=false 以驱动
   * UI 的「手动输入回退」路径，便于 E2E 覆盖该分支。
   */
  async fetchModels(provider: ProviderConfig): Promise<FetchModelsResult> {
    if (!provider.modelListing) {
      return { supportsListing: false, models: [] };
    }
    const models: ModelInfo[] = [
      { id: 'e2e-model-alpha', source: 'fetched', availability: 'unknown' },
      { id: 'e2e-model-beta', source: 'fetched', availability: 'unknown' },
      { id: 'e2e-model-gamma', source: 'fetched', availability: 'unknown' },
    ];
    return { supportsListing: true, models };
  }

  /**
   * 对传入的每个模型 id 返回确定性探测结果：
   * 约定「id 含 gamma」为不可用，其余为可用，便于 UI 断言可用性 Tag 与计数。
   */
  async probeModels(
    _provider: ProviderConfig,
    modelIds: string[],
    _options?: ProbeOptions,
  ): Promise<ModelProbeResult[]> {
    const probedAt = new Date().toISOString();
    return modelIds.map((modelId) => {
      const unavailable = modelId.includes('gamma');
      return unavailable
        ? { modelId, availability: 'unavailable', error: 'E2E: 模拟不可用', probedAt }
        : { modelId, availability: 'available', latencyMs: 42, statusCode: 200, probedAt };
    });
  }
}

// ===========================================================================
// 确定性替身：Distributor
// ===========================================================================

type AdapterRegistryLike = {
  list(): { id: string; displayName: string }[];
};

/**
 * Distributor 的 E2E 替身：preview/distribute 返回确定性结果，不写任何真实文件。
 *
 * - preview：对每个请求的 agentId 生成一段固定的掩码 diff（含 + / - 行），installed=true。
 * - distribute：对每个 agentId 返回 status=success 与一个「临时目录内」的备份路径，
 *   summary 据此统计。不触碰真实 agent 配置文件。
 */
class FakeDistributor {
  constructor(
    private readonly registry: AdapterRegistryLike,
    private readonly platform: PlatformContext,
  ) {}

  async preview(config: ProviderConfig, agentIds: string[]): Promise<PreviewResult[]> {
    return agentIds.map((agentId) => ({
      agentId,
      configPath: this.fakeConfigPath(agentId),
      installed: true,
      maskedDiff: this.fakeMaskedDiff(config, agentId),
    }));
  }

  async distribute(config: ProviderConfig, agentIds: string[]): Promise<ApplyReport> {
    const timestamp = new Date().toISOString();
    const entries = agentIds.map((agentId) => ({
      agentId,
      status: 'success' as const,
      backupPath: `${this.fakeConfigPath(agentId)}.bak`,
      message: `E2E: 已写入 ${config.name} 配置`,
    }));
    return {
      timestamp,
      entries,
      summary: { success: entries.length, failed: 0, skipped: 0 },
    };
  }

  /** 构造位于 E2E 临时目录内的假配置路径（绝不指向真实用户目录） */
  private fakeConfigPath(agentId: string): string {
    const sep = this.platform.os === 'win32' ? '\\' : '/';
    return `${this.platform.homeDir}${sep}${agentId}${sep}config.json`;
  }

  /** 构造一段固定的掩码 diff 文本：含上下文行、新增行(+)、删除行(-) */
  private fakeMaskedDiff(config: ProviderConfig, agentId: string): string {
    return [
      `--- ${agentId}/config.json`,
      `+++ ${agentId}/config.json`,
      '@@ provider @@',
      ` {`,
      `-  "baseUrl": "https://old.example.com"`,
      `+  "baseUrl": "${config.baseUrl}"`,
      `+  "apiKey": "sk-****MASK"`,
      ` }`,
    ].join('\n');
  }
}
