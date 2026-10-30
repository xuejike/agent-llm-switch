// Electron 主进程入口
// 负责文件系统、操作系统凭据管理器访问与各 Agent 适配器执行等敏感操作。
// 本文件搭建最小可启动的安全 Electron 外壳：创建受严格隔离约束的
// BrowserWindow，并根据运行环境加载开发态 Vite dev server 或生产态打包产物。
import { app, BrowserWindow, ipcMain, shell } from 'electron';
import { join } from 'node:path';
import { createMainServices, registerIpcHandlers } from './ipc/handlers';

// 主窗口引用，避免被垃圾回收导致窗口意外关闭
let mainWindow: BrowserWindow | null = null;

/**
 * 创建主窗口。
 *
 * 安全约束（对应需求 3.1 / 3.2）：
 * - nodeIntegration=false：渲染进程不可直接使用 Node API
 * - contextIsolation=true：预加载脚本与渲染页面上下文隔离
 * - sandbox=true：渲染进程运行于沙箱，进一步收紧可用能力
 * - 仅通过 preload 脚本经 contextBridge 暴露白名单 IPC
 */
function createWindow(): void {
  mainWindow = new BrowserWindow({
    width: 1200,
    height: 800,
    minWidth: 960,
    minHeight: 640,
    // 窗口就绪后再显示，避免启动白屏
    show: false,
    autoHideMenuBar: true,
    webPreferences: {
      // 指定预加载脚本：沙箱下预加载须为 CommonJS，electron-vite 将产物输出为 dist/preload/index.cjs
      preload: join(__dirname, '../preload/index.cjs'),
      // 关闭 Node 集成，渲染进程无直接 Node/文件系统能力
      nodeIntegration: false,
      // 开启上下文隔离，隔离 preload 与页面脚本的执行上下文
      contextIsolation: true,
      // 开启沙箱，收紧渲染进程可用的系统能力
      sandbox: true,
    },
  });

  // 窗口内容准备就绪后再呈现，提升启动观感
  mainWindow.on('ready-to-show', () => {
    mainWindow?.show();
  });

  // 拦截页面内的新窗口请求，统一交由系统浏览器打开外部链接，避免在应用内打开不可信页面
  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    void shell.openExternal(url);
    return { action: 'deny' };
  });

  // 开发态：electron-vite 注入 ELECTRON_RENDERER_URL 指向 Vite dev server，支持热更新
  // 生产态：加载打包后的渲染产物 dist/renderer/index.html
  if (!app.isPackaged && process.env.ELECTRON_RENDERER_URL) {
    void mainWindow.loadURL(process.env.ELECTRON_RENDERER_URL);
  } else {
    void mainWindow.loadFile(join(__dirname, '../renderer/index.html'));
  }

  // 窗口关闭时释放引用
  mainWindow.on('closed', () => {
    mainWindow = null;
  });
}

// Electron 初始化完成后：先装配主进程服务并注册 IPC 处理器，再创建窗口。
// 顺序约束：IPC 处理器须在渲染页面加载前注册就绪，保证 UI 一启动即可安全地经
// contextBridge 白名单调用各 IpcApi 方法（敏感操作全部委派主进程完成）。
void app.whenReady().then(async () => {
  // E2E 模式（由 Playwright 设置 LLM_SWITCH_E2E=1 触发）：改用确定性、零外部副作用的
  // 服务装配，并把 Electron userData 重定向到临时目录，杜绝污染真实用户目录。
  // 生产运行不设该变量，完全走下面的生产装配分支，行为零变化。
  const isE2e = process.env.LLM_SWITCH_E2E === '1';
  const isE2eAny = isE2e || process.env.LLM_SWITCH_E2E_LIVE === '1';
  if (isE2eAny && process.env.LLM_SWITCH_E2E_DATA_DIR) {
    // 把 Electron 的 userData 指向临时目录（即便本次装配不直接用它，也防止任何服务
    // 回落到真实 userData）
    app.setPath('userData', process.env.LLM_SWITCH_E2E_DATA_DIR);
  }

  // 装配服务：
  // - LLM_SWITCH_E2E_LIVE=1：E2E「真实服务 + 临时数据目录」（真实 fetch 打网关，副作用隔离）
  // - LLM_SWITCH_E2E=1：E2E 确定性替身（零外部副作用）
  // - 其余（生产）：真实服务默认装配
  // 并把 IpcApi 全部方法注册到 ipcMain，编排到对应服务上。
  const isE2eLive = process.env.LLM_SWITCH_E2E_LIVE === '1';
  const services = isE2eLive
    ? await (await import('./e2eAssembly')).createE2eLiveServices()
    : isE2e
      ? await (await import('./e2eAssembly')).createE2eServices()
      : await createMainServices();
  registerIpcHandlers({ ipcMain, ...services });

  createWindow();

  // macOS 约定：点击 Dock 图标且无可见窗口时重新创建窗口
  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) {
      createWindow();
    }
  });
});

// 非 macOS 平台：所有窗口关闭后退出应用
app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') {
    app.quit();
  }
});
