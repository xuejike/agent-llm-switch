import { test, expect } from './helpers/fixtures';

// 多语言（中英文）切换验证
//
// 覆盖：默认中文界面；通过顶部语言切换切到 English 后，关键 UI 文案变为英文；
// 再切回中文恢复。验证 i18n 基础设施与 antd locale 同步生效。
test.describe('多语言切换', () => {
  test('默认中文，切换到 English 后界面文案变英文', async ({ app }) => {
    const page = app.raw;

    // 默认中文：顶部按钮为「预览 / 一键分发」
    await expect(page.getByRole('banner').getByRole('button', { name: '预览' })).toBeVisible();
    await expect(page.getByRole('banner').getByRole('button', { name: '一键分发' })).toBeVisible();
    // 左栏分区标题中文空态
    await expect(page.getByText('暂无 Provider，点击右上角「+」新增')).toBeVisible();

    // 切换到 English（顶部语言 Segmented）
    await page.getByRole('banner').getByText('English', { exact: true }).click();

    // 顶部按钮变英文
    await expect(page.getByRole('banner').getByRole('button', { name: 'Preview' })).toBeVisible();
    await expect(page.getByRole('banner').getByRole('button', { name: 'Distribute' })).toBeVisible();
    // 左栏空态变英文
    await expect(
      page.getByText('No providers yet. Click "+" in the top-right to add one.'),
    ).toBeVisible();
    // 中栏空态变英文
    await expect(page.getByText('Select a provider on the left, or click "+" to add one.')).toBeVisible();

    // 切回中文
    await page.getByRole('banner').getByText('简体中文', { exact: true }).click();
    await expect(page.getByRole('banner').getByRole('button', { name: '预览' })).toBeVisible();
  });

  test('英文界面下新增 Provider 弹窗为英文', async ({ app }) => {
    const page = app.raw;
    // 切到英文
    await page.getByRole('banner').getByText('English', { exact: true }).click();

    // 打开新增弹窗（aria-label 已英文化为 "Add provider"）
    await page.getByLabel('Add provider').click();
    const dialog = page.getByRole('dialog').filter({ hasText: 'Add provider' });
    await expect(dialog).toBeVisible();
    // 分组与按钮英文
    await expect(dialog.getByText('Cloud', { exact: true })).toBeVisible();
    await expect(dialog.getByText('Local', { exact: true })).toBeVisible();
    await expect(dialog.getByRole('button', { name: 'Save provider' })).toBeVisible();
  });
});
