import { test, expect } from './helpers/fixtures';

// Agent 启用 + 分发预览 + 一键分发（端到端主流程）
//
// 覆盖：右栏启用 agent、顶部「预览」打开预览弹窗并展示掩码 diff、确认并分发、
// 分发报告展示成功计数与每 agent 明细、「完成」关闭；以及「一键分发」直达报告。
//
// 说明：E2E 主进程用 FakeDistributor 返回确定性 preview/report，不写真实 agent 配置。
test.describe('分发预览与一键分发', () => {
  // 前置：建一个 Provider 并启用一个 agent
  test.beforeEach(async ({ app }) => {
    await app.createProvider({
      group: '云平台',
      presetLabel: 'OpenAI',
      name: 'dist-provider',
      apiKey: 'sk-dist-key-123456',
    });
    await expect(app.detailTitle('dist-provider')).toBeVisible();
    await app.enableAgent('opencode');
  });

  test('预览弹窗展示掩码 diff 并可确认分发', async ({ app }) => {
    await app.previewButton().click();
    const dialog = app.previewDialog();
    await expect(dialog).toBeVisible();

    // 掩码提示与 diff 内容（替身 diff 含掩码后的 apiKey 与新 baseUrl）
    await expect(dialog.getByText(/API Key 已掩码/)).toBeVisible();
    await expect(dialog.getByText(/sk-\*\*\*\*MASK/)).toBeVisible();

    // 确认并分发 → 转到分发报告
    await app.confirmDistributeButton().click();
    const report = app.reportDialog();
    await expect(report).toBeVisible();
    await expect(report.getByText(/分发完成/)).toBeVisible();
    // 完成关闭
    await app.reportDoneButton().click();
    await expect(report).toBeHidden();
  });

  test('一键分发直接打开报告并展示成功计数', async ({ app }) => {
    await app.distributeButton().click();
    const report = app.reportDialog();
    await expect(report).toBeVisible();
    await expect(report.getByText(/分发完成/)).toBeVisible();
    // 成功/失败/跳过三项计数（Statistic 标题；替身：1 成功 0 失败 0 跳过）
    await expect(app.reportStatistic('成功')).toBeVisible();
    await expect(app.reportStatistic('失败')).toBeVisible();
    await expect(app.reportStatistic('跳过')).toBeVisible();
    // agent 明细中出现启用的 opencode（条目标题 strong）
    await expect(app.reportAgentEntry('opencode')).toBeVisible();
  });

  test('启用多个 agent 时报告覆盖每个 agent', async ({ app }) => {
    await app.enableAgent('pi');
    await app.distributeButton().click();
    const report = app.reportDialog();
    await expect(report).toBeVisible();
    await expect(app.reportAgentEntry('opencode')).toBeVisible();
    await expect(app.reportAgentEntry('pi')).toBeVisible();
  });
});
