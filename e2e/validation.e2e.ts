import { test, expect } from './helpers/fixtures';

// 表单校验与操作前置校验（边界场景）
//
// 覆盖：新增弹窗 name/baseUrl 必填校验、非法 URL 校验、
// 未选 Provider 点预览/分发的警告、未勾选 agent 的警告。
test.describe('校验与边界', () => {
  test('新增弹窗：已选预设但缺少必填项时阻止保存', async ({ app }) => {
    await app.addProviderButton().click();
    const dialog = app.addProviderDialog();
    await dialog.getByText('云平台', { exact: true }).click();
    await dialog.getByText('OpenAI', { exact: true }).click();

    // 清空名称后保存，应出现必填错误且弹窗不关闭
    await dialog.getByPlaceholder('openai', { exact: true }).fill('');
    await dialog.getByRole('button', { name: '保存 Provider' }).click();

    await expect(dialog.getByText('请填写 Provider 名称')).toBeVisible();
    await expect(dialog).toBeVisible();
  });

  test('新增弹窗：非法 Base URL 被拒绝', async ({ app }) => {
    await app.addProviderButton().click();
    const dialog = app.addProviderDialog();
    await dialog.getByText('云平台', { exact: true }).click();
    await dialog.getByText('OpenAI', { exact: true }).click();

    await dialog.getByPlaceholder('openai', { exact: true }).fill('bad-url-provider');
    await dialog.getByPlaceholder('https://api.openai.com').fill('not-a-valid-url');
    await dialog.getByRole('button', { name: '保存 Provider' }).click();

    // 校验错误消息（精确到 explain-error 文案，避免匹配到 label「Base URL」）
    await expect(dialog.locator('.ant-form-item-explain-error')).toContainText('Base URL');
    await expect(dialog).toBeVisible();
  });

  test('未选中 Provider 点「预览」给出警告', async ({ app }) => {
    await app.previewButton().click();
    await expect(app.toast(/请先在左栏选择一个 Provider/)).toBeVisible();
  });

  test('未选中 Provider 点「一键分发」给出警告', async ({ app }) => {
    await app.distributeButton().click();
    await expect(app.toast(/请先在左栏选择一个 Provider/)).toBeVisible();
  });

  test('已选 Provider 但未勾选 agent 点「预览」给出警告', async ({ app }) => {
    await app.createProvider({ group: '云平台', presetLabel: 'OpenAI', name: 'no-agent' });
    await expect(app.detailTitle('no-agent')).toBeVisible();

    await app.previewButton().click();
    await expect(app.toast(/请在右栏勾选至少一个启用的目标 agent/)).toBeVisible();
  });
});
