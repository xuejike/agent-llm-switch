import { defineConfig } from '@playwright/test';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

// ESM 下无内置 __dirname，由 import.meta.url 派生当前目录
const __dirname = dirname(fileURLToPath(import.meta.url));

// Playwright（Electron GUI 端到端测试）配置
//
// 与单元测试（vitest）完全隔离：
// - 测试目录固定为 e2e/，测试文件后缀 *.e2e.ts，vitest.config.ts 的 include 不会抓到它们。
// - 每条用例驱动真实的 Electron 应用（经 _electron.launch 启动 dist/main/index.js）。
//
// 运行前置：须先 `pnpm build` 产出 dist/（globalSetup 会自动构建，见 e2e/globalSetup.ts）。
export default defineConfig({
  // 测试根目录：仅扫描 e2e/ 下的 *.e2e.ts
  testDir: resolve(__dirname, 'e2e'),
  testMatch: /.*\.e2e\.ts$/,

  // 启动前统一构建一次 Electron 产物（dist/main、dist/preload、dist/renderer）
  globalSetup: resolve(__dirname, 'e2e/globalSetup.ts'),

  // Electron 应用为单实例、共享文件系统副作用，强制串行，避免相互干扰
  fullyParallel: false,
  workers: 1,

  // 每条用例超时与断言超时（Electron 启动 + 构建首屏需要一定时间）
  timeout: 60_000,
  expect: { timeout: 10_000 },

  // CI 上失败重试一次，吸收偶发的启动抖动
  retries: process.env.CI ? 1 : 0,

  // 报告：本地用 list，生成 HTML 报告到 e2e/.report（不自动打开）
  reporter: process.env.CI
    ? [['list'], ['html', { outputFolder: 'e2e/.report', open: 'never' }]]
    : [['list'], ['html', { outputFolder: 'e2e/.report', open: 'never' }]],

  // 失败时保留截图与 trace，便于排查
  use: {
    screenshot: 'only-on-failure',
    trace: 'retain-on-failure',
  },

  // 产物（trace/截图）输出目录
  outputDir: resolve(__dirname, 'e2e/.artifacts'),
});
