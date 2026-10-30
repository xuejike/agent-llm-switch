import { liveTest as test, expect } from './helpers/fixtures';

// 真实 API 的 GUI 端到端集成测试
//
// 与替身 E2E 不同：本测试在「真实服务」模式（LLM_SWITCH_E2E_LIVE=1）下启动应用，
// 在 UI 里对一个 OpenAI 兼容网关执行「获取模型清单 / 探测可用性」，真实打到网络。
// 它验证完整链路：渲染进程 → preload → 主进程 ModelDiscovery → 真实 fetch → 网关 → 回显 UI。
//
// 运行门控：默认跳过。仅当设置 LLM_SWITCH_LIVE_API=1 且提供 LLM_SWITCH_LIVE_API_KEY 时运行。
//   baseUrl 可用 LLM_SWITCH_LIVE_API_BASE 覆盖，默认 https://llm-admin.csisolar.com。
//
// 安全：API Key 只从环境变量读取，绝不硬编码进仓库。

const LIVE = process.env.LLM_SWITCH_LIVE_API === '1';
const API_KEY = process.env.LLM_SWITCH_LIVE_API_KEY ?? '';
const BASE_URL = process.env.LLM_SWITCH_LIVE_API_BASE ?? 'https://llm-admin.csisolar.com';

// 未开启真实 API 测试时整组跳过
test.describe('真实 API 的 GUI 集成', () => {
  test.skip(!LIVE || !API_KEY, '未设置 LLM_SWITCH_LIVE_API=1 与 LLM_SWITCH_LIVE_API_KEY，跳过真实 API GUI 测试');

  // 真实网络 + 真实网关，放宽超时
  test.setTimeout(120_000);

  test('在 UI 里获取真实模型清单并探测可用性', async ({ app }) => {
    // 1) 新增一个 DeepSeek（OpenAI 兼容）预设的 Provider，baseUrl 指向真实网关、填真实 key
    await app.createProvider({
      group: '云平台',
      presetLabel: 'DeepSeek',
      name: 'live-gateway',
      baseUrl: BASE_URL,
      apiKey: API_KEY,
    });
    await expect(app.detailTitle('live-gateway')).toBeVisible();

    // 2) 点「获取清单」：真实打到 /v1/models，UI 应展示真实候选模型
    await app.fetchModelsButton().click();
    // 成功提示「获取到 N 个候选模型」（N 为真实数量）
    await expect(app.toast(/获取到 \d+ 个候选模型/)).toBeVisible({ timeout: 40_000 });
    // 真实清单应包含已知模型 qwen-plus
    await expect(app.raw.getByText('qwen-plus', { exact: true })).toBeVisible({ timeout: 20_000 });

    // 3) 勾选全部模型并探测可用性：真实打到 /v1/chat/completions
    const headerCheckbox = app.raw.getByRole('columnheader').getByRole('checkbox');
    await headerCheckbox.check();
    await app.probeModelsButton().click();
    // 探测完成提示「探测完成：X/Y 个模型可用」（真实结果）
    await expect(app.toast(/探测完成：\d+\/\d+ 个模型可用/)).toBeVisible({ timeout: 90_000 });

    // 4) 表格里应至少出现一种可用性结论（可用 / 不可用）
    const availableTags = app.raw.getByText('可用', { exact: true });
    const unavailableTags = app.raw.getByText('不可用', { exact: true });
    const total = (await availableTags.count()) + (await unavailableTags.count());
    expect(total).toBeGreaterThan(0);
  });
});
