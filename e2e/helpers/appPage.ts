import { expect, type Page } from '@playwright/test';

// 应用页面对象（Page Object）
//
// 把三栏主界面与各弹窗的「可定位元素 + 常用操作」集中封装，使测试用例聚焦于「做什么」
// 而非「怎么点」。所有选择器优先用语义定位（role/label/文本），与界面中文文案一致。
export class AppPage {
  constructor(private readonly page: Page) {}

  /** 暴露底层 Page，便于用例做自定义定位（非封装操作场景） */
  get raw(): Page {
    return this.page;
  }

  // ---------------------------------------------------------------------------
  // 顶部栏（Header）
  // ---------------------------------------------------------------------------

  /** 顶部「预览」按钮（banner 区域，避免匹配弹窗内同名文本） */
  previewButton() {
    return this.page.getByRole('banner').getByRole('button', { name: '预览' });
  }

  /** 顶部「一键分发」按钮 */
  distributeButton() {
    return this.page.getByRole('banner').getByRole('button', { name: '一键分发' });
  }

  // ---------------------------------------------------------------------------
  // 左栏：Provider 列表
  // ---------------------------------------------------------------------------

  /** 「新增 Provider」入口（左栏右上角 + 按钮，aria-label） */
  addProviderButton() {
    return this.page.getByLabel('新增 Provider');
  }

  /** 左栏 Provider 列表区域（antd Sider 渲染为 complementary/aside） */
  private leftSider() {
    return this.page.getByRole('complementary').filter({ hasText: 'PROVIDERS' });
  }

  /** 左栏某个 Provider 行（限定在左栏，按名称文本定位，避免匹配中栏标题） */
  providerListItem(name: string) {
    return this.leftSider().getByText(name, { exact: true });
  }

  /** 右栏 Agent 面板区域（complementary/aside，含 TARGET AGENTS） */
  private rightSider() {
    return this.page.getByRole('complementary').filter({ hasText: 'TARGET AGENTS' });
  }

  // ---------------------------------------------------------------------------
  // Add Provider 弹窗
  // ---------------------------------------------------------------------------

  /** 新增弹窗根节点（antd dialog，按中文标题定位；默认界面语言为中文） */
  addProviderDialog() {
    return this.page.getByRole('dialog').filter({ hasText: '新增 Provider' });
  }

  /**
   * 通过新增弹窗创建一个 Provider。
   * @param opts.group     云/本地分组
   * @param opts.presetLabel 预设 chip 的展示名（如 'OpenAI' / 'Ollama（本地）'）
   * @param opts.name      名称（覆盖预设预填）
   * @param opts.baseUrl   Base URL（可选，省略则沿用预设/预填）
   * @param opts.apiKey    API Key（可选）
   */
  async createProvider(opts: {
    group: '云平台' | '本地平台';
    presetLabel: string;
    name: string;
    baseUrl?: string;
    apiKey?: string;
  }): Promise<void> {
    await this.addProviderButton().click();
    const dialog = this.addProviderDialog();
    await expect(dialog).toBeVisible();

    // 选择云/本地分组（Segmented）
    await dialog.getByText(opts.group, { exact: true }).click();
    // 选中预设 chip
    await dialog.getByText(opts.presetLabel, { exact: true }).click();

    // 填名称：用 placeholder 精确定位（exact 避免匹配到 baseUrl 的 https://api.openai.com）
    await dialog.getByPlaceholder('openai', { exact: true }).fill(opts.name);

    if (opts.baseUrl !== undefined) {
      await dialog.getByPlaceholder('https://api.openai.com').fill(opts.baseUrl);
    }
    if (opts.apiKey !== undefined) {
      await dialog.getByPlaceholder('粘贴密钥 — 存入系统凭据库').fill(opts.apiKey);
    }

    // 保存（中文界面按钮文案为「保存 Provider」）
    await dialog.getByRole('button', { name: '保存 Provider' }).click();
    // 等待弹窗关闭
    await expect(dialog).toBeHidden();
  }

  // ---------------------------------------------------------------------------
  // 中栏：Provider 详情 + API 配置表单（ProviderForm）
  // ---------------------------------------------------------------------------

  /** 中栏详情头部的 Provider 名称标题 */
  detailTitle(name: string) {
    return this.page.getByRole('heading', { name, exact: true });
  }

  /** API 配置表单字段：名称 */
  formNameInput() {
    return this.page.getByLabel('名称', { exact: true });
  }

  /** API 配置表单字段：Base URL */
  formBaseUrlInput() {
    return this.page.getByLabel('Base URL', { exact: true });
  }

  /** API 配置表单字段：超时（毫秒）（accessible name 带「（可选）」后缀，故用 spinbutton + 非 exact） */
  formTimeoutInput() {
    return this.page.getByRole('spinbutton', { name: /超时（毫秒）/ });
  }

  /** API Key 明文输入框（云 provider 的 placeholder） */
  apiKeyInput() {
    return this.page.getByPlaceholder('粘贴 API Key 后点击保存');
  }

  /** 「保存密钥」按钮 */
  saveSecretButton() {
    return this.page.getByRole('button', { name: '保存密钥' });
  }

  // ---------------------------------------------------------------------------
  // 中栏：模型发现面板（ModelDiscoveryPanel）
  // ---------------------------------------------------------------------------

  /** 「获取清单」按钮 */
  fetchModelsButton() {
    return this.page.getByRole('button', { name: '获取清单' });
  }

  /** 「探测可用性」按钮 */
  probeModelsButton() {
    return this.page.getByRole('button', { name: '探测可用性' });
  }

  /** 模型表格中某个模型 id 的单元格 */
  modelRow(modelId: string) {
    return this.page.getByRole('row', { name: new RegExp(modelId) });
  }

  // ---------------------------------------------------------------------------
  // 右栏：Agent 面板（AgentPanel）
  // ---------------------------------------------------------------------------

  /** 某个 agent 行的启用开关（限定右栏，按 agent 名称过滤列表项后取 switch） */
  agentSwitch(agentName: string) {
    return this.rightSider()
      .getByRole('listitem')
      .filter({ hasText: agentName })
      .getByRole('switch')
      .first();
  }

  /** 启用某个 agent（若未启用才点击） */
  async enableAgent(agentName: string): Promise<void> {
    const sw = this.agentSwitch(agentName);
    await sw.waitFor({ state: 'visible' });
    if ((await sw.getAttribute('aria-checked')) !== 'true') {
      await sw.click();
    }
  }

  // ---------------------------------------------------------------------------
  // 预览弹窗（PreviewDiffModal）
  // ---------------------------------------------------------------------------

  /** 预览弹窗根节点（按标题「分发预览 Diff」） */
  previewDialog() {
    return this.page.getByRole('dialog').filter({ hasText: '分发预览 Diff' });
  }

  /** 预览弹窗「确认并分发」按钮 */
  confirmDistributeButton() {
    return this.previewDialog().getByRole('button', { name: '确认并分发' });
  }

  // ---------------------------------------------------------------------------
  // 分发报告弹窗（DistributeReportModal）
  // ---------------------------------------------------------------------------

  /** 报告弹窗根节点（按标题「分发报告」） */
  reportDialog() {
    return this.page.getByRole('dialog').filter({ hasText: '分发报告' });
  }

  /** 报告弹窗「完成」按钮（antd 对两字按钮会插入空格「完 成」，故用正则容忍空白） */
  reportDoneButton() {
    return this.reportDialog().getByRole('button', { name: /完\s*成/ });
  }

  /** 报告弹窗中某个计数统计项（成功/失败/跳过），用 Statistic 标题定位 */
  reportStatistic(label: '成功' | '失败' | '跳过') {
    return this.reportDialog().locator('.ant-statistic-title').getByText(label, { exact: true });
  }

  /** 报告弹窗中某个 agent 的明细条目标题（strong 文本） */
  reportAgentEntry(agentId: string) {
    return this.reportDialog().getByRole('strong').filter({ hasText: agentId }).first();
  }

  // ---------------------------------------------------------------------------
  // 通用：antd message toast
  // ---------------------------------------------------------------------------

  /** 按文本片段匹配 antd 顶部 message 提示 */
  toast(text: string | RegExp) {
    return this.page.locator('.ant-message').getByText(text);
  }
}
