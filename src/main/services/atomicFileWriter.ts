// 安全文件写入服务（AtomicFileWriter）
//
// 本模块提供 agent 配置文件分发时所需的「安全写入」能力，由 Distributor 在
// 分发流程中调用，对应设计文档组件 7 与需求 10.2 / 10.3：
// - backup：写入前先对目标文件创建带时间戳的备份，文件不存在时返回 null；
// - atomicWrite：先把内容完整写入同目录临时文件，再通过原子 rename 覆盖目标，
//   保证写入中途失败不会损坏原文件（不留半写文件）；
// - restore：写入失败时从备份回滚，使目标恢复为分发前状态。
//
// 关键设计约束：
// - 临时文件必须与目标文件位于「同一目录」。rename 的原子性仅在同一文件系统内成立，
//   把临时文件放在目标同目录可最大程度保证二者同盘，从而让 rename 成为原子替换操作。
// - 本模块仅做文件 I/O，不涉及任何明文密钥；写入内容由上游 render 阶段生成。

import { promises as fs } from 'node:fs';
import * as path from 'node:path';

/**
 * 安全文件写入接口。
 *
 * 三个方法共同支撑「备份 → 原子写入 → 失败回滚」的分发写盘流程。
 */
export interface AtomicFileWriter {
  /** 为目标文件创建带时间戳的备份，返回备份路径（文件不存在则返回 null） */
  backup(targetPath: string): Promise<string | null>;

  /** 原子写入：写入临时文件再 rename 覆盖目标，保证中途失败不损坏原文件 */
  atomicWrite(targetPath: string, content: string): Promise<void>;

  /** 从指定备份恢复目标文件 */
  restore(backupPath: string, targetPath: string): Promise<void>;
}

/**
 * 生成文件系统安全的时间戳串，用于备份文件名。
 *
 * 形如 20240131T081530123Z：由 ISO 字符串去除其中的 "-"、":"、"." 等在部分
 * 文件系统中不受欢迎或易混淆的字符而来，仍保留毫秒级精度与 Z（UTC）后缀，
 * 从而在同一目标的多次备份之间保持唯一且可按字典序排序。
 *
 * @returns 适合拼入文件名的时间戳串
 */
function makeTimestamp(): string {
  // 例：2024-01-31T08:15:30.123Z → 20240131T081530123Z
  return new Date().toISOString().replace(/[-:.]/g, '');
}

/**
 * 生成临时文件名的随机后缀，避免并发或重试时临时文件相互覆盖。
 *
 * @returns 短随机字符串
 */
function makeRandomSuffix(): string {
  // 取随机数的 36 进制小数部分，足够在单目录内区分并发写入的临时文件
  return Math.random().toString(36).slice(2, 10);
}

/**
 * 判断错误是否为「文件不存在」（ENOENT）。
 *
 * @param error 捕获到的异常
 * @returns 该错误表示目标不存在时返回 true
 */
function isNotFoundError(error: unknown): boolean {
  return (
    typeof error === 'object' &&
    error !== null &&
    (error as NodeJS.ErrnoException).code === 'ENOENT'
  );
}

/**
 * 基于 Node fs/promises 的默认 AtomicFileWriter 实现。
 *
 * 该实现为无状态对象，可被 Distributor 直接复用；测试可注入实现相同接口的替身
 * 以模拟 rename 失败等异常路径。
 */
export const atomicFileWriter: AtomicFileWriter = {
  /**
   * 为目标文件创建带时间戳的备份。
   *
   * 行为（对应需求 10.2 的「先创建带时间戳的备份」）：
   * - 目标文件存在：复制为 `<targetPath>.bak.<时间戳>` 并返回该备份路径；
   * - 目标文件不存在：说明分发前无既有文件，无需备份，返回 null（上游据此在
   *   回滚时改为删除新写入的文件，使目标恢复「不存在」状态）。
   *
   * @param targetPath 目标文件的绝对路径
   * @returns 备份文件路径；目标不存在时返回 null
   */
  async backup(targetPath: string): Promise<string | null> {
    const backupPath = `${targetPath}.bak.${makeTimestamp()}`;
    try {
      // 使用 copyFile 保留原文件内容；若目标不存在将抛出 ENOENT
      await fs.copyFile(targetPath, backupPath);
      return backupPath;
    } catch (error) {
      // 文件不存在是预期分支：返回 null 表示「无需备份」
      if (isNotFoundError(error)) {
        return null;
      }
      // 其它错误（如权限不足）属于真实故障，向上抛出交由分发流程处理
      throw error;
    }
  },

  /**
   * 原子写入：临时文件 + rename 覆盖。
   *
   * 算法（对应需求 10.2 / 10.3 与设计 atomicWrite 伪代码）：
   * 1. 确保目标目录存在；
   * 2. 在「目标同目录」创建带随机后缀的临时文件并完整写入内容；
   * 3. 通过 rename 原子替换目标；若 rename 前任一步失败，目标保持原样且清理临时文件。
   *
   * 把临时文件放在目标同目录是为了保证与目标同处一个文件系统，使 rename 成为
   * 原子操作（跨文件系统的 rename 会退化为复制，丧失原子性）。
   *
   * @param targetPath 目标文件的绝对路径
   * @param content 要写入的完整内容
   */
  async atomicWrite(targetPath: string, content: string): Promise<void> {
    const dir = path.dirname(targetPath);
    // 确保目标目录存在（递归创建；已存在则为无操作）
    await fs.mkdir(dir, { recursive: true });

    // 临时文件与目标同目录，确保 rename 在同一文件系统内原子生效
    const tmpPath = path.join(dir, `.${path.basename(targetPath)}.tmp.${makeRandomSuffix()}`);

    try {
      // 完整写入临时文件（写失败不会触及目标文件）
      await fs.writeFile(tmpPath, content, 'utf8');
      // 原子替换目标：成功后目标即为新内容，临时文件名随之消失
      await fs.rename(tmpPath, targetPath);
    } catch (error) {
      // 失败时尽力清理遗留的临时文件，避免污染目标目录；
      // 清理本身的失败（如临时文件尚未创建）忽略，不掩盖原始错误
      try {
        await fs.unlink(tmpPath);
      } catch {
        // 临时文件不存在或无法删除时静默忽略
      }
      throw error;
    }
  },

  /**
   * 从备份恢复目标文件（回滚）。
   *
   * 写入过程失败时由分发流程调用：把备份内容复制回目标路径，使目标恢复为
   * 分发前的旧内容。注意「分发前不存在文件」的场景对应 backup 返回 null，
   * 此时上游不会调用 restore，而应改为删除新写入的文件。
   *
   * @param backupPath backup 返回的备份文件路径
   * @param targetPath 需要恢复的目标文件路径
   */
  async restore(backupPath: string, targetPath: string): Promise<void> {
    // 以备份覆盖目标，完成回滚
    await fs.copyFile(backupPath, targetPath);
  },
};
