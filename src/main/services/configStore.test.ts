// ConfigStore（配置存储服务）的单元测试
//
// 覆盖需求 1.3、1.4：
// - 1.3：保存 Provider 配置时经 ConfigStore 持久化到应用自有数据目录，
//        且持久化内容「不含明文密钥」（AppState 本就只持有 apiKeyRef 引用）。
// - 1.4：持久化过程发生 I/O 失败时，保留内存中既有状态「不变」，
//        并返回「指示持久化失败的错误标识」。
//
// 测试策略：
// - 注入「内存版 ConfigStoreFs」，不依赖 Electron 运行时，也不读写真实磁盘。
// - 通过 dataDir/fileName 完全隔离路径；内存 fs 以一张 Map 模拟文件系统。
// - 通过给内存 fs 的某个方法植入抛错，模拟读/解析/写各类 I/O 失败。

import { describe, it, expect } from 'vitest';
import type { AppState } from '@shared/types';
import {
  createConfigStore,
  type ConfigStoreFs,
} from './configStore';

// ---------------------------------------------------------------------------
// 内存版文件系统实现：以 Map<绝对路径, 文件内容> 模拟磁盘，供测试注入
// ---------------------------------------------------------------------------

/** 携带 code 的错误，便于模拟 ENOENT 等 Node 风格 I/O 错误 */
class FakeFsError extends Error {
  code: string;
  constructor(code: string, message: string) {
    super(message);
    this.code = code;
  }
}

/** 内存 fs 的可选故障注入钩子：返回 true 的方法将在被调用时抛出指定错误 */
interface FaultHooks {
  /** readFile 调用时抛错（用于模拟读取失败） */
  failRead?: Error;
  /** writeFile 调用时抛错（用于模拟临时文件写入失败） */
  failWrite?: Error;
  /** rename 调用时抛错（用于模拟原子替换失败） */
  failRename?: Error;
  /** ensureDir 调用时抛错（用于模拟目录创建失败） */
  failEnsureDir?: Error;
}

/**
 * 创建一个内存版 ConfigStoreFs 实例。
 *
 * @param files 初始文件内容（键为绝对路径，值为文本内容）
 * @param faults 故障注入钩子
 * @returns 内存 fs 以及用于断言的 files Map 本体
 */
function createMemoryFs(
  files: Map<string, string> = new Map(),
  faults: FaultHooks = {},
): { fs: ConfigStoreFs; files: Map<string, string>; dirs: Set<string> } {
  // 记录被 ensureDir 创建过的目录，便于断言「保存时确保目录存在」
  const dirs = new Set<string>();

  const fs: ConfigStoreFs = {
    async ensureDir(dir: string): Promise<void> {
      if (faults.failEnsureDir) throw faults.failEnsureDir;
      dirs.add(dir);
    },
    async readFile(path: string): Promise<string> {
      if (faults.failRead) throw faults.failRead;
      if (!files.has(path)) {
        // 文件不存在须抛出 ENOENT，交由 ConfigStore 识别为「首次加载」
        throw new FakeFsError('ENOENT', `no such file: ${path}`);
      }
      return files.get(path) as string;
    },
    async writeFile(path: string, data: string): Promise<void> {
      if (faults.failWrite) throw faults.failWrite;
      files.set(path, data);
    },
    async rename(from: string, to: string): Promise<void> {
      if (faults.failRename) throw faults.failRename;
      if (!files.has(from)) {
        throw new FakeFsError('ENOENT', `no such file to rename: ${from}`);
      }
      files.set(to, files.get(from) as string);
      files.delete(from);
    },
  };

  return { fs, files, dirs };
}

/** 测试统一使用的隔离数据目录与文件名 */
const DATA_DIR = '/tmp/llm-switch-test';
const FILE_NAME = 'app-state.json';
const FILE_PATH = `${DATA_DIR}/${FILE_NAME}`;

/** 构造一份带典型内容的 AppState（仅含中立字段，不含任何明文密钥） */
function makeSampleState(): AppState {
  return {
    providers: [
      {
        id: 'p1',
        name: 'openai',
        baseUrl: 'https://api.openai.com',
        // 仅保存引用，绝不保存明文密钥
        apiKeyRef: 'secret://openai/default',
        models: ['gpt-4o-mini', 'gpt-4o'],
        timeoutMs: 8000,
      },
    ],
    agents: [{ agentId: 'opencode', enabled: true }],
    activeProviderId: 'p1',
  };
}

describe('ConfigStore 单元测试（需求 1.3、1.4）', () => {
  describe('load/save 往返', () => {
    it('save 后 load 往返一致', async () => {
      const { fs, files } = createMemoryFs();
      const store = createConfigStore({ dataDir: DATA_DIR, fileName: FILE_NAME, fs });

      const state = makeSampleState();
      const saveResult = await store.saveAppState(state);
      expect(saveResult.ok).toBe(true);

      // 文件应被写到预期的绝对路径
      expect(files.has(FILE_PATH)).toBe(true);

      // 用同一内存 fs 新建一个 store 实例加载，验证内容可完整还原
      const store2 = createConfigStore({ dataDir: DATA_DIR, fileName: FILE_NAME, fs });
      const loadResult = await store2.loadAppState();
      expect(loadResult.ok).toBe(true);
      if (loadResult.ok) {
        expect(loadResult.state).toEqual(state);
      }
    });

    it('save 成功后 getState 快照等于所保存的状态', async () => {
      const { fs } = createMemoryFs();
      const store = createConfigStore({ dataDir: DATA_DIR, fileName: FILE_NAME, fs });

      const state = makeSampleState();
      await store.saveAppState(state);

      expect(store.getState()).toEqual(state);
    });
  });

  describe('首次加载（文件不存在 / ENOENT）', () => {
    it('文件不存在时返回空初始状态并作为内存快照', async () => {
      const { fs } = createMemoryFs(); // 空文件系统
      const store = createConfigStore({ dataDir: DATA_DIR, fileName: FILE_NAME, fs });

      const result = await store.loadAppState();
      expect(result.ok).toBe(true);
      if (result.ok) {
        // 空初始状态：空的 providers / agents，无 activeProviderId
        expect(result.state).toEqual({ providers: [], agents: [] });
      }
      expect(store.getState()).toEqual({ providers: [], agents: [] });
    });
  });

  describe('持久化内容不含明文密钥（需求 1.3）', () => {
    it('写出的 JSON 只含 apiKeyRef 引用，不含任何明文密钥字段', async () => {
      const { fs, files } = createMemoryFs();
      const store = createConfigStore({ dataDir: DATA_DIR, fileName: FILE_NAME, fs });

      const state = makeSampleState();
      await store.saveAppState(state);

      const serialized = files.get(FILE_PATH) as string;
      expect(serialized).toBeTruthy();

      // 应包含中立的引用字段
      expect(serialized).toContain('apiKeyRef');
      expect(serialized).toContain('secret://openai/default');

      // 不应出现任何常见的明文密钥字段名（agent 专属 key 写法一律不进入 AppState）
      for (const forbidden of ['"apiKey"', '"api_key"', '"token"', '"secret"']) {
        expect(serialized.includes(forbidden)).toBe(false);
      }

      // 解析回来结构应与原状态一致，且仍只含引用而非明文
      const parsed = JSON.parse(serialized) as AppState;
      expect(parsed.providers[0].apiKeyRef).toBe('secret://openai/default');
      expect(parsed).not.toHaveProperty('providers.0.apiKey');
    });
  });

  describe('I/O 失败时内存状态不变并返回错误（需求 1.4）', () => {
    it('写入（writeFile）失败：返回 write-failed 且内存快照不变', async () => {
      // 先成功保存一份基线状态，建立非空的内存快照
      const { files } = createMemoryFs();
      const baseline = makeSampleState();

      // 第一步：用可写 fs 建立基线
      const { fs: writableFs } = createMemoryFs(files);
      const store = createConfigStore({
        dataDir: DATA_DIR,
        fileName: FILE_NAME,
        fs: writableFs,
      });
      await store.saveAppState(baseline);
      const snapshotBefore = store.getState();

      // 第二步：替换为「写入必失败」的 fs，再尝试保存一份新状态
      const { fs: failingFs } = createMemoryFs(files, {
        failWrite: new Error('disk full'),
      });
      const failingStore = createConfigStore({
        dataDir: DATA_DIR,
        fileName: FILE_NAME,
        fs: failingFs,
      });
      // 让 failingStore 的内存快照先等于基线（通过一次成功 load）
      await failingStore.loadAppState();

      const changed: AppState = {
        ...baseline,
        providers: [
          { ...baseline.providers[0], name: 'changed', apiKeyRef: 'secret://x' },
        ],
      };
      const result = await failingStore.saveAppState(changed);

      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error.code).toBe('write-failed');
      }
      // 内存快照应仍为基线（未被未落盘的 changed 覆盖）
      expect(failingStore.getState()).toEqual(snapshotBefore);
    });

    it('原子替换（rename）失败：返回 write-failed 且内存快照不变', async () => {
      const files = new Map<string, string>();
      // 预置一份已有文件内容，使 load 得到非空基线
      const baseline = makeSampleState();
      files.set(FILE_PATH, `${JSON.stringify(baseline, null, 2)}\n`);

      const { fs } = createMemoryFs(files, {
        failRename: new Error('rename failed'),
      });
      const store = createConfigStore({ dataDir: DATA_DIR, fileName: FILE_NAME, fs });
      await store.loadAppState();
      const snapshotBefore = store.getState();

      const changed: AppState = { ...baseline, activeProviderId: undefined };
      const result = await store.saveAppState(changed);

      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error.code).toBe('write-failed');
      }
      expect(store.getState()).toEqual(snapshotBefore);
    });

    it('读取（readFile）非 ENOENT 失败：返回 read-failed 且内存快照不变', async () => {
      const { fs } = createMemoryFs(new Map(), {
        failRead: new FakeFsError('EACCES', 'permission denied'),
      });
      const store = createConfigStore({ dataDir: DATA_DIR, fileName: FILE_NAME, fs });
      // 构造前的内存快照为空初始状态
      const snapshotBefore = store.getState();

      const result = await store.loadAppState();
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error.code).toBe('read-failed');
      }
      // 读取失败不应污染既有内存快照
      expect(store.getState()).toEqual(snapshotBefore);
    });

    it('解析（JSON.parse）失败：返回 parse-failed 且内存快照不变', async () => {
      const files = new Map<string, string>();
      // 预置一份已有合法状态，使初次 load 得到非空基线
      const baseline = makeSampleState();
      files.set(FILE_PATH, `${JSON.stringify(baseline, null, 2)}\n`);

      const { fs } = createMemoryFs(files);
      const store = createConfigStore({ dataDir: DATA_DIR, fileName: FILE_NAME, fs });
      // 先成功加载一次，建立非空基线快照
      const first = await store.loadAppState();
      expect(first.ok).toBe(true);
      const snapshotBefore = store.getState();

      // 把文件内容替换为非法 JSON，再次加载应解析失败
      files.set(FILE_PATH, '{ this is not valid json ');
      const result = await store.loadAppState();

      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error.code).toBe('parse-failed');
      }
      // 解析失败不应污染既有内存快照
      expect(store.getState()).toEqual(snapshotBefore);
    });
  });
});
