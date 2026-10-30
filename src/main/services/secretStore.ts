// 密钥服务（SecretStore）
//
// 本模块封装对「密钥」的保存、解析、删除与掩码展示四类操作，是 API Key 永不明文落盘的
// 关键落点：Provider 配置中只保存中立的 apiKeyRef 引用，真正的明文由本服务存入受保护的
// 后端（生产环境为 Electron safeStorage 加密后持久化；测试环境为可注入的内存实现）。
//
// 设计要点：
// - 对外暴露统一的 SecretStore 接口（对应 design.md 组件 4）：saveSecret / resolveSecret /
//   deleteSecret / getMasked，渲染进程只能经 IPC 间接触达，且永远拿不到明文。
// - 底层「如何持久化」被抽象为可注入的 SecretBackend：生产用 safeStorage 加密 + 文件持久化，
//   测试注入内存后端或直接使用 InMemorySecretStore，从而测试绝不访问真实 OS 凭据库。
// - 错误语义明确（对应需求 2.3 / 2.5）：
//   - 写入失败 → 抛出 code="storage_failure" 的 SecretStoreError，且不保留部分写入；
//   - 解析 / 删除时 keyRef 不存在 → 抛出 code="not_found" 的 SecretStoreError，
//     绝不返回空明文或明文占位（即不以返回 null / "" 的方式掩盖「不存在」）。
// - getMasked 复用 core/mask 的 maskSecret 生成掩码串，从不回传明文。
//
// 安全约束：明文仅在主进程内存中短暂存在；本模块不记录、不打印明文。

import { maskSecret } from "../core/mask";

// ===========================================================================
// 对外接口与错误类型
// ===========================================================================

/**
 * 密钥服务统一接口（对应 design.md 组件 4）。
 *
 * 说明：design.md 中 resolveSecret/getMasked 的签名写作返回可空值，但按需求 2.5，
 * 「keyRef 不存在」必须以明确的错误（code="not_found"）表达，而不能以空明文/空串掩盖。
 * 因此本接口将「不存在」收敛为抛出 SecretStoreError，resolveSecret 的返回恒为非空明文。
 */
export interface SecretStore {
  /**
   * 保存密钥：以 keyRef 为索引写入后端。
   * @throws SecretStoreError code="storage_failure" 写入后端失败（不保留部分写入）
   */
  saveSecret(keyRef: string, apiKey: string): Promise<void>;
  /**
   * 按引用解析出明文密钥（仅主进程内存使用，绝不回传渲染进程）。
   * @returns 对应的明文密钥
   * @throws SecretStoreError code="not_found" keyRef 不存在；storage_failure 后端读取失败
   */
  resolveSecret(keyRef: string): Promise<string>;
  /**
   * 删除密钥。
   * @throws SecretStoreError code="not_found" keyRef 不存在；storage_failure 后端写入失败
   */
  deleteSecret(keyRef: string): Promise<void>;
  /**
   * 返回用于 UI 展示的掩码串（如 "sk-****abcd"），从不回传明文。
   * @returns 掩码串
   * @throws SecretStoreError code="not_found" keyRef 不存在；storage_failure 后端读取失败
   */
  getMasked(keyRef: string): Promise<string>;
}

/** SecretStore 错误码：区分「存储失败」与「keyRef 不存在」两类语义。 */
export type SecretStoreErrorCode = "storage_failure" | "not_found";

/**
 * SecretStore 专用错误：携带可编程判别的 code，便于上层（IPC/分发校验）按语义分类处理，
 * 而不必解析错误消息文本。
 */
export class SecretStoreError extends Error {
  /** 错误语义码 */
  readonly code: SecretStoreErrorCode;
  /** 相关的 keyRef，便于定位 */
  readonly keyRef: string;

  constructor(code: SecretStoreErrorCode, keyRef: string, message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = "SecretStoreError";
    this.code = code;
    this.keyRef = keyRef;
  }
}

// ===========================================================================
// 可注入的后端抽象
// ===========================================================================

/**
 * 密钥后端：抽象「如何持久化密文」这一底层能力，使 SecretStore 与具体存储解耦。
 *
 * 之所以抽象为可注入接口：
 * - 生产环境注入基于 Electron safeStorage + 文件持久化的后端；
 * - 单元测试注入内存后端（或直接用 InMemorySecretStore），从而不依赖真实 OS 凭据库。
 *
 * 约定：后端只负责「存 / 取 / 删 keyRef 对应的明文」，不关心掩码与错误语义——
 * 掩码与「不存在/存储失败」的错误语义由上层 SecretStore 统一处理。后端读取不存在的
 * keyRef 时返回 null；任何底层 I/O / 加解密异常应原样抛出，由上层归类为 storage_failure。
 */
export interface SecretBackend {
  /** 写入（或覆盖）keyRef 对应的明文；失败抛异常 */
  set(keyRef: string, apiKey: string): Promise<void>;
  /** 读取 keyRef 对应的明文；不存在返回 null；底层失败抛异常 */
  get(keyRef: string): Promise<string | null>;
  /** 删除 keyRef；返回是否确实存在并被删除；底层失败抛异常 */
  delete(keyRef: string): Promise<boolean>;
}

// ===========================================================================
// 通用 SecretStore 实现：在任意后端之上统一掩码与错误语义
// ===========================================================================

/**
 * 基于可注入 SecretBackend 的通用 SecretStore 实现。
 *
 * 它把「掩码展示」「不存在/存储失败的错误语义」收敛在一处，复用于 safeStorage 后端与
 * 内存后端，避免每种后端各自重复这部分逻辑。
 */
export class BackedSecretStore implements SecretStore {
  constructor(private readonly backend: SecretBackend) {}

  async saveSecret(keyRef: string, apiKey: string): Promise<void> {
    try {
      await this.backend.set(keyRef, apiKey);
    } catch (err) {
      // 写入后端失败：归类为 storage_failure，调用方据此中止保存、不写入 apiKeyRef
      throw new SecretStoreError(
        "storage_failure",
        keyRef,
        `保存密钥失败：无法写入后端（keyRef=${keyRef}）`,
        { cause: err },
      );
    }
  }

  async resolveSecret(keyRef: string): Promise<string> {
    let value: string | null;
    try {
      value = await this.backend.get(keyRef);
    } catch (err) {
      throw new SecretStoreError(
        "storage_failure",
        keyRef,
        `解析密钥失败：读取后端出错（keyRef=${keyRef}）`,
        { cause: err },
      );
    }
    if (value === null) {
      // 不存在：以明确错误表达，绝不返回空明文占位（对应需求 2.5）
      throw new SecretStoreError("not_found", keyRef, `密钥不存在：keyRef=${keyRef}`);
    }
    return value;
  }

  async deleteSecret(keyRef: string): Promise<void> {
    let existed: boolean;
    try {
      existed = await this.backend.delete(keyRef);
    } catch (err) {
      throw new SecretStoreError(
        "storage_failure",
        keyRef,
        `删除密钥失败：写入后端出错（keyRef=${keyRef}）`,
        { cause: err },
      );
    }
    if (!existed) {
      // 删除不存在的 keyRef：以明确错误表达（对应需求 2.5）
      throw new SecretStoreError("not_found", keyRef, `密钥不存在，无法删除：keyRef=${keyRef}`);
    }
  }

  async getMasked(keyRef: string): Promise<string> {
    // 复用 resolveSecret 的「不存在→not_found」语义；明文仅在本函数内用于生成掩码，随即丢弃
    const plaintext = await this.resolveSecret(keyRef);
    // 调用 core/mask 的 maskSecret，确保回传 UI 的只有掩码串、绝不含明文
    return maskSecret(plaintext);
  }
}

// ===========================================================================
// 内存实现：供测试注入，绝不触达真实 OS 凭据库
// ===========================================================================

/**
 * 内存密钥后端：把明文保存在进程内 Map 中，供测试使用。
 *
 * 仅用于测试/开发注入，不做任何持久化与加密；生产环境应使用 safeStorage 后端。
 */
export class InMemorySecretBackend implements SecretBackend {
  private readonly store = new Map<string, string>();

  /**
   * @param failOnSet 可选：传入时所有 set 调用都抛该错误，用于模拟「写入失败」场景测试
   */
  constructor(private readonly failOnSet?: Error) {}

  async set(keyRef: string, apiKey: string): Promise<void> {
    if (this.failOnSet) {
      throw this.failOnSet;
    }
    this.store.set(keyRef, apiKey);
  }

  async get(keyRef: string): Promise<string | null> {
    return this.store.has(keyRef) ? (this.store.get(keyRef) as string) : null;
  }

  async delete(keyRef: string): Promise<boolean> {
    return this.store.delete(keyRef);
  }
}

/**
 * 内存 SecretStore：BackedSecretStore + InMemorySecretBackend 的便捷组合，供测试直接使用。
 *
 * 用法：`new InMemorySecretStore()` 即可得到一个不触达真实凭据库、具备完整掩码与错误语义的
 * SecretStore；需要模拟写入失败时传入 `failOnSet`。
 */
export class InMemorySecretStore extends BackedSecretStore {
  constructor(options?: { failOnSet?: Error }) {
    super(new InMemorySecretBackend(options?.failOnSet));
  }
}

// ===========================================================================
// Electron safeStorage 后端：生产实现
// ===========================================================================

/**
 * safeStorage 能力的最小接口（对应 Electron 的 safeStorage 模块）。
 *
 * 之所以在此本地声明接口而非直接 import electron：便于在无 Electron 运行时的单元测试里
 * 注入替身，避免测试对 Electron 的硬依赖，也让本模块职责聚焦于「加密/解密 + 持久化」。
 */
export interface SafeStorageLike {
  /** 当前平台的加密是否可用（如 Linux 下 Secret Service 不可用时为 false） */
  isEncryptionAvailable(): boolean;
  /** 加密明文为密文缓冲区 */
  encryptString(plainText: string): Buffer;
  /** 解密密文缓冲区为明文 */
  decryptString(encrypted: Buffer): string;
}

/**
 * 持久化存取：抽象「把 keyRef→密文 的映射读写到磁盘」这一动作。
 *
 * 与 safeStorage 分离，便于单独替身测试持久化逻辑；生产实现通常把映射序列化为 JSON
 * （密文以 base64 编码）写入应用自有数据目录下的文件。
 */
export interface EncryptedStorePersistence {
  /** 读取全部 keyRef→密文(base64) 映射；首次无文件时返回空映射 */
  load(): Promise<Record<string, string>>;
  /** 保存全部 keyRef→密文(base64) 映射（整体覆盖写） */
  save(data: Record<string, string>): Promise<void>;
}

/**
 * 基于 Electron safeStorage 的密钥后端：明文经 safeStorage 加密后以 base64 持久化。
 *
 * 行为：
 * - set：加密明文 → base64 → 更新映射并整体保存；
 * - get：读取映射 → base64 解码 → safeStorage 解密为明文；不存在返回 null；
 * - delete：从映射移除并保存；返回是否确实存在。
 * 任一加解密/持久化失败均抛异常，由上层 BackedSecretStore 归类为 storage_failure。
 *
 * 平台后备（对应需求 2.2 的跨平台凭据管理器）：safeStorage 在 Windows/macOS/Linux 分别
 * 使用 DPAPI / Keychain / Secret Service 提供的密钥加密，密文本身仍落在应用数据目录文件中，
 * 从而「配置文件泄露不等于明文泄露」。
 */
export class SafeStorageSecretBackend implements SecretBackend {
  constructor(
    private readonly safeStorage: SafeStorageLike,
    private readonly persistence: EncryptedStorePersistence,
  ) {}

  async set(keyRef: string, apiKey: string): Promise<void> {
    this.assertEncryptionAvailable();
    const data = await this.persistence.load();
    // 加密为密文缓冲区后以 base64 存储，便于 JSON 序列化
    const encrypted = this.safeStorage.encryptString(apiKey).toString("base64");
    data[keyRef] = encrypted;
    await this.persistence.save(data);
  }

  async get(keyRef: string): Promise<string | null> {
    this.assertEncryptionAvailable();
    const data = await this.persistence.load();
    const encrypted = data[keyRef];
    if (encrypted === undefined) {
      return null;
    }
    // base64 解码回密文缓冲区，再经 safeStorage 解密为明文
    const buffer = Buffer.from(encrypted, "base64");
    return this.safeStorage.decryptString(buffer);
  }

  async delete(keyRef: string): Promise<boolean> {
    const data = await this.persistence.load();
    if (!(keyRef in data)) {
      return false;
    }
    delete data[keyRef];
    await this.persistence.save(data);
    return true;
  }

  /** 加密不可用时直接失败，避免明文落盘（由上层归类为 storage_failure） */
  private assertEncryptionAvailable(): void {
    if (!this.safeStorage.isEncryptionAvailable()) {
      throw new Error("当前平台 safeStorage 加密不可用，拒绝以明文形式存取密钥");
    }
  }
}

/**
 * 便捷工厂：基于 safeStorage 后端构造生产用 SecretStore。
 *
 * 保持依赖可注入——safeStorage 与持久化实现由主进程启动时按运行环境装配后传入，
 * 使本模块无需在导入期硬依赖 electron，也便于测试。
 */
export function createSafeStorageSecretStore(
  safeStorage: SafeStorageLike,
  persistence: EncryptedStorePersistence,
): SecretStore {
  return new BackedSecretStore(new SafeStorageSecretBackend(safeStorage, persistence));
}
