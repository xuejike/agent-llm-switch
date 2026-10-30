import { _electron as electron, type ElectronApplication, type Page } from '@playwright/test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { dirname, join, resolve } from 'node:path';

// ESM 下无内置 __dirname，由 import.meta.url 派生当前目录
const __dirname = dirname(fileURLToPath(import.meta.url));

// Electron 应用启动辅助
//
// 职责：
// - 为每条用例创建独立的临时数据目录（隔离 app-state.json 等副作用）
// - 以 E2E 模式启动 Electron（LLM_SWITCH_E2E=1 + 数据目录注入 + userData 重定向）
// - 返回已就绪的首个渲染窗口 Page（等待首屏「加载配置中…」Spin 消失）
// - 提供清理函数：关闭应用并删除临时目录

/** 启动结果：Electron 应用句柄、首窗 Page、关闭并清理的函数 */
export interface LaunchResult {
  /** Electron 应用句柄（可用于 app.evaluate 访问主进程） */
  app: ElectronApplication;
  /** 已就绪的首个渲染窗口 */
  page: Page;
  /** 本次运行的临时数据目录（断言写盘/状态时可用） */
  dataDir: string;
  /** 关闭应用并删除临时目录（在 afterEach 调用） */
  close: () => Promise<void>;
}

/** 启动选项 */
export interface LaunchOptions {
  /**
   * 是否使用「真实服务」E2E 模式（LLM_SWITCH_E2E_LIVE=1）：真实 fetch 打到配置的网关。
   * 默认 false，使用确定性替身模式（LLM_SWITCH_E2E=1）。
   */
  live?: boolean;
}

/**
 * 以 E2E 模式启动 Electron 应用并返回就绪的首窗。
 *
 * 启动约束：
 * - args 指向编译产物 dist/main/index.js（由 globalSetup 构建）。
 * - 通过 --user-data-dir 与一组环境变量把所有文件系统副作用约束到临时目录。
 * - live=true 时走真实服务装配（真实网络），否则走确定性替身。
 */
export async function launchApp(options: LaunchOptions = {}): Promise<LaunchResult> {
  const root = resolve(__dirname, '..', '..');
  const mainEntry = resolve(root, 'dist/main/index.js');

  // 为本次运行创建独立临时数据目录（测试结束后删除）
  const dataDir = mkdtempSync(join(tmpdir(), 'llm-switch-e2e-'));

  const modeEnv: Record<string, string> = options.live
    ? { LLM_SWITCH_E2E_LIVE: '1' }
    : { LLM_SWITCH_E2E: '1' };

  const app = await electron.launch({
    args: [mainEntry, `--user-data-dir=${dataDir}`],
    env: {
      ...process.env,
      // 开启主进程的 E2E 装配分支（替身或真实服务）
      ...modeEnv,
      // 把 ConfigStore 数据目录与平台路径都指向临时目录
      LLM_SWITCH_E2E_DATA_DIR: dataDir,
      HOME: dataDir,
      USERPROFILE: dataDir,
      APPDATA: dataDir,
      XDG_CONFIG_HOME: dataDir,
      // 关闭开发态渲染 URL，强制加载打包产物 dist/renderer/index.html
      ELECTRON_RENDERER_URL: '',
      NODE_ENV: 'production',
    },
  });

  // 等待首个渲染窗口
  const page = await app.firstWindow();
  // 等待首屏加载完成：Header 标题出现（loadAppState 完成、Spin 消失）
  await page.getByText('LLM 配置管理器').waitFor({ state: 'visible', timeout: 30_000 });

  const close = async (): Promise<void> => {
    try {
      await app.close();
    } finally {
      // 删除临时目录（忽略删除失败，避免影响测试结论）
      rmSync(dataDir, { recursive: true, force: true });
    }
  };

  return { app, page, dataDir, close };
}
