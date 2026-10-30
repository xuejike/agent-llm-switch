// ESLint 配置（CommonJS 格式，适配 ESLint 8 的 .eslintrc 体系）
// 覆盖 TypeScript 与 React，接入 pnpm lint
module.exports = {
  root: true,
  env: {
    node: true,
    browser: true,
    es2022: true,
  },
  parser: '@typescript-eslint/parser',
  parserOptions: {
    ecmaVersion: 2022,
    sourceType: 'module',
    ecmaFeatures: { jsx: true },
  },
  settings: {
    react: { version: 'detect' },
  },
  plugins: ['@typescript-eslint', 'react', 'react-hooks'],
  extends: [
    'eslint:recommended',
    'plugin:@typescript-eslint/recommended',
    'plugin:react/recommended',
    'plugin:react-hooks/recommended',
  ],
  rules: {
    // 新版 React（17+）JSX 转换无需显式 import React
    'react/react-in-jsx-scope': 'off',
    // 允许以下划线前缀标记有意未使用的参数
    '@typescript-eslint/no-unused-vars': ['warn', { argsIgnorePattern: '^_' }],
  },
  ignorePatterns: ['dist/**', 'node_modules/**', 'out/**'],
};
