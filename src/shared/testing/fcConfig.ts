// fast-check 公共约定模块
//
// 本模块是全项目所有「基于属性的测试（Property-Based Testing）」的统一入口与约定来源。
// 目的：满足需求 14.4 —— 每个属性测试至少运行 100 次迭代，且引用其对应的设计属性编号。
//
// 使用方式：属性测试一律通过本模块导出的 `fcAssert` 运行，而非直接调用 `fc.assert`，
// 以保证 numRuns（迭代次数）等运行参数在全项目保持一致、可集中调整。

import fc from 'fast-check';

/**
 * 属性测试统一的最小迭代次数。
 *
 * 需求 14.4 规定属性测试每个属性至少运行 100 次迭代，故此处固定为 100。
 * 如需对个别属性加大样本量，可在调用处通过 `overrides.numRuns` 覆盖（只增不减）。
 */
export const PBT_MIN_RUNS = 100;

/**
 * 全项目共享的 fast-check 运行配置。
 *
 * - numRuns：每个属性的迭代次数，统一设为 PBT_MIN_RUNS（>= 100）。
 * - 其余参数沿用 fast-check 默认值，保证最小约束而不过度约束。
 */
export const fcRunConfig: fc.Parameters<unknown> = {
  numRuns: PBT_MIN_RUNS,
};

/**
 * 断言某条属性成立（同步）。
 *
 * 封装 `fc.assert`，自动套用共享运行配置并强制 numRuns >= PBT_MIN_RUNS。
 * 所有同步属性测试都应调用本函数，而不直接调用 `fc.assert`。
 *
 * @param property 由 `fc.property(...)` 构造的属性
 * @param overrides 可选的运行参数覆盖；若指定 numRuns，将取其与 PBT_MIN_RUNS 的较大值
 */
export function fcAssert(
  property: fc.IProperty<unknown>,
  overrides?: fc.Parameters<unknown>,
): void {
  fc.assert(property, mergeConfig(overrides));
}

/**
 * 断言某条异步属性成立。
 *
 * 封装 `fc.assert` 的异步形态，约定同 `fcAssert`。
 *
 * @param property 由 `fc.asyncProperty(...)` 构造的异步属性
 * @param overrides 可选的运行参数覆盖；若指定 numRuns，将取其与 PBT_MIN_RUNS 的较大值
 */
export async function fcAssertAsync(
  property: fc.IAsyncProperty<unknown>,
  overrides?: fc.Parameters<unknown>,
): Promise<void> {
  await fc.assert(property, mergeConfig(overrides));
}

/**
 * 合并共享配置与调用方覆盖项，并保证 numRuns 不低于 PBT_MIN_RUNS。
 *
 * @param overrides 调用方传入的覆盖项
 * @returns 合并后的运行参数
 */
function mergeConfig(overrides?: fc.Parameters<unknown>): fc.Parameters<unknown> {
  const merged: fc.Parameters<unknown> = { ...fcRunConfig, ...overrides };
  // numRuns 只允许向上覆盖（增大样本），不允许低于最小迭代次数
  merged.numRuns = Math.max(PBT_MIN_RUNS, overrides?.numRuns ?? PBT_MIN_RUNS);
  return merged;
}
