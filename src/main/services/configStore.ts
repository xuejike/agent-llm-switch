// ConfigStore（配置存储服务）
//
// 职责（对应设计组件 5 / 需求 1.3、1.4）：
// 持久化本程序自身的「应用全局状态」AppState —— 即 Provider 配置列表、各 agent 的
// 启用状态、当前选中的 Provider 等 —— 到应用自有数据目录下的一个 JSON 文件。
//
// 关键安全约束：
// - 持久化内容「绝不含明文密钥」。AppState 的类型设计已保证这一点：ProviderConfig
//   只持有中立的 apiKeyRef（指向 OS 凭据管理器的引用），明文密钥由 SecretStore 单独
//   托管，不进入 AppState，因此不会落到本服务写出的配置文件里。
//
// I/O 失败语义（需求 1.4）：
// - 本服务在内存中保留「最近一次成功加载/保存」的 AppState 快照。
// - loadAppState 失败时：不破坏内存既有快照，返回带错误标识的失败结果；
//   首次加载（文件不存在）视为成功并返回空初始状态。
// - saveAppState 失败时：先写临时文件再原子替换，任一步失败都保证内存既有快照不变，
//   并返回带错误标识的失败结果（不抛出），上层据此提示用户「持久化失败」。
//
// 可测性：数据目录与文件路径、以及底层文件系统操作均通过构造函数「可注入」，
// 默认实现使用 Electron 的 app.getPath('userData') 与 Node 的 fs/promises，
// 单元测试可注入临时目录与内存/桩实现，避免依赖真实 Electron 运行时与真实磁盘。

import type { AppState } from '@shared/types';

/** 持久化操作的错误标识种类（供上层区分处理/提示） */
export type ConfigStoreErrorCode =
  | 'read-failed' // 读取配置文件失败（非「文件不存在」的 I/O 错误）
  | 'parse-failed' // 配置文件内容无法解析为合法 AppState JSON
  | 'write-failed'; // 写入配置文件失败（临时文件写入或原子替换失败）

/** 持久化失败结果：携带错误标识与可读信息，供上层判定并提示 */
export interface ConfigStoreError {
  /** 失败类别标识 */
  code: ConfigStoreErrorCode;
  /** 人类可读的错误说明（中文） */
  message: string;
}

/** 加载结果：成功返回状态，失败返回错误标识 */
export type LoadAppStateResult =
  | { ok: true; state: AppState }
  | { ok: false; error: ConfigStoreError };

/** 保存结果：成功无额外数据，失败返回错误标识 */
export type SaveAppStateResult =
  | { ok: true }
  | { ok: false; error: ConfigStoreError };

/**
 * 可注入的文件系统最小接口。
 *
 * 仅声明 ConfigStore 实际需要的几个操作，便于测试以内存/桩实现注入，
 * 生产环境由默认实现委托给 Node 的 fs/promises。
 */
export interface ConfigStoreFs {
  /** 确保目录存在（递归创建），已存在则无副作用 */
  ensureDir(dir: string): Promise<void>;
  /** 读取文本文件内容；文件不存在须抛出 code==='ENOENT' 的错误 */
  readFile(path: string): Promise<string>;
  /** 写入文本文件（覆盖写），用于写临时文件 */
  writeFile(path: string, data: string): Promise<void>;
  /** 原子重命名/替换：把 from 重命名为 to（同目录内保证原子性） */
  rename(from: string, to: string): Promise<void>;
}

/** 构造 ConfigStore 所需的依赖（全部可注入，默认取 Electron/Node 实现） */
export interface ConfigStoreOptions {
  /**
   * 配置文件所在目录的绝对路径。
   * 缺省时取 Electron app.getPath('userData')（应用自有数据目录）。
   */
  dataDir?: string;
  /**
   * 配置文件名（相对 dataDir）。缺省 'app-state.json'。
   */
  fileName?: string;
  /** 可注入的文件系统实现，缺省委托 Node fs/promises */
  fs?: ConfigStoreFs;
}

/** 配置文件默认文件名 */
const DEFAULT_FILE_NAME = 'app-state.json';

/** 空的初始应用状态：首次启动、配置文件尚不存在时使用 */
function createEmptyAppState(): AppState {
  return { providers: [], agents: [] };
}

/**
 * 判断一个错误是否为「文件不存在」（ENOENT）。
 *
 * 首次加载时配置文件尚未创建，read 会抛出 ENOENT —— 这不属于「加载失败」，
 * 而应视为「返回空初始状态」。此处对未知错误形状做防御式判断。
 */
function isFileNotFound(error: unknown): boolean {
  return (
    typeof error === 'object' &&
    error !== null &&
    'code' in error &&
    (error as { code?: unknown }).code === 'ENOENT'
  );
}

/**
 * 基于 Node fs/promises 的默认文件系统实现。
 *
 * 延迟 import，使本模块在不触及该实现（例如测试注入了自定义 fs）时，
 * 不强制依赖 Node 内置模块的加载时机。
 */
function createNodeFs(): ConfigStoreFs {
  return {
    async ensureDir(dir: string): Promise<void> {
      const { mkdir } = await import('node:fs/promises');
      await mkdir(dir, { recursive: true });
    },
    async readFile(path: string): Promise<string> {
      const { readFile } = await import('node:fs/promises');
      return readFile(path, 'utf-8');
    },
    async writeFile(path: string, data: string): Promise<void> {
      const { writeFile } = await import('node:fs/promises');
      await writeFile(path, data, 'utf-8');
    },
    async rename(from: string, to: string): Promise<void> {
      const { rename } = await import('node:fs/promises');
      await rename(from, to);
    },
  };
}

/**
 * 解析默认数据目录：取 Electron 应用自有数据目录（userData）。
 *
 * 延迟 import electron，仅在未注入 dataDir 时才触及，避免测试环境强依赖
 * Electron 运行时（注入了 dataDir 的单元测试完全不会走到这里）。
 */
async function resolveDefaultDataDir(): Promise<string> {
  const { app } = await import('electron');
  return app.getPath('userData');
}

/**
 * ConfigStore 接口（对应设计组件 5）。
 *
 * 说明：设计文档以 loadAppState(): Promise<AppState> / saveAppState(): Promise<void>
 * 描述职责；为满足需求 1.4「I/O 失败时返回持久化失败错误标识」，此处以结果对象
 * （LoadAppStateResult / SaveAppStateResult）承载成功状态或错误标识，而非抛出异常，
 * 使上层能显式分支处理成功与失败。
 */
export interface ConfigStore {
  /** 从数据目录加载 AppState；文件不存在返回空初始状态；I/O 失败返回错误标识 */
  loadAppState(): Promise<LoadAppStateResult>;
  /** 持久化 AppState（不含明文密钥）；I/O 失败时内存状态不变并返回错误标识 */
  saveAppState(state: AppState): Promise<SaveAppStateResult>;
  /** 读取当前内存中的状态快照（最近一次成功加载/保存的结果） */
  getState(): AppState;
}

/**
 * ConfigStore 的文件系统实现。
 *
 * 内部维护一份「内存状态快照」currentState，只在加载/保存「成功」后才更新它，
 * 从而满足需求 1.4：任何 I/O 失败都不会污染既有内存状态。
 */
export class FileConfigStore implements ConfigStore {
  private readonly fileName: string;
  private readonly fs: ConfigStoreFs;
  /** 已注入的数据目录；未注入时为 undefined，首次使用时惰性解析为 Electron userData */
  private dataDir: string | undefined;
  /** 内存状态快照：最近一次成功加载/保存的 AppState */
  private currentState: AppState;

  constructor(options: ConfigStoreOptions = {}) {
    this.dataDir = options.dataDir;
    this.fileName = options.fileName ?? DEFAULT_FILE_NAME;
    this.fs = options.fs ?? createNodeFs();
    // 初始内存快照为空状态，确保在任何加载之前 getState 也有确定返回值
    this.currentState = createEmptyAppState();
  }

  /** 解析（并缓存）数据目录绝对路径 */
  private async resolveDataDir(): Promise<string> {
    if (this.dataDir === undefined) {
      this.dataDir = await resolveDefaultDataDir();
    }
    return this.dataDir;
  }

  /** 拼接配置文件绝对路径 */
  private async resolveFilePath(): Promise<string> {
    const dir = await this.resolveDataDir();
    // 用正斜杠拼接即可（Node 在各平台均接受正斜杠），避免引入 path 依赖到注入边界
    return `${dir.replace(/[/\\]+$/, '')}/${this.fileName}`;
  }

  getState(): AppState {
    return this.currentState;
  }

  async loadAppState(): Promise<LoadAppStateResult> {
    let raw: string;
    try {
      const filePath = await this.resolveFilePath();
      raw = await this.fs.readFile(filePath);
    } catch (error) {
      // 文件不存在：首次启动的正常情形，返回空初始状态并作为内存快照
      if (isFileNotFound(error)) {
        this.currentState = createEmptyAppState();
        return { ok: true, state: this.currentState };
      }
      // 其它读取错误：保留内存既有快照不变，返回读取失败标识
      return {
        ok: false,
        error: {
          code: 'read-failed',
          message: `读取配置文件失败：${describeError(error)}`,
        },
      };
    }

    // 解析 JSON：解析失败同样保留内存既有快照不变，返回解析失败标识
    try {
      const parsed = JSON.parse(raw) as AppState;
      const normalized = normalizeAppState(parsed);
      this.currentState = normalized;
      return { ok: true, state: normalized };
    } catch (error) {
      return {
        ok: false,
        error: {
          code: 'parse-failed',
          message: `配置文件内容无法解析为合法状态：${describeError(error)}`,
        },
      };
    }
  }

  async saveAppState(state: AppState): Promise<SaveAppStateResult> {
    // 仅持久化中立字段：AppState 类型本身已不含明文密钥（只含 apiKeyRef 引用），
    // 这里做一次归一化拷贝，确保写出的 JSON 结构稳定且不夹带非预期字段。
    const toPersist = normalizeAppState(state);
    const serialized = `${JSON.stringify(toPersist, null, 2)}\n`;

    try {
      const dir = await this.resolveDataDir();
      const filePath = await this.resolveFilePath();
      const tmpPath = `${filePath}.tmp`;

      // 确保目标目录存在（首次保存时数据目录可能尚未创建）
      await this.fs.ensureDir(dir);
      // 先写临时文件，再原子替换目标文件：避免写入中途失败留下半截文件破坏既有配置
      await this.fs.writeFile(tmpPath, serialized);
      await this.fs.rename(tmpPath, filePath);
    } catch (error) {
      // 写入任一步失败：内存既有快照保持不变，返回写入失败标识
      return {
        ok: false,
        error: {
          code: 'write-failed',
          message: `持久化配置文件失败：${describeError(error)}`,
        },
      };
    }

    // 写盘成功后才更新内存快照，保证「失败不改变内存状态」
    this.currentState = toPersist;
    return { ok: true };
  }
}

/**
 * 归一化 AppState：只保留已知的中立字段，剔除可能夹带的额外属性，
 * 并对缺失的集合字段兜底为空数组，保证读写结构稳定、且绝不包含明文密钥。
 */
function normalizeAppState(state: AppState): AppState {
  const normalized: AppState = {
    providers: Array.isArray(state?.providers) ? state.providers : [],
    agents: Array.isArray(state?.agents) ? state.agents : [],
  };
  if (state?.activeProviderId !== undefined) {
    normalized.activeProviderId = state.activeProviderId;
  }
  return normalized;
}

/** 把未知错误转换为可读字符串（避免 [object Object] 之类的无信息输出） */
function describeError(error: unknown): string {
  if (error instanceof Error) {
    return error.message;
  }
  if (typeof error === 'string') {
    return error;
  }
  return String(error);
}

/**
 * 工厂函数：创建默认的 ConfigStore 实例。
 *
 * 不传参时使用 Electron userData 目录与 Node fs/promises；
 * 测试可传入 { dataDir, fs } 以完全隔离真实环境。
 */
export function createConfigStore(options: ConfigStoreOptions = {}): ConfigStore {
  return new FileConfigStore(options);
}
