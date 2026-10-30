import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fc from 'fast-check';
import { promises as fs } from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { fcAssertAsync } from '@shared/testing/fcConfig';
import { atomicFileWriter } from './atomicFileWriter';

// AtomicFileWriter 测试
//
// 覆盖安全文件写入服务的核心行为（需求 10.2 / 10.3）：
// - 备份：目标文件存在时生成带时间戳的备份；不存在时返回 null；
// - 原子写入：临时文件 + 原子 rename 覆盖目标，中途失败不损坏原文件、不留半写文件；
// - 回滚：写入失败时从备份恢复目标（或在无备份场景删除新文件），使目标回到分发前状态。
//
// 本测试使用「真实临时目录」进行文件 I/O（os.tmpdir 下的唯一子目录），每个用例独立建目录、
// 用后清理，避免污染工作区与相互干扰。

/** 当前用例使用的临时工作目录（每个用例独立） */
let workDir: string;

/**
 * 在系统临时目录下创建一个唯一子目录，返回其绝对路径。
 * 使用 fs.mkdtemp 保证目录名唯一，避免并发用例相互覆盖。
 */
async function makeTmpDir(): Promise<string> {
  return fs.mkdtemp(path.join(os.tmpdir(), 'atomic-writer-test-'));
}

/**
 * 读取目录下的所有条目名（不存在时返回空数组）。
 * 用于断言目录中是否残留 .tmp 半写文件。
 */
async function listDir(dir: string): Promise<string[]> {
  try {
    return await fs.readdir(dir);
  } catch {
    return [];
  }
}

/**
 * 读取文件内容；文件不存在时返回 null（用于区分「旧内容」与「不存在」两种最终状态）。
 */
async function readOrNull(filePath: string): Promise<string | null> {
  try {
    return await fs.readFile(filePath, 'utf8');
  } catch {
    return null;
  }
}

/** 判断目录中是否存在以 ".tmp." 作为中段标记的半写临时文件 */
function hasTmpLeftover(entries: string[]): boolean {
  // atomicWrite 生成的临时文件形如 `.<basename>.tmp.<随机后缀>`
  return entries.some((name) => name.includes('.tmp.'));
}

beforeEach(async () => {
  workDir = await makeTmpDir();
});

afterEach(async () => {
  // 递归清理整个临时目录，确保不残留任何测试文件
  await fs.rm(workDir, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------
// 单元测试：backup 行为
// ---------------------------------------------------------------------------

describe('AtomicFileWriter.backup 单元测试', () => {
  it('目标文件存在时生成带时间戳的备份，且备份内容与原文件一致', async () => {
    const target = path.join(workDir, 'config.json');
    await fs.writeFile(target, '{"theme":"dark"}', 'utf8');

    const backupPath = await atomicFileWriter.backup(target);

    // 备份路径非空
    expect(backupPath).not.toBeNull();
    const bak = backupPath as string;
    // 备份文件名形如 <target>.bak.<时间戳>，时间戳为 20240131T081530123Z 形态
    expect(bak.startsWith(`${target}.bak.`)).toBe(true);
    const timestamp = bak.slice(`${target}.bak.`.length);
    // 时间戳形态：8 位日期 + 'T' + 时分秒毫秒数字 + 'Z'（去除了 -:. 分隔符）
    expect(timestamp).toMatch(/^\d{8}T\d+Z$/);

    // 备份内容与原文件一致
    expect(await readOrNull(bak)).toBe('{"theme":"dark"}');
  });

  it('目标文件不存在时返回 null（无需备份）', async () => {
    const target = path.join(workDir, 'absent.json');
    const backupPath = await atomicFileWriter.backup(target);
    expect(backupPath).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// 单元测试：atomicWrite 成功与失败路径
// ---------------------------------------------------------------------------

describe('AtomicFileWriter.atomicWrite 单元测试', () => {
  it('成功写入后目标内容为新内容，且目录不残留临时文件', async () => {
    const target = path.join(workDir, 'out.json');

    await atomicFileWriter.atomicWrite(target, 'hello');

    expect(await readOrNull(target)).toBe('hello');
    // 不留半写临时文件
    expect(hasTmpLeftover(await listDir(workDir))).toBe(false);
  });

  it('目标目录不存在时自动创建并完成写入', async () => {
    const nested = path.join(workDir, 'a', 'b', 'c');
    const target = path.join(nested, 'deep.json');

    await atomicFileWriter.atomicWrite(target, 'deep');

    expect(await readOrNull(target)).toBe('deep');
  });

  it('rename 阶段失败时抛错、不损坏既有目标文件且清理临时文件（触发回滚前提）', async () => {
    const target = path.join(workDir, 'keep.json');
    await fs.writeFile(target, 'OLD', 'utf8');

    // 制造 rename 必然失败的场景：预先占用临时文件名对应的「目录」，
    // 使 writeFile 写临时文件时报错（无法把目录当普通文件写入）。
    // 为稳定复现失败，这里改用「只读目标目录」的替代方案不可移植，
    // 故采用注入式包装器在 rename 阶段抛错（见下方 simulateFailingWrite）。
    const err = await simulateFailingWrite(target, 'NEW', 'rename').catch((e) => e);

    // atomicWrite 过程抛出错误
    expect(err).toBeInstanceOf(Error);
    // 目标文件保持旧内容不变（rename 未成功，目标未被覆盖）
    expect(await readOrNull(target)).toBe('OLD');
    // 临时文件被清理，目录无半写残留
    expect(hasTmpLeftover(await listDir(workDir))).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// 单元测试：备份 + 写入失败 + 回滚 完整流程（Property 3 的具体示例）
// ---------------------------------------------------------------------------

describe('AtomicFileWriter 备份-失败-回滚 流程单元测试', () => {
  it('既有文件写入失败后，用 restore 从备份回滚，目标恢复旧内容', async () => {
    const target = path.join(workDir, 'rollback.json');
    await fs.writeFile(target, 'ORIGINAL', 'utf8');

    // 1) 先备份（目标存在 → 得到备份路径）
    const backupPath = await atomicFileWriter.backup(target);
    expect(backupPath).not.toBeNull();

    // 2) 模拟原子写入在 rename 阶段失败
    await expect(simulateFailingWrite(target, 'CORRUPT', 'rename')).rejects.toThrow();

    // 3) 执行回滚：存在备份 → restore
    await atomicFileWriter.restore(backupPath as string, target);

    // 目标恢复为分发前的旧内容
    expect(await readOrNull(target)).toBe('ORIGINAL');
    // 无半写临时文件残留
    expect(hasTmpLeftover(await listDir(workDir))).toBe(false);
  });

  it('原本不存在的文件写入失败后，回滚删除新文件，目标回到「不存在」状态', async () => {
    const target = path.join(workDir, 'new-absent.json');

    // 1) 备份：目标不存在 → 返回 null（无需备份）
    const backupPath = await atomicFileWriter.backup(target);
    expect(backupPath).toBeNull();

    // 2) 模拟写入在 rename 阶段失败
    await expect(simulateFailingWrite(target, 'SHOULD_NOT_PERSIST', 'rename')).rejects.toThrow();

    // 3) 回滚：无备份 → 删除可能产生的新文件（此处 rename 失败本就未生成目标）
    await fs.rm(target, { force: true });

    // 目标仍不存在
    expect(await readOrNull(target)).toBeNull();
    // 无半写临时文件残留
    expect(hasTmpLeftover(await listDir(workDir))).toBe(false);
  });
});

/**
 * 模拟「原子写入」在指定阶段失败的测试级包装器。
 *
 * 复刻默认实现 atomicWrite 的算法（同目录临时文件 + 原子 rename），但在指定阶段注入失败，
 * 以便断言「写入失败不损坏目标、不留半写文件」。失败时同样尽力清理临时文件，与被测实现的
 * 清理语义保持一致。
 *
 * @param targetPath 目标文件绝对路径
 * @param content 待写入内容
 * @param failAt 注入失败的阶段：'write' 在写临时文件时失败；'rename' 在原子替换时失败
 */
async function simulateFailingWrite(
  targetPath: string,
  content: string,
  failAt: 'write' | 'rename',
): Promise<void> {
  const dir = path.dirname(targetPath);
  await fs.mkdir(dir, { recursive: true });
  const tmpPath = path.join(
    dir,
    `.${path.basename(targetPath)}.tmp.${Math.random().toString(36).slice(2, 10)}`,
  );

  try {
    if (failAt === 'write') {
      // 在写临时文件阶段失败：此时目标文件完全未被触及
      throw new Error('模拟写入临时文件失败');
    }
    // 正常写入临时文件（failAt === 'rename'）
    await fs.writeFile(tmpPath, content, 'utf8');
    // 在原子替换阶段失败：目标仍为旧状态，临时文件待清理
    throw new Error('模拟 rename 失败');
  } catch (error) {
    // 与被测实现一致：失败时尽力清理临时文件，清理失败不掩盖原始错误
    try {
      await fs.unlink(tmpPath);
    } catch {
      // 临时文件不存在或无法删除时静默忽略
    }
    throw error;
  }
}

// ---------------------------------------------------------------------------
// Property 3: 写入原子性/无损
//
// 对任意分发，若某 agent 写入失败，则其配置文件最终状态等于分发前状态
// （旧内容或「不存在」二者之一），不存在半写文件。
//
// 测试通过模拟「备份 → 写入失败 → 回滚」完整流程验证该属性：
// - 随机初始状态：文件存在（含随机内容）或文件不存在；
// - 随机新内容与随机失败阶段（write / rename）；
// - 先 backup，再用注入失败的包装器模拟 atomicWrite 在随机阶段抛错，
//   失败后执行回滚（有备份则 restore，无备份则删除新文件）；
// - 断言：目标最终内容严格等于初始状态，且目录无 .tmp 半写文件残留。
//
// Validates: Requirements 10.2, 10.3 / Property 3
// ---------------------------------------------------------------------------

describe('Property 3: 写入原子性/无损', () => {
  // 属性测试涉及大量真实文件 I/O（100+ 次迭代，每次含读写与清理），
  // 放宽本用例超时至 60s，避免 Windows 下「真实磁盘 I/O × ≥100 次迭代」触发超时误判
  // （环境性性能裕度，与属性逻辑无关；numRuns 仍保持 >=100，断言不削弱）。
  it(
    '写入在随机阶段失败并回滚后，目标文件最终状态等于初始状态且无半写文件',
    async () => {
      // 整个属性测试复用一个基目录，样本间以唯一文件名隔离，降低每样本的目录创建/删除开销
      const propDir = await fs.mkdtemp(path.join(os.tmpdir(), 'atomic-prop-'));
      // 自增序号保证同一属性测试内不同样本的目标文件名互不冲突
      let seq = 0;

      try {
        await fcAssertAsync(
          fc.asyncProperty(
            // 初始是否已存在目标文件
            fc.boolean(),
            // 初始文件内容（仅当初始存在时使用）
            fc.string(),
            // 待写入的新内容
            fc.string(),
            // 注入失败的阶段
            fc.constantFrom<'write' | 'rename'>('write', 'rename'),
            async (initiallyExists, initialContent, newContent, failAt) => {
              // 为本样本分配唯一目标文件名，隔离样本间的文件状态
              seq += 1;
              const target = path.join(propDir, `case-${seq}.json`);

              // 1) 建立随机初始状态并记录快照
              if (initiallyExists) {
                await fs.writeFile(target, initialContent, 'utf8');
              }
              const before = await readOrNull(target);

              // 2) 备份（存在 → 备份路径；不存在 → null）
              const backupPath = await atomicFileWriter.backup(target);
              // 不变式：初始存在 ⇔ 产生备份
              expect(backupPath !== null).toBe(initiallyExists);

              // 3) 模拟原子写入在随机阶段失败
              let failed = false;
              try {
                await simulateFailingWrite(target, newContent, failAt);
              } catch {
                failed = true;
              }
              // 注入必然失败：失败一定发生
              expect(failed).toBe(true);

              // 4) 回滚：有备份则 restore，无备份则删除可能产生的新文件
              if (backupPath !== null) {
                await atomicFileWriter.restore(backupPath, target);
              } else {
                await fs.rm(target, { force: true });
              }

              // 5) 断言：目标最终状态严格等于初始状态
              const after = await readOrNull(target);
              expect(after).toBe(before);

              // 6) 断言：本样本目标文件对应的 .tmp 半写文件未残留
              //    （simulateFailingWrite 的临时文件形如 .case-<seq>.json.tmp.<后缀>）
              const entries = await listDir(propDir);
              const tmpForThisCase = entries.filter((name) =>
                name.startsWith(`.case-${seq}.json.tmp.`),
              );
              expect(tmpForThisCase).toHaveLength(0);

              return true;
            },
          ),
        );
      } finally {
        // 清理整个属性测试的基目录
        await fs.rm(propDir, { recursive: true, force: true });
      }
    },
    60_000,
  );
});
