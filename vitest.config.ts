import { resolve } from 'node:path';
import { defineConfig } from 'vitest/config';

// Vitest 配置：约定测试文件位置、node/jsdom 环境分区与共享类型别名
//
// 环境分区约定（满足需求 14.3 的 Vitest 运行约定）：
// - 默认环境为 node：主进程逻辑（src/main、src/shared、src/preload）的测试在 node 环境运行，
//   贴近 Electron 主进程的真实运行时。
// - 渲染组件测试使用 jsdom：src/renderer 下的测试涉及 React 组件与 DOM，需浏览器样 DOM 环境，
//   通过 environmentMatchGlobs 自动匹配为 jsdom。
// - 如需逐文件覆盖，可在测试文件顶部用 `// @vitest-environment jsdom` 注释指定。
export default defineConfig({
  test: {
    // 默认 node 环境（主进程/共享逻辑）
    environment: 'node',
    // 按路径为渲染进程测试自动切换到 jsdom 环境
    environmentMatchGlobs: [
      ['src/renderer/**', 'jsdom'],
      ['src/**/*.{test,spec}.tsx', 'jsdom'],
    ],
    // 测试文件匹配：覆盖 .ts 与 .tsx（单元测试、属性测试、组件测试）
    include: ['src/**/*.{test,spec}.ts', 'src/**/*.{test,spec}.tsx'],
  },
  resolve: {
    alias: {
      '@shared': resolve(__dirname, 'src/shared'),
    },
  },
});
