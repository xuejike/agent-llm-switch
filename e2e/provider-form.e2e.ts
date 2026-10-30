import { test, expect } from './helpers/fixtures';

// 中栏 API 配置表单（ProviderForm）编辑与密钥保存
//
// 覆盖：选中 Provider 后展示 API 配置卡、编辑名称/baseUrl/超时并自动持久化、
// 保存 API Key 显示掩码、空输入保存密钥给出警告。
test.describe('API 配置表单', () => {
  // 每条用例先建一个云 Provider 作为前置（带 apiKey 以分配 apiKeyRef，才能保存/更新密钥）
  test.beforeEach(async ({ app }) => {
    await app.createProvider({
      group: '云平台',
      presetLabel: 'OpenAI',
      name: 'form-provider',
      apiKey: 'sk-initial-key-000000',
    });
    await expect(app.detailTitle('form-provider')).toBeVisible();
  });

  test('展示 API 配置卡与各字段', async ({ app }) => {
    await expect(app.raw.getByText('API 配置')).toBeVisible();
    await expect(app.formNameInput()).toBeVisible();
    await expect(app.formBaseUrlInput()).toBeVisible();
    await expect(app.formTimeoutInput()).toBeVisible();
    await expect(app.saveSecretButton()).toBeVisible();
  });

  test('编辑名称后左栏列表同步更新', async ({ app }) => {
    const nameInput = app.formNameInput();
    await nameInput.fill('form-provider-renamed');
    // 触发 blur 以确保 onValuesChange 提交
    await app.formBaseUrlInput().click();

    // 左栏该 Provider 名称更新
    await expect(app.providerListItem('form-provider-renamed')).toBeVisible();
  });

  test('编辑 Base URL 并持久化', async ({ app }) => {
    const baseUrl = app.formBaseUrlInput();
    await baseUrl.fill('https://custom.gateway.example.com/v1');
    await app.formNameInput().click();
    await expect(baseUrl).toHaveValue('https://custom.gateway.example.com/v1');
  });

  test('保存 API Key 后展示掩码且清空输入框', async ({ app }) => {
    // API Key 输入框（ProviderForm 内的密码框，placeholder 含「保存」）
    const keyInput = app.apiKeyInput();
    await keyInput.fill('sk-secret-value-abcdef123456');
    await app.saveSecretButton().click();

    // 成功 toast
    await expect(app.toast(/API Key 已安全保存/)).toBeVisible();
    // 掩码展示（label 旁的「当前：」），且掩码串不等于明文（不泄露明文）
    await expect(app.raw.getByText('当前：')).toBeVisible();
    await expect(app.raw.getByText('sk-secret-value-abcdef123456')).toHaveCount(0);
  });

  test('空输入点保存密钥给出警告', async ({ app }) => {
    await app.saveSecretButton().click();
    await expect(app.toast(/请先输入 API Key/)).toBeVisible();
  });
});
