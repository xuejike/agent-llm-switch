import { test, expect } from './helpers/fixtures';

// 应用启动与主界面布局
//
// 覆盖：应用可启动、首窗加载完成、三栏骨架（顶部栏/左/中/右）各区域就绪、
// 初始空态引导文案正确、四个内置 agent 列出。
test.describe('应用启动与布局', () => {
  test('启动后展示顶部栏与主操作按钮', async ({ app }) => {
    // 顶部品牌标题与副标题
    await expect(app.raw.getByText('LLM 配置管理器')).toBeVisible();
    await expect(app.raw.getByText('source of truth')).toBeVisible();
    // 主操作按钮
    await expect(app.previewButton()).toBeVisible();
    await expect(app.distributeButton()).toBeVisible();
  });

  test('左栏展示 PROVIDERS 标题、新增入口与空态', async ({ app }) => {
    await expect(app.raw.getByText('PROVIDERS')).toBeVisible();
    await expect(app.addProviderButton()).toBeVisible();
    // 无任何 Provider 时的空态引导文案
    await expect(app.raw.getByText('暂无 Provider，点击右上角「+」新增')).toBeVisible();
  });

  test('中栏在未选中 Provider 时展示空态引导', async ({ app }) => {
    await expect(
      app.raw.getByText('从左栏选择一个 Provider，或点击「+」新增'),
    ).toBeVisible();
  });

  test('右栏展示 TARGET AGENTS 与四个内置 agent', async ({ app }) => {
    await expect(app.raw.getByText('TARGET AGENTS')).toBeVisible();
    // 四个内置适配器：opencode / pi / workbuddy / codebuddy
    for (const agent of ['opencode', 'pi', 'workbuddy', 'codebuddy']) {
      await expect(
        app.raw.getByRole('listitem').filter({ hasText: agent }).first(),
      ).toBeVisible();
    }
  });
});
