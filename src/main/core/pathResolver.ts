// 跨平台路径解析纯函数（PathResolver）
//
// 本模块把「含平台变量的路径模板」解析为「当前平台的绝对路径」，并提供各平台
// 约定的配置根目录，供各 Agent 适配器定位其配置文件。为便于测试，平台信息一律
// 经注入的 PlatformContext（os / homeDir / env）提供，而非在模块内读取全局 process。
//
// 设计约束（参照 design.md 组件 6 PathResolver、configHome/resolve 算法，
// 以及 requirements 12.1 / 12.2 / 12.3）：
// - configHome(platform)：按 win32 / darwin / linux 返回该平台约定的配置根目录。
//   · win32：漫游配置目录 %APPDATA%（回退到 ~/AppData/Roaming）。
//   · darwin：~/Library/Application Support。
//   · linux：$XDG_CONFIG_HOME（若非空）否则 ~/.config。
// - resolve(template, platform)：展开 `~`、`%APPDATA%`（Windows 风格 %VAR%）、
//   `$XDG_CONFIG_HOME` / `${VAR}`（POSIX 风格）等变量，并归一化为绝对路径。
// - ensureWithin(baseDir, target, platform)：对解析结果做规范化与归属校验，
//   把写入目标限定在预期配置目录内，避免 `..` 等导致的路径穿越（requirement 12.3）。
//
// 本模块为纯函数，不触达真实文件系统，仅做字符串与路径规范化计算。

import path from "node:path";
import type { PlatformContext } from "@shared/types";

/**
 * 按平台选择路径处理实现：win32 使用 Windows 语义（反斜杠、盘符、大小写不敏感），
 * 其余使用 POSIX 语义。注入平台而非依赖宿主 process.platform，保证三平台可测。
 */
function pathForPlatform(platform: PlatformContext): path.PlatformPath {
  return platform.os === "win32" ? path.win32 : path.posix;
}

/**
 * 在环境变量快照中大小写不敏感地查找变量值。
 * Windows 环境变量名大小写不敏感（APPDATA 与 appdata 等价），POSIX 虽大小写敏感，
 * 但此处统一按不敏感匹配以提高模板书写容错，匹配不到时返回 undefined。
 *
 * @param env 环境变量快照
 * @param name 变量名
 * @returns 变量值；未定义时返回 undefined
 */
function lookupEnv(
  env: Record<string, string | undefined>,
  name: string,
): string | undefined {
  // 先尝试精确匹配，命中则直接返回（含空串场景）
  if (Object.prototype.hasOwnProperty.call(env, name)) {
    return env[name];
  }
  // 回退到大小写不敏感匹配
  const lowerName = name.toLowerCase();
  for (const key of Object.keys(env)) {
    if (key.toLowerCase() === lowerName) {
      return env[key];
    }
  }
  return undefined;
}

/**
 * 展开路径模板中的环境变量引用，支持三种写法：
 * - Windows 风格：`%APPDATA%`
 * - POSIX 花括号：`${XDG_CONFIG_HOME}`
 * - POSIX 裸变量：`$XDG_CONFIG_HOME`（变量名由字母/数字/下划线组成）
 * 未定义或无对应值的变量一律展开为空串，避免把字面量变量名残留进路径。
 *
 * @param template 原始模板
 * @param env 环境变量快照
 * @returns 变量展开后的字符串
 */
function expandEnvVars(
  template: string,
  env: Record<string, string | undefined>,
): string {
  // %VAR%（Windows 风格）
  let result = template.replace(/%([^%]+)%/g, (_match, name: string) => {
    return lookupEnv(env, name) ?? "";
  });
  // ${VAR}（POSIX 花括号写法）
  result = result.replace(/\$\{([^}]+)\}/g, (_match, name: string) => {
    return lookupEnv(env, name) ?? "";
  });
  // $VAR（POSIX 裸变量写法）
  result = result.replace(/\$([A-Za-z_][A-Za-z0-9_]*)/g, (_match, name: string) => {
    return lookupEnv(env, name) ?? "";
  });
  return result;
}

/**
 * 返回当前平台约定的配置根目录（对应 requirement 12.1）。
 *
 * @param platform 注入的平台上下文
 * @returns 该平台约定的配置根目录绝对路径
 */
export function configHome(platform: PlatformContext): string {
  const p = pathForPlatform(platform);
  const { os, homeDir, env } = platform;

  switch (os) {
    case "win32": {
      // 漫游配置目录：优先 %APPDATA%，缺失时回退到 ~/AppData/Roaming
      const appData = lookupEnv(env, "APPDATA");
      const base =
        appData && appData.length > 0
          ? appData
          : p.join(homeDir, "AppData", "Roaming");
      return p.normalize(base);
    }
    case "darwin": {
      // macOS 约定：~/Library/Application Support
      return p.normalize(p.join(homeDir, "Library", "Application Support"));
    }
    case "linux": {
      // 遵循 XDG 规范：$XDG_CONFIG_HOME 非空时优先，否则 ~/.config
      const xdg = lookupEnv(env, "XDG_CONFIG_HOME");
      const base =
        xdg && xdg.length > 0 ? xdg : p.join(homeDir, ".config");
      return p.normalize(base);
    }
    default: {
      // 理论不可达：PlatformContext.os 已被类型约束为三平台之一
      throw new Error(`不支持的平台：${String(os)}`);
    }
  }
}

/**
 * 把含平台变量的路径模板解析为当前平台的绝对路径（对应 requirement 12.1 / 12.2）。
 *
 * 处理顺序：
 * 1. 把起始处的 `~` 展开为用户主目录（仅处理路径开头的 `~`，避免误伤文件名中的 `~`）。
 * 2. 展开 `%APPDATA%` / `$XDG_CONFIG_HOME` / `${VAR}` 等环境变量引用。
 * 3. 按平台规范化为绝对路径：相对路径以 configHome 为基准补全，最终做 normalize。
 *
 * @param template 含平台变量的路径模板
 * @param platform 注入的平台上下文
 * @returns 归一化后的绝对路径
 */
export function resolve(template: string, platform: PlatformContext): string {
  const p = pathForPlatform(platform);

  // 1. 展开起始处的 `~`：`~`、`~/x`、`~\x` 均替换为主目录
  let s = template;
  if (s === "~") {
    s = platform.homeDir;
  } else if (s.startsWith("~/") || s.startsWith("~\\")) {
    s = p.join(platform.homeDir, s.slice(2));
  }

  // 2. 展开环境变量引用
  s = expandEnvVars(s, platform.env);

  // 3. 归一化为绝对路径：已是绝对路径直接 normalize；相对路径以 configHome 为基准
  if (p.isAbsolute(s)) {
    return p.normalize(s);
  }
  return p.normalize(p.join(configHome(platform), s));
}

/**
 * 归属校验：判断 target 规范化后是否位于 baseDir 之内（含等于 baseDir 本身），
 * 用于把写入目标限定在预期配置目录内，避免 `..` 等导致的路径穿越（requirement 12.3）。
 *
 * baseDir 与 target 均先按平台解析为绝对路径再比较；Windows 下大小写不敏感。
 *
 * @param baseDir 允许写入的基准目录（可含平台变量）
 * @param target 待校验的目标路径（可含平台变量）
 * @param platform 注入的平台上下文
 * @returns target 位于 baseDir 内返回 true，否则 false
 */
export function isWithin(
  baseDir: string,
  target: string,
  platform: PlatformContext,
): boolean {
  const p = pathForPlatform(platform);
  const resolvedBase = resolve(baseDir, platform);
  const resolvedTarget = resolve(target, platform);

  // 计算从 base 到 target 的相对路径：越界时相对路径以 `..` 开头或为绝对路径
  let rel = p.relative(resolvedBase, resolvedTarget);
  if (platform.os === "win32") {
    // Windows 路径大小写不敏感：统一小写后比较
    rel = rel.toLowerCase();
  }

  // 相对路径为空表示 target 等于 base（视为在内）
  if (rel === "") {
    return true;
  }
  // 以 `..` 开头（`..`、`../x`、`..\x`）或是绝对路径（如跨盘符）即为越界
  if (rel === ".." || rel.startsWith(`..${p.sep}`) || p.isAbsolute(rel)) {
    return false;
  }
  return true;
}

/**
 * 归属校验并返回解析结果：解析 target 为绝对路径，若其越出 baseDir 则抛错，
 * 否则返回规范化后的绝对目标路径。供适配器在落盘前把关，防止路径穿越。
 *
 * @param baseDir 允许写入的基准目录（可含平台变量）
 * @param target 待校验并解析的目标路径（可含平台变量）
 * @param platform 注入的平台上下文
 * @returns 位于 baseDir 内的规范化绝对路径
 * @throws 当 target 越出 baseDir 时抛出路径穿越错误
 */
export function ensureWithin(
  baseDir: string,
  target: string,
  platform: PlatformContext,
): string {
  if (!isWithin(baseDir, target, platform)) {
    throw new Error(
      `路径穿越校验失败：目标路径不在允许的配置目录内（base=${baseDir}，target=${target}）`,
    );
  }
  return resolve(target, platform);
}
