// PathResolver 跨平台路径解析的属性测试
//
// 本文件实现设计文档中的 Property 6「路径解析正确」：
// 对 win32 / darwin / linux 三平台的模拟 PlatformContext，断言 resolve / configHome
// 产出该平台约定的绝对路径，且 `~`、`%APPDATA%`、`$XDG_CONFIG_HOME` 等变量被正确展开。
//
// Validates: Requirements 12.1, 12.2 / Property 6
//
// 约定：
// - 属性测试统一经 src/shared/testing/fcConfig.ts 的 fcAssert 运行（numRuns >= 100）。
// - 平台信息经注入的 PlatformContext 提供，测试不触达真实文件系统与全局 process。

import { describe, it, expect } from "vitest";
import fc from "fast-check";
import path from "node:path";
import type { PlatformContext } from "@shared/types";
import { configHome, resolve } from "./pathResolver";
import { fcAssert } from "@shared/testing/fcConfig";

// ---------------------------------------------------------------------------
// 智能生成器：为每个平台构造「合法」的 PlatformContext，把输入空间约束到有意义的范围。
// ---------------------------------------------------------------------------

/** 生成单段合法路径名（字母/数字/下划线/连字符，非空），避免分隔符与变量符号干扰断言 */
const segmentArb = fc
  .stringMatching(/^[A-Za-z0-9_-]+$/)
  .filter((s) => s.length > 0 && s.length <= 12);

/** 生成 Windows 绝对主目录，形如 C:\Users\<seg>（统一用反斜杠，贴近真实 win32 语义） */
const winHomeArb = fc
  .tuple(
    fc.constantFrom("C", "D", "E"),
    fc.array(segmentArb, { minLength: 1, maxLength: 3 }),
  )
  .map(([drive, segs]) => `${drive}:\\Users\\${segs.join("\\")}`);

/** 生成 POSIX 绝对主目录，形如 /home/<seg> 或 /Users/<seg> */
const posixHomeArb = fc
  .tuple(
    fc.constantFrom("home", "Users", "root"),
    fc.array(segmentArb, { minLength: 1, maxLength: 3 }),
  )
  .map(([root, segs]) => `/${root}/${segs.join("/")}`);

/** 生成 win32 平台上下文：含 50% 概率提供 %APPDATA%（绝对路径），否则缺失以触发回退分支 */
const win32ContextArb: fc.Arbitrary<PlatformContext> = fc
  .tuple(
    winHomeArb,
    fc.option(
      fc
        .tuple(fc.constantFrom("C", "D"), fc.array(segmentArb, { minLength: 1, maxLength: 3 }))
        .map(([drive, segs]) => `${drive}:\\${segs.join("\\")}\\Roaming`),
      { nil: undefined },
    ),
  )
  .map(([homeDir, appData]) => ({
    os: "win32" as const,
    homeDir,
    env: appData === undefined ? {} : { APPDATA: appData },
  }));

/** 生成 darwin 平台上下文：env 内容不影响 configHome，随机填充以提高覆盖 */
const darwinContextArb: fc.Arbitrary<PlatformContext> = posixHomeArb.map((homeDir) => ({
  os: "darwin" as const,
  homeDir,
  env: {},
}));

/** 生成 linux 平台上下文：含 50% 概率提供 $XDG_CONFIG_HOME（绝对路径），否则缺失以触发回退分支 */
const linuxContextArb: fc.Arbitrary<PlatformContext> = fc
  .tuple(
    posixHomeArb,
    fc.option(
      fc.array(segmentArb, { minLength: 1, maxLength: 3 }).map((segs) => `/${segs.join("/")}`),
      { nil: undefined },
    ),
  )
  .map(([homeDir, xdg]) => ({
    os: "linux" as const,
    homeDir,
    env: xdg === undefined ? {} : { XDG_CONFIG_HOME: xdg },
  }));

/**
 * 计算某平台 configHome 的「期望值」，与被测实现相互独立地推导，用于交叉验证。
 * 期望值的推导直接对应 requirement 12.1 中各平台的约定目录。
 */
function expectedConfigHome(ctx: PlatformContext): string {
  const p = ctx.os === "win32" ? path.win32 : path.posix;
  switch (ctx.os) {
    case "win32": {
      const appData = ctx.env.APPDATA;
      const base =
        appData && appData.length > 0 ? appData : p.join(ctx.homeDir, "AppData", "Roaming");
      return p.normalize(base);
    }
    case "darwin":
      return p.normalize(p.join(ctx.homeDir, "Library", "Application Support"));
    case "linux": {
      const xdg = ctx.env.XDG_CONFIG_HOME;
      const base = xdg && xdg.length > 0 ? xdg : p.join(ctx.homeDir, ".config");
      return p.normalize(base);
    }
  }
}

/** 按平台判断是否为绝对路径（注入平台而非依赖宿主 process.platform） */
function isAbsoluteFor(ctx: PlatformContext, value: string): boolean {
  const p = ctx.os === "win32" ? path.win32 : path.posix;
  return p.isAbsolute(value);
}

// ---------------------------------------------------------------------------
// Property 6：路径解析正确
// ---------------------------------------------------------------------------

describe("PathResolver 属性测试（Property 6：路径解析正确）", () => {
  // 把三平台生成器收敛为一个联合生成器，便于统一驱动跨平台断言。
  const anyPlatformArb = fc.oneof(win32ContextArb, darwinContextArb, linuxContextArb);

  it("configHome 对三平台均返回该平台约定的绝对路径（Property 6 / Req 12.1）", () => {
    fcAssert(
      fc.property(anyPlatformArb, (ctx) => {
        const home = configHome(ctx);
        // 断言 1：结果为该平台语义下的绝对路径
        expect(isAbsoluteFor(ctx, home)).toBe(true);
        // 断言 2：结果与独立推导的平台约定目录一致（含 %APPDATA% / $XDG_CONFIG_HOME 回退分支）
        expect(home).toBe(expectedConfigHome(ctx));
      }),
    );
  });

  it("resolve 把 `~` 开头的模板展开为主目录下的绝对路径（Property 6 / Req 12.2）", () => {
    fcAssert(
      fc.property(
        anyPlatformArb,
        fc.array(segmentArb, { minLength: 1, maxLength: 4 }),
        (ctx, segs) => {
          const p = ctx.os === "win32" ? path.win32 : path.posix;
          const tail = segs.join("/");
          const resolved = resolve(`~/${tail}`, ctx);
          const expected = p.normalize(p.join(ctx.homeDir, ...segs));
          // `~` 被展开为主目录，且整体为绝对路径
          expect(isAbsoluteFor(ctx, resolved)).toBe(true);
          expect(resolved).toBe(expected);
        },
      ),
    );
  });

  it("resolve 在 win32 下正确展开 %APPDATA% 变量（Property 6 / Req 12.2）", () => {
    fcAssert(
      fc.property(
        // 仅取提供了 APPDATA 的 win32 上下文，使变量展开可被确定地断言
        win32ContextArb.filter((ctx) => (ctx.env.APPDATA ?? "").length > 0),
        fc.array(segmentArb, { minLength: 1, maxLength: 3 }),
        (ctx, segs) => {
          const p = path.win32;
          const tail = segs.join("\\");
          const resolved = resolve(`%APPDATA%\\${tail}`, ctx);
          const expected = p.normalize(p.join(ctx.env.APPDATA as string, ...segs));
          expect(isAbsoluteFor(ctx, resolved)).toBe(true);
          expect(resolved).toBe(expected);
          // 展开后不应残留字面量变量标记
          expect(resolved).not.toContain("%APPDATA%");
        },
      ),
    );
  });

  it("resolve 在 linux 下正确展开 $XDG_CONFIG_HOME 与 ${VAR} 两种写法（Property 6 / Req 12.2）", () => {
    fcAssert(
      fc.property(
        // 仅取提供了 XDG_CONFIG_HOME 的 linux 上下文
        linuxContextArb.filter((ctx) => (ctx.env.XDG_CONFIG_HOME ?? "").length > 0),
        fc.array(segmentArb, { minLength: 1, maxLength: 3 }),
        fc.boolean(),
        (ctx, segs, useBrace) => {
          const p = path.posix;
          const tail = segs.join("/");
          const varRef = useBrace ? "${XDG_CONFIG_HOME}" : "$XDG_CONFIG_HOME";
          const resolved = resolve(`${varRef}/${tail}`, ctx);
          const expected = p.normalize(p.join(ctx.env.XDG_CONFIG_HOME as string, ...segs));
          expect(isAbsoluteFor(ctx, resolved)).toBe(true);
          expect(resolved).toBe(expected);
          // 展开后不应残留字面量变量标记
          expect(resolved).not.toContain("XDG_CONFIG_HOME");
          expect(resolved).not.toContain("$");
        },
      ),
    );
  });

  it("resolve 对相对模板以 configHome 为基准补全为绝对路径（Property 6 / Req 12.2）", () => {
    fcAssert(
      fc.property(
        anyPlatformArb,
        fc.array(segmentArb, { minLength: 1, maxLength: 3 }),
        (ctx, segs) => {
          const p = ctx.os === "win32" ? path.win32 : path.posix;
          const tail = segs.join("/");
          const resolved = resolve(tail, ctx);
          const expected = p.normalize(p.join(configHome(ctx), ...segs));
          // 相对模板不含变量/`~`，应以该平台 configHome 为基准补全
          expect(isAbsoluteFor(ctx, resolved)).toBe(true);
          expect(resolved).toBe(expected);
        },
      ),
    );
  });
});
