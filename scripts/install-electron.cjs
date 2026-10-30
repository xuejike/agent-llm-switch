// 跨平台补齐 Electron 二进制：定位 electron 包自带的 install.js 并执行。
// electron 的 install.js 幂等：二进制已就位时会跳过下载及校验。
const { execFileSync } = require('node:child_process');
const installJs = require.resolve('electron/install.js');
execFileSync(process.execPath, [installJs], { stdio: 'inherit' });
