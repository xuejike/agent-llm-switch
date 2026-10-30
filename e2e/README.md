# 自动化 GUI 测试（Playwright for Electron）

本目录是 LLM 配置管理器的**端到端 GUI 自动化测试**，用 [Playwright 的 Electron 支持](https://playwright.dev/docs/api/class-electron) 驱动真实的 Electron 应用，逐功能、逐 UI 地验证。与单元测试（vitest，位于 `src/**/*.test.ts`）相互独立、分开运行。

## 覆盖范围

每个功能区都有对应的测试文件，覆盖其 UI 与交互：

| 测试文件 | 覆盖的功能与 UI |
| --- | --- |
| `app-launch.e2e.ts` | 应用启动、首屏加载、三栏布局（顶部栏 / Provider 列表 / 详情 / Agent 面板）、初始空态、四个内置 agent 列出 |
| `provider-create.e2e.ts` | 新增 Provider 弹窗、云/本地分组切换、预设 chip 选择与自动预填、创建后左栏出现并自动选中、本地 `local` 徽标 |
| `provider-form.e2e.ts` | 中栏 API 配置表单：展示各字段、编辑名称/Base URL 并持久化、保存 API Key 显示掩码、空输入告警 |
| `model-discovery.e2e.ts` | 模型发现面板：获取候选清单、勾选、探测可用性、可用性 Tag、`仅可用` 筛选切换 |
| `distribution.e2e.ts` | 右栏启用 agent、顶部「预览」弹窗与掩码 diff、确认并分发、分发报告（成功/失败/跳过计数与每 agent 明细）、「一键分发」直达报告 |
| `validation.e2e.ts` | 表单必填/非法 URL 校验、未选 Provider 或未勾选 agent 时的操作前置告警 |
| `live-api.e2e.ts` | **真实 API 的 GUI 集成**：在 UI 里对真实 OpenAI 兼容网关获取模型清单并探测可用性（默认跳过，见下） |

## 运行方式

### 默认（替身）模式 —— 稳定、离线、不触网

默认用「确定性替身」模式运行：主进程注入内存服务与固定假数据（见 `src/main/e2eAssembly.ts`），
并把数据目录与各 agent 配置路径重定向到**临时目录**，不污染真实用户目录、不访问网络。

```bash
pnpm test:e2e            # 跑全部 GUI 测试
pnpm test:e2e:ui         # 以 Playwright UI 模式交互运行
pnpm test:e2e:report     # 查看上次运行的 HTML 报告
```

首次运行会自动 `pnpm build` 产出 `dist/`（见 `globalSetup.ts`）。
若已手动构建、想跳过以加速：设置环境变量 `LLM_SWITCH_E2E_SKIP_BUILD=1`。

### 真实 API 模式 —— 打到真实 LLM 网关

`live-api.e2e.ts` 会以「真实服务」模式启动应用（`LLM_SWITCH_E2E_LIVE=1`），
真实 `fetch` 打到配置的网关。默认跳过，仅当提供下列环境变量时运行：

```powershell
# PowerShell
$env:LLM_SWITCH_LIVE_API='1'
$env:LLM_SWITCH_LIVE_API_KEY='<你的 API Key>'
# 可选：覆盖网关地址（默认 https://llm-admin.csisolar.com）
# $env:LLM_SWITCH_LIVE_API_BASE='https://your-gateway'
pnpm test:e2e:live
```

对应的「服务层」真实集成测试（vitest，直接调用真实 `ModelDiscovery`）：

```powershell
$env:LLM_SWITCH_LIVE_API='1'
$env:LLM_SWITCH_LIVE_API_KEY='<你的 API Key>'
pnpm test:live
```

> 安全：API Key 只从环境变量读取，**绝不**写入仓库。真实网关存在限流与模型上下线波动，
> 真实测试的断言以「链路行为正确 + 可用性与状态码自洽」为主，并对限流做退避重试。

## 数据隔离与安全

- 每条用例启动独立的 Electron 实例，并通过 `--user-data-dir` 与 `HOME/USERPROFILE/APPDATA/XDG_CONFIG_HOME` 环境变量，把 `app-state.json`、密钥、分发写盘与备份全部约束到**临时目录**，用后删除。
- 替身模式下密钥用内存实现（不依赖 `safeStorage`，headless 环境更稳），模型发现/分发为确定性假数据，完全离线。
- 产物（HTML 报告、trace、失败截图）输出到 `e2e/.report` 与 `e2e/.artifacts`，已加入 `.gitignore`。

## 结构

```
e2e/
├── README.md                 本说明
├── globalSetup.ts            全局前置：构建 dist/
├── app-launch.e2e.ts         启动与布局
├── provider-create.e2e.ts    新增 Provider
├── provider-form.e2e.ts      API 配置表单
├── model-discovery.e2e.ts    模型发现与探测
├── distribution.e2e.ts       预览与分发
├── validation.e2e.ts         校验与边界
├── live-api.e2e.ts           真实 API 的 GUI 集成（门控）
└── helpers/
    ├── launch.ts             启动 Electron（替身/真实两种模式）+ 临时目录隔离
    ├── appPage.ts            页面对象（集中封装选择器与操作）
    └── fixtures.ts           Playwright fixtures（test / liveTest）
```
