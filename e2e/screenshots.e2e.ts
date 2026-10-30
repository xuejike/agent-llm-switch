import { test, expect } from './helpers/fixtures';
import type { Page } from '@playwright/test';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { mkdirSync } from 'node:fs';

// 功能截图生成器（同时作为一次完整主流程的冒烟测试）
//
// 驱动替身模式下的真实应用，构造典型数据后对各功能界面截图：
//   - 中文界面 → docs/screenshots/*.png（供中文 README）
//   - 英文界面 → docs/screenshots/en/*.png（供英文 README）
// 确定性替身保证截图内容稳定可复现。
//
// 运行：pnpm test:e2e 或 pnpm exec playwright test screenshots.e2e.ts
const __dirname = dirname(fileURLToPath(import.meta.url));
const SHOT_DIR = resolve(__dirname, '..', 'docs', 'screenshots');
const SHOT_DIR_EN = resolve(SHOT_DIR, 'en');

/** 某语言界面下用到的文案（截图流程按语言取不同选择器文本） */
interface Strings {
  group: string; // Segmented 分组标签（云平台 / Cloud）
  ollamaPreset: string; // Ollama 预设 displayName（品牌名，两语言一致）
  apiKeyPlaceholder: string; // 新增弹窗 API Key 输入框 placeholder
  saveProvider: string; // 新增弹窗保存按钮
  fetchedToast: RegExp; // 获取清单成功 toast
  probeDoneToast: RegExp; // 探测完成 toast
  previewTitle: string; // 预览弹窗标题（用于 dialog 过滤）
  reportTitle: string; // 报告弹窗标题
  distributeDoneText: RegExp; // 报告「分发完成」文本
  confirmBtn: string; // 预览弹窗「确认并分发」
}

const ZH: Strings = {
  group: '云平台',
  ollamaPreset: 'Ollama（本地）',
  apiKeyPlaceholder: '粘贴密钥 — 存入系统凭据库',
  saveProvider: '保存 Provider',
  fetchedToast: /获取到 3 个候选模型/,
  probeDoneToast: /探测完成/,
  previewTitle: '分发预览 Diff',
  reportTitle: '分发报告',
  distributeDoneText: /分发完成/,
  confirmBtn: '确认并分发',
};

const EN: Strings = {
  group: 'Cloud',
  ollamaPreset: 'Ollama（本地）',
  apiKeyPlaceholder: 'paste key — stored in OS keychain',
  saveProvider: 'Save provider',
  fetchedToast: /Fetched 3 candidate model\(s\)/,
  probeDoneToast: /Probe done/,
  previewTitle: 'Distribute preview (diff)',
  reportTitle: 'Distribute report',
  distributeDoneText: /Distribution complete/,
  confirmBtn: 'Confirm & distribute',
};

test.beforeAll(() => {
  mkdirSync(SHOT_DIR, { recursive: true });
  mkdirSync(SHOT_DIR_EN, { recursive: true });
});

/**
 * 完整主流程截图：新增 Provider 弹窗 → 主界面 → 模型发现 → 预览 → 报告。
 * 不复用 AppPage 的中文方法（它硬编码中文选择器），而是按 lang 用对应文案内联定位，
 * 以便同一流程既能截中文界面也能截英文界面。
 */
async function captureFlow(page: Page, s: Strings, outDir: string): Promise<void> {
  // 1) 新增 Provider 弹窗（云平台 + OpenAI 预设，已填字段）
  await page.getByLabel(s.group === 'Cloud' ? 'Add provider' : '新增 Provider').click();
  const dialog = page
    .getByRole('dialog')
    .filter({ hasText: s.group === 'Cloud' ? 'Add provider' : '新增 Provider' });
  await expect(dialog).toBeVisible();
  await dialog.getByText(s.group, { exact: true }).click();
  await dialog.getByText('OpenAI', { exact: true }).click();
  await dialog.getByPlaceholder('openai', { exact: true }).fill('OpenAI Production');
  await dialog.getByPlaceholder(s.apiKeyPlaceholder).fill('sk-demo-key-xxxxxxxxxxxx');
  await page.waitForTimeout(300);
  await page.screenshot({ path: resolve(outDir, '02-add-provider.png') });
  await dialog.getByRole('button', { name: s.saveProvider }).click();
  await expect(dialog).toBeHidden();

  // 再建一个本地 Provider，让左栏更丰富（Ollama 预设的 displayName 两语言一致）
  await page.getByLabel(s.group === 'Cloud' ? 'Add provider' : '新增 Provider').click();
  const dialog2 = page
    .getByRole('dialog')
    .filter({ hasText: s.group === 'Cloud' ? 'Add provider' : '新增 Provider' });
  await dialog2.getByText(s.group === 'Cloud' ? 'Local' : '本地平台', { exact: true }).click();
  await dialog2.getByText(s.ollamaPreset, { exact: true }).click();
  await dialog2.getByPlaceholder('openai', { exact: true }).fill('Ollama Local');
  await dialog2.getByRole('button', { name: s.saveProvider }).click();
  await expect(dialog2).toBeHidden();

  // 选回第一个 provider 作为主截图对象
  await page.getByRole('complementary').filter({ hasText: 'PROVIDERS' })
    .getByText('OpenAI Production', { exact: true }).click();
  await expect(page.getByRole('heading', { name: 'OpenAI Production', exact: true })).toBeVisible();

  // 2) 获取模型清单 + 探测可用性（替身返回确定性数据）
  const fetchBtn = s.group === 'Cloud' ? 'Fetch list' : '获取清单';
  const probeBtn = s.group === 'Cloud' ? 'Probe availability' : '探测可用性';
  await page.getByRole('button', { name: fetchBtn }).click();
  await expect(page.locator('.ant-message').getByText(s.fetchedToast)).toBeVisible();
  await page.getByRole('columnheader').getByRole('checkbox').check();
  await page.getByRole('button', { name: probeBtn }).click();
  await expect(page.locator('.ant-message').getByText(s.probeDoneToast)).toBeVisible();

  // 等待 toast 消散，避免遮挡主界面
  await page.locator('.ant-message-notice').last().waitFor({ state: 'detached', timeout: 8000 }).catch(() => {});
  // 等待右栏 agent 列表加载完成（切换语言会触发重渲染并重新 listAgents），
  // 否则主界面截图可能停留在「加载 agent…」态
  await page
    .getByRole('complementary')
    .filter({ hasText: 'TARGET AGENTS' })
    .getByRole('listitem')
    .filter({ hasText: 'opencode' })
    .first()
    .waitFor({ state: 'visible', timeout: 10000 });
  await page.waitForTimeout(500);

  // 主界面全景 + 模型面板
  await page.screenshot({ path: resolve(outDir, '01-main.png') });
  await page.screenshot({ path: resolve(outDir, '03-model-discovery.png') });

  // 启用两个 agent
  for (const agent of ['opencode', 'pi']) {
    const sw = page
      .getByRole('complementary')
      .filter({ hasText: 'TARGET AGENTS' })
      .getByRole('listitem')
      .filter({ hasText: agent })
      .getByRole('switch')
      .first();
    if ((await sw.getAttribute('aria-checked')) !== 'true') {
      await sw.click();
    }
  }

  // 4) 分发预览 Diff 弹窗
  const previewBtn = s.group === 'Cloud' ? 'Preview' : '预览';
  await page.getByRole('banner').getByRole('button', { name: previewBtn }).click();
  const preview = page.getByRole('dialog').filter({ hasText: s.previewTitle });
  await expect(preview).toBeVisible();
  await expect(preview.getByText(/sk-\*\*\*\*MASK/)).toBeVisible();
  await page.waitForTimeout(300);
  await page.screenshot({ path: resolve(outDir, '04-preview-diff.png') });

  // 5) 确认并分发 → 分发报告弹窗
  await preview.getByRole('button', { name: s.confirmBtn }).click();
  const report = page.getByRole('dialog').filter({ hasText: s.reportTitle });
  await expect(report).toBeVisible();
  await expect(report.getByText(s.distributeDoneText)).toBeVisible();
  await page.waitForTimeout(300);
  await page.screenshot({ path: resolve(outDir, '05-distribute-report.png') });
}

test('生成中文界面功能截图', async ({ electronApp }) => {
  await captureFlow(electronApp.page, ZH, SHOT_DIR);
});

test('生成英文界面功能截图', async ({ electronApp }) => {
  const page = electronApp.page;
  // 先把界面切到 English（顶部语言 Segmented），再按英文文案走同一流程
  await page.getByRole('banner').getByText('English', { exact: true }).click();
  await expect(page.getByRole('banner').getByRole('button', { name: 'Preview' })).toBeVisible();
  await captureFlow(page, EN, SHOT_DIR_EN);
});
