import { execSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

// ESM 下无内置 __dirname，由 import.meta.url 派生当前目录
const __dirname = dirname(fileURLToPath(import.meta.url));

// Playwright 全局 setup：在所有 E2E 用例运行前，构建 Electron 产物。
//
// 为什么在这里构建：Electron 主进程入口是编译后的 dist/main/index.js，Playwright 的
// _electron.launch 需要它存在。本 setup 统一执行一次 electron-vite build，产出
// dist/main、dist/preload、dist/renderer 三部分。
//
// 跳过构建：设置环境变量 LLM_SWITCH_E2E_SKIP_BUILD=1 可跳过（当你已手动 build 过、想加速
// 本地重复运行时使用）。
export default function globalSetup(): void {
  const root = resolve(__dirname, '..');
  const mainEntry = resolve(root, 'dist/main/index.js');

  if (process.env.LLM_SWITCH_E2E_SKIP_BUILD === '1' && existsSync(mainEntry)) {
    // 已有产物且显式跳过构建：直接复用
    // eslint-disable-next-line no-console
    console.log('[e2e] 跳过构建（LLM_SWITCH_E2E_SKIP_BUILD=1），复用现有 dist/');
    return;
  }

  // eslint-disable-next-line no-console
  console.log('[e2e] 构建 Electron 产物（electron-vite build）…');
  execSync('pnpm build', { cwd: root, stdio: 'inherit' });

  if (!existsSync(mainEntry)) {
    throw new Error(`[e2e] 构建后仍未找到主进程入口：${mainEntry}`);
  }
}
