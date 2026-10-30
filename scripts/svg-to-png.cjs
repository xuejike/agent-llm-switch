// 用 Electron 内置 Chromium 把 SVG 渲染为高分辨率 PNG（无需额外图像库/网络下载）。
//
// 用法：electron scripts/svg-to-png.cjs <输入.svg> <输出.png> <尺寸px>
// 原理：创建一个与目标尺寸等大的隐藏 BrowserWindow，加载内嵌 SVG 的 HTML，
//       待渲染完成后 capturePage 截图并写出 PNG。
const { app, BrowserWindow } = require('electron');
const fs = require('node:fs');
const path = require('node:path');

const [, , inSvg, outPng, sizeArg] = process.argv;
const size = Number.parseInt(sizeArg, 10) || 1024;

async function run() {
  const svg = fs.readFileSync(path.resolve(inSvg), 'utf8');
  // 透明背景、无边距，SVG 填满整个视口
  const html = `<!doctype html><html><head><meta charset="utf-8">
    <style>html,body{margin:0;padding:0;background:transparent;width:${size}px;height:${size}px;overflow:hidden}
    svg{display:block;width:${size}px;height:${size}px}</style></head>
    <body>${svg}</body></html>`;

  const win = new BrowserWindow({
    width: size,
    height: size,
    show: false,
    transparent: true,
    frame: false,
    webPreferences: { offscreen: false },
  });

  await win.loadURL('data:text/html;charset=utf-8,' + encodeURIComponent(html));
  // 给渲染与字体/渐变绘制留出时间
  await new Promise((r) => setTimeout(r, 400));

  const image = await win.capturePage();
  const png = image.toPNG();
  fs.mkdirSync(path.dirname(path.resolve(outPng)), { recursive: true });
  fs.writeFileSync(path.resolve(outPng), png);
  // eslint-disable-next-line no-console
  console.log(`[svg-to-png] 写出 ${outPng} (${png.length} bytes, ${size}x${size})`);

  win.destroy();
  app.quit();
}

app.whenReady().then(run).catch((err) => {
  // eslint-disable-next-line no-console
  console.error('[svg-to-png] 失败：', err);
  app.exit(1);
});
