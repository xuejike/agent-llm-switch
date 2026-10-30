import { test, expect } from './helpers/fixtures';

// 新增 Provider（Add Provider 弹窗）与左栏列表
//
// 覆盖：打开弹窗、云/本地分组切换、选预设自动预填、表单填写、保存、
// 新 Provider 出现在左栏并被选中、中栏展示其详情、本地 provider 的 local 徽标。
test.describe('新增 Provider', () => {
  test('打开新增弹窗并展示预设与表单', async ({ app }) => {
    await app.addProviderButton().click();
    const dialog = app.addProviderDialog();
    await expect(dialog).toBeVisible();

    // 云/本地分组
    await expect(dialog.getByText('云平台', { exact: true })).toBeVisible();
    await expect(dialog.getByText('本地平台', { exact: true })).toBeVisible();
    // 几个代表性预设 chip
    await expect(dialog.getByText('OpenAI', { exact: true })).toBeVisible();
    await expect(dialog.getByText('Anthropic', { exact: true })).toBeVisible();
    // 表单字段（用 placeholder 定位，稳健且不受 label 关联影响）
    await expect(dialog.getByPlaceholder('openai', { exact: true })).toBeVisible();
    await expect(dialog.getByPlaceholder('https://api.openai.com')).toBeVisible();
  });

  test('创建一个云 Provider 后出现在左栏并被选中', async ({ app }) => {
    await app.createProvider({
      group: '云平台',
      presetLabel: 'OpenAI',
      name: 'my-openai',
      apiKey: 'sk-e2e-test-key-123456',
    });

    // 成功 toast
    await expect(app.toast(/已新增 Provider/)).toBeVisible();
    // 左栏出现该 Provider
    await expect(app.providerListItem('my-openai')).toBeVisible();
    // 中栏详情头部显示其名称（创建后自动选中）
    await expect(app.detailTitle('my-openai')).toBeVisible();
  });

  test('切换到本地平台并创建本地 Provider（带 local 徽标）', async ({ app }) => {
    await app.createProvider({
      group: '本地平台',
      presetLabel: 'Ollama（本地）',
      name: 'my-ollama',
    });

    await expect(app.providerListItem('my-ollama')).toBeVisible();
    // 本地 provider 左栏有「本地」徽标（中文界面）
    await expect(app.raw.getByText('本地', { exact: true }).first()).toBeVisible();
  });

  test('选预设会把 Base URL 预填为预设默认值', async ({ app }) => {
    await app.addProviderButton().click();
    const dialog = app.addProviderDialog();
    await dialog.getByText('云平台', { exact: true }).click();
    await dialog.getByText('OpenAI', { exact: true }).click();

    // OpenAI 预设 baseUrl 默认 https://api.openai.com
    await expect(dialog.getByPlaceholder('https://api.openai.com')).toHaveValue(
      'https://api.openai.com',
    );
  });

  test('未选预设直接保存会提示先选预设', async ({ app }) => {
    await app.addProviderButton().click();
    const dialog = app.addProviderDialog();
    await expect(dialog).toBeVisible();
    // 不选任何预设，直接点保存
    await dialog.getByRole('button', { name: '保存 Provider' }).click();
    await expect(app.toast(/请先选择一个平台预设/)).toBeVisible();
  });
});
