import { describe, it, expect } from 'vitest';
import fc from 'fast-check';
import { PBT_MIN_RUNS, fcRunConfig, fcAssert, fcAssertAsync } from './fcConfig';

// fast-check 公共约定冒烟测试：
// 验证共享运行配置满足需求 14.4（numRuns >= 100），并验证 fcAssert/fcAssertAsync 封装可用。
describe('fast-check 公共约定', () => {
  it('最小迭代次数不小于 100', () => {
    expect(PBT_MIN_RUNS).toBeGreaterThanOrEqual(100);
    expect(fcRunConfig.numRuns).toBeGreaterThanOrEqual(100);
  });

  it('fcAssert 可运行一条简单属性', () => {
    // 简单属性：整数加 0 恒等于自身
    fcAssert(
      fc.property(fc.integer(), (n) => {
        return n + 0 === n;
      }),
    );
  });

  it('fcAssert 覆盖的 numRuns 不会低于最小迭代次数', () => {
    // 即便调用方传入更小的 numRuns，也会被提升到 PBT_MIN_RUNS
    let count = 0;
    fcAssert(
      fc.property(fc.integer(), () => {
        count += 1;
        return true;
      }),
      { numRuns: 1 },
    );
    expect(count).toBeGreaterThanOrEqual(PBT_MIN_RUNS);
  });

  it('fcAssertAsync 可运行一条简单异步属性', async () => {
    await fcAssertAsync(
      fc.asyncProperty(fc.nat(), async (n) => {
        return n >= 0;
      }),
    );
  });
});
