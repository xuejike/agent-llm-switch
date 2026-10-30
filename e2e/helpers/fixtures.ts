import { test as base, expect } from '@playwright/test';
import { launchApp, type LaunchResult } from './launch';
import { AppPage } from './appPage';

// 自定义 Playwright fixtures
//
// 为每条用例自动启动一个隔离的 Electron 实例（独立临时数据目录），并在用例结束后关闭
// 应用、删除临时目录。用例直接拿到 electronApp（句柄）、page（首窗）、appPage（页面对象）。
//
// 用法：在测试文件里 `import { test, expect } from '../helpers/fixtures'`。
type Fixtures = {
  /** 本次用例的启动结果（含 app / page / dataDir / close） */
  electronApp: LaunchResult;
  /** 便捷别名：首个渲染窗口 */
  app: AppPage;
};

export const test = base.extend<Fixtures>({
  // eslint-disable-next-line no-empty-pattern
  electronApp: async ({}, use) => {
    const launched = await launchApp();
    try {
      await use(launched);
    } finally {
      await launched.close();
    }
  },

  app: async ({ electronApp }, use) => {
    await use(new AppPage(electronApp.page));
  },
});

// 「真实服务」变体：以 live 模式启动（真实 fetch 打到配置的网关）。
// 用于真实 API 的 GUI 集成测试；与上面的替身 test 互不干扰。
export const liveTest = base.extend<Fixtures>({
  // eslint-disable-next-line no-empty-pattern
  electronApp: async ({}, use) => {
    const launched = await launchApp({ live: true });
    try {
      await use(launched);
    } finally {
      await launched.close();
    }
  },

  app: async ({ electronApp }, use) => {
    await use(new AppPage(electronApp.page));
  },
});

export { expect };
