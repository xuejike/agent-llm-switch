import { resolve } from 'node:path';
import { defineConfig } from 'electron-vite';
import react from '@vitejs/plugin-react';

// electron-vite 配置：分别构建主进程、预加载脚本与渲染进程三部分
// - main：主进程（Node 环境），产物输出至 dist/main
// - preload：预加载脚本，产物输出至 dist/preload
// - renderer：渲染进程（React + antd），产物输出至 dist/renderer
export default defineConfig({
  main: {
    build: {
      outDir: 'dist/main',
      lib: {
        entry: resolve(__dirname, 'src/main/index.ts'),
      },
    },
    resolve: {
      alias: {
        // 共享类型别名，供主进程引用
        '@shared': resolve(__dirname, 'src/shared'),
      },
    },
  },
  preload: {
    build: {
      outDir: 'dist/preload',
      // 沙箱化（sandbox:true）的预加载脚本必须为 CommonJS，ESM 预加载在沙箱下不被支持，
      // 因此强制以 cjs 格式输出，并固定产物文件名为 index.cjs 供主进程 webPreferences.preload 引用
      rollupOptions: {
        output: {
          format: 'cjs',
          entryFileNames: 'index.cjs',
        },
      },
      lib: {
        entry: resolve(__dirname, 'src/preload/index.ts'),
      },
    },
    resolve: {
      alias: {
        '@shared': resolve(__dirname, 'src/shared'),
      },
    },
  },
  renderer: {
    // 渲染进程根目录指向 src/renderer（index.html 所在处）
    root: resolve(__dirname, 'src/renderer'),
    build: {
      outDir: 'dist/renderer',
      rollupOptions: {
        input: resolve(__dirname, 'src/renderer/index.html'),
      },
    },
    resolve: {
      alias: {
        '@shared': resolve(__dirname, 'src/shared'),
      },
    },
    plugins: [react()],
  },
});
