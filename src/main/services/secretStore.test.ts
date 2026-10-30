// SecretStore 密钥服务的单元测试
//
// 本测试用「内存实现」（InMemorySecretStore / InMemorySecretBackend）覆盖 SecretStore 的
// 四项核心操作及其错误语义，全程不触达真实 OS 凭据库、不访问外网。
//
// 覆盖需求：
// - 2.3：写入操作系统凭据管理器失败 → 返回「存储失败」错误标识（code="storage_failure"）。
// - 2.4：SecretStore 提供「保存 / 解析 / 删除 / 掩码」四项操作（往返验证）。
// - 2.5：解析 / 删除未找到 keyRef → 返回「不存在」错误（code="not_found"），
//        且不返回明文或空明文占位。
//
// 另附密钥不泄露断言：getMasked 返回掩码串且不包含明文中段字符（支撑 2.4 的掩码语义）。

import { describe, it, expect } from 'vitest';
import {
  InMemorySecretStore,
  BackedSecretStore,
  InMemorySecretBackend,
  SecretStoreError,
} from './secretStore';

// 测试用固定 keyRef 与明文密钥：明文足够长（>= 8）以便验证掩码保留前 4 后 4 的结构。
const KEY_REF = 'provider-openai-key';
const PLAINTEXT = 'sk-1234567890abcdef'; // 长度 19，属长串，中段将被掩码

describe('SecretStore 保存 / 解析 / 删除 / 掩码 往返（需求 2.4）', () => {
  it('保存后可解析出原始明文（save → resolve 往返）', async () => {
    const store = new InMemorySecretStore();
    await store.saveSecret(KEY_REF, PLAINTEXT);

    // 解析应返回与保存一致的明文
    const resolved = await store.resolveSecret(KEY_REF);
    expect(resolved).toBe(PLAINTEXT);
  });

  it('覆盖写入：同一 keyRef 再次保存后解析得到新明文', async () => {
    const store = new InMemorySecretStore();
    await store.saveSecret(KEY_REF, PLAINTEXT);
    await store.saveSecret(KEY_REF, 'sk-newnewnewnew9999');

    const resolved = await store.resolveSecret(KEY_REF);
    expect(resolved).toBe('sk-newnewnewnew9999');
  });

  it('删除后再解析应抛出 not_found（delete 生效）', async () => {
    const store = new InMemorySecretStore();
    await store.saveSecret(KEY_REF, PLAINTEXT);

    // 删除存在的 keyRef 应正常完成
    await expect(store.deleteSecret(KEY_REF)).resolves.toBeUndefined();

    // 删除后该 keyRef 不复存在，解析应报 not_found
    await expect(store.resolveSecret(KEY_REF)).rejects.toMatchObject({
      name: 'SecretStoreError',
      code: 'not_found',
      keyRef: KEY_REF,
    });
  });

  it('getMasked 返回掩码串：保留前 4 后 4、等长，且不含明文中段字符（需求 2.4 掩码语义）', async () => {
    const store = new InMemorySecretStore();
    await store.saveSecret(KEY_REF, PLAINTEXT);

    const masked = await store.getMasked(KEY_REF);

    // 掩码串与原明文等长，且保留前 4 后 4
    expect(masked.length).toBe(PLAINTEXT.length);
    expect(masked.startsWith(PLAINTEXT.slice(0, 4))).toBe(true);
    expect(masked.endsWith(PLAINTEXT.slice(-4))).toBe(true);

    // 关键：掩码串整体不等于明文，且中段区域被掩码（不泄露明文中段）
    expect(masked).not.toBe(PLAINTEXT);
    const originalMiddle = PLAINTEXT.slice(4, -4);
    const maskedMiddle = masked.slice(4, masked.length - 4);
    expect(maskedMiddle).toBe('*'.repeat(originalMiddle.length));
    // 逐字符断言：原始中段的每个字符都不出现在掩码的中段区域
    for (const ch of originalMiddle) {
      expect(maskedMiddle.includes(ch)).toBe(false);
    }
  });
});

describe('SecretStore 写入失败语义（需求 2.3）', () => {
  it('后端写入失败时 saveSecret 抛 storage_failure，且不保留任何写入', async () => {
    // 注入 failOnSet：模拟底层凭据管理器写入失败
    const store = new InMemorySecretStore({ failOnSet: new Error('凭据管理器不可用') });

    await expect(store.saveSecret(KEY_REF, PLAINTEXT)).rejects.toMatchObject({
      name: 'SecretStoreError',
      code: 'storage_failure',
      keyRef: KEY_REF,
    });

    // 验证确为 SecretStoreError 实例，且保留底层错误作为 cause
    const error = await store.saveSecret(KEY_REF, PLAINTEXT).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(SecretStoreError);
    expect((error as SecretStoreError).cause).toBeInstanceOf(Error);
  });

  it('写入失败后该 keyRef 不存在：后续解析应报 not_found（未产生部分写入）', async () => {
    // 复用同一内存后端，确保「写入失败」与「随后解析」作用于同一存储
    const backend = new InMemorySecretBackend(new Error('凭据管理器不可用'));
    const store = new BackedSecretStore(backend);

    await expect(store.saveSecret(KEY_REF, PLAINTEXT)).rejects.toMatchObject({
      code: 'storage_failure',
    });

    // 写入既然失败，keyRef 不应被写入，解析应报不存在
    await expect(store.resolveSecret(KEY_REF)).rejects.toMatchObject({
      code: 'not_found',
    });
  });
});

describe('SecretStore keyRef 不存在语义（需求 2.5）', () => {
  it('解析不存在的 keyRef 抛 not_found，且不返回明文或空明文占位', async () => {
    const store = new InMemorySecretStore();

    // 不应 resolve 出任何值（null / 空串都不允许），而应 reject 为 not_found
    await expect(store.resolveSecret('absent')).rejects.toMatchObject({
      name: 'SecretStoreError',
      code: 'not_found',
      keyRef: 'absent',
    });
  });

  it('删除不存在的 keyRef 抛 not_found', async () => {
    const store = new InMemorySecretStore();

    await expect(store.deleteSecret('absent')).rejects.toMatchObject({
      name: 'SecretStoreError',
      code: 'not_found',
      keyRef: 'absent',
    });
  });

  it('getMasked 不存在的 keyRef 抛 not_found（不返回空掩码占位）', async () => {
    const store = new InMemorySecretStore();

    await expect(store.getMasked('absent')).rejects.toMatchObject({
      name: 'SecretStoreError',
      code: 'not_found',
      keyRef: 'absent',
    });
  });
});
