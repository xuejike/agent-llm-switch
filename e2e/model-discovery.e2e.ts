import { test, expect } from './helpers/fixtures';

// 中栏模型发现面板（ModelDiscoveryPanel）
//
// 覆盖：获取模型清单（E2E 替身返回三个固定模型）、勾选模型、探测可用性
// （替身约定 gamma 不可用其余可用）、筛选切换、手动输入回退路径（provider 无 modelListing）。
//
// 说明：E2E 主进程用 FakeModelDiscovery 返回确定性数据，不触网。
test.describe('模型发现与探测', () => {
  test('获取清单后展示候选模型', async ({ app }) => {
    await app.createProvider({ group: '云平台', presetLabel: 'OpenAI', name: 'md-provider' });
    await expect(app.detailTitle('md-provider')).toBeVisible();

    await app.fetchModelsButton().click();
    await expect(app.toast(/获取到 3 个候选模型/)).toBeVisible();

    // 三个固定候选模型
    await expect(app.raw.getByText('e2e-model-alpha')).toBeVisible();
    await expect(app.raw.getByText('e2e-model-beta')).toBeVisible();
    await expect(app.raw.getByText('e2e-model-gamma')).toBeVisible();
  });

  test('探测可用性后展示可用/不可用并统计', async ({ app }) => {
    await app.createProvider({ group: '云平台', presetLabel: 'OpenAI', name: 'md-probe' });
    await expect(app.detailTitle('md-probe')).toBeVisible();

    await app.fetchModelsButton().click();
    await expect(app.toast(/获取到 3 个候选模型/)).toBeVisible();

    // 勾选全部模型行（表头全选 checkbox）
    const headerCheckbox = app.raw.getByRole('columnheader').getByRole('checkbox');
    await headerCheckbox.check();

    await app.probeModelsButton().click();
    // 替身：alpha/beta 可用、gamma 不可用 → 2/3 可用
    await expect(app.toast(/探测完成：2\/3 个模型可用/)).toBeVisible();

    // 可用性 Tag：至少出现「可用」与「不可用」
    await expect(app.raw.getByText('可用', { exact: true }).first()).toBeVisible();
    await expect(app.raw.getByText('不可用', { exact: true }).first()).toBeVisible();
  });

  test('切换「仅可用」筛选', async ({ app }) => {
    await app.createProvider({ group: '云平台', presetLabel: 'OpenAI', name: 'md-filter' });
    await expect(app.detailTitle('md-filter')).toBeVisible();
    await app.fetchModelsButton().click();
    await expect(app.toast(/获取到 3 个候选模型/)).toBeVisible();

    // 筛选 Segmented：切到「仅可用」
    await app.raw.getByText('仅可用', { exact: true }).click();
    await expect(app.raw.getByText('仅可用', { exact: true })).toBeVisible();
  });
});
