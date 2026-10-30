import { describe, it, expect } from 'vitest';

// 工程骨架冒烟测试：验证 Vitest 测试运行器可用
// 任务 1.4 建立完整测试约定后，此冒烟测试可被实际用例替代
describe('工程骨架', () => {
  it('Vitest 可正常运行测试', () => {
    expect(1 + 1).toBe(2);
  });
});
