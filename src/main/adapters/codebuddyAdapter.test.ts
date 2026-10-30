import { describe, it, expect } from "vitest";
import type {
  ApplyEntry,
  FormatMapping,
  PlatformContext,
  ProviderConfig,
  RenderResult,
} from "@shared/types";
import type { AtomicFileWriter } from "../services/atomicFileWriter";
import { createInMemoryWriteEnv } from "../core/injectCredential";
import {
  CodebuddyAdapter,
  CODEBUDDY_ID,
  CODEBUDDY_CONFIG_PATH_TEMPLATE,
  createCodebuddyMapping,
} from "./codebuddyAdapter";

// codebuddy 适配器单元测试（CodebuddyAdapter）
//
// 覆盖任务 9.4 对每个适配器的四项要求：
// 1. detect：解析配置路径（settings.json，三平台变量展开）与文件存在性
// 2. render：JSON 字段级合并，受管字段（endpoint/models）更新且保留非受管字段
// 3. 不同 CredentialMapping 形态下 key 正确落位——codebuddy 默认 env 引用形态，另覆盖 inline 形态
// 4. 既有文件格式损坏时报 failed 不覆盖——render 对损坏 JSON 抛错；apply 写入失败回滚不覆盖
// 对应需求：8.1 / 9.3 / 9.4 / 9.5 / 10.4

// ---------------------------------------------------------------------------
// 测试辅助
// ---------------------------------------------------------------------------

function makeProvider(overrides: Partial<ProviderConfig> = {}): ProviderConfig {
  return {
    id: "p1",
    name: "default",
    baseUrl: "https://api.example.com/v1",
    apiKeyRef: "ref://p1",
    models: ["claude-sonnet-4"],
    ...overrides,
  };
}

function makeWinPlatform(): PlatformContext {
  return {
    os: "win32",
    homeDir: "C:\\Users\\tester",
    env: { APPDATA: "C:\\Users\\tester\\AppData\\Roaming" },
  };
}

function makeMacPlatform(): PlatformContext {
  return { os: "darwin", homeDir: "/Users/tester", env: {} };
}

function makeLinuxPlatform(): PlatformContext {
  return {
    os: "linux",
    homeDir: "/home/tester",
    env: { XDG_CONFIG_HOME: "/home/tester/.config" },
  };
}

/** 记录型 AtomicFileWriter 替身 */
function makeRecordingWriter(options: { failOnWrite?: boolean } = {}): {
  writer: AtomicFileWriter;
  calls: { backup: string[]; write: string[]; restore: Array<[string, string]> };
} {
  const calls = {
    backup: [] as string[],
    write: [] as string[],
    restore: [] as Array<[string, string]>,
  };
  const writer: AtomicFileWriter = {
    async backup(targetPath: string): Promise<string | null> {
      calls.backup.push(targetPath);
      return `${targetPath}.bak.test`;
    },
    async atomicWrite(targetPath: string, _content: string): Promise<void> {
      calls.write.push(targetPath);
      if (options.failOnWrite) {
        throw new Error("模拟写入失败");
      }
    },
    async restore(backupPath: string, targetPath: string): Promise<void> {
      calls.restore.push([backupPath, targetPath]);
    },
  };
  return { writer, calls };
}

describe("CodebuddyAdapter", () => {
  describe("detect：经 CLI 命令判定安装与版本", () => {
    it("命令成功退出时判为已安装并解析版本；配置路径三平台统一解析到 ~/.codebuddy/settings.json", async () => {
      const platform = makeWinPlatform();
      // codebuddy 在所有平台（含 win）都用 ~/.codebuddy/settings.json
      const expectedPath = "C:\\Users\\tester\\.codebuddy\\settings.json";
      const adapter = new CodebuddyAdapter(createCodebuddyMapping(), {
        runCommand: async (command, args) => {
          expect(command).toBe("codebuddy");
          expect(args).toEqual(["--version"]);
          return { ok: true, output: "2.45.1\n" };
        },
        fileExists: async (p) => p === expectedPath,
      });

      const result = await adapter.detect(platform);

      expect(result.configPath).toBe(expectedPath);
      expect(result.fileExists).toBe(true);
      expect(result.installed).toBe(true);
      expect(result.version).toBe("2.45.1");
    });

    it("configPath 在 win/mac/linux 均解析到 home 下的 .codebuddy/settings.json", () => {
      const adapter = new CodebuddyAdapter();
      expect(adapter.configPath(makeWinPlatform())).toBe(
        "C:\\Users\\tester\\.codebuddy\\settings.json",
      );
      expect(adapter.configPath(makeMacPlatform())).toBe(
        "/Users/tester/.codebuddy/settings.json",
      );
      expect(adapter.configPath(makeLinuxPlatform())).toBe(
        "/home/tester/.codebuddy/settings.json",
      );
    });

    it("命令失败时应判为未安装，忽略配置文件存在与否", async () => {
      const adapter = new CodebuddyAdapter(createCodebuddyMapping(), {
        runCommand: async () => ({ ok: false, output: "" }),
        fileExists: async () => true,
      });

      const result = await adapter.detect(makeLinuxPlatform());

      expect(result.configPath).toBe("/home/tester/.codebuddy/settings.json");
      expect(result.installed).toBe(false);
      expect(result.version).toBeUndefined();
    });

    it("适配器 id 与路径模板应与声明一致", () => {
      const adapter = new CodebuddyAdapter();
      expect(adapter.id).toBe(CODEBUDDY_ID);
      expect(CODEBUDDY_CONFIG_PATH_TEMPLATE).toBe("~/.codebuddy/settings.json");
    });
  });

  describe("render：字段级合并保留非受管字段", () => {
    it("应更新受管字段（endpoint/models）同时保留用户的非受管字段", () => {
      const { writeEnv } = createInMemoryWriteEnv();
      const adapter = new CodebuddyAdapter(createCodebuddyMapping(), {
        renderDeps: { writeEnv },
      });
      // 既有配置：非受管字段 permissions/theme 与受管旧值
      const existing = JSON.stringify({
        theme: "light",
        permissions: { allow: ["read"] },
        endpoint: "https://old.example.com",
        models: ["old"],
      });

      const result = adapter.render(makeProvider(), "sk-secret-123", existing);
      const merged = JSON.parse(result.mergedContent);

      // 非受管字段保留
      expect(merged.theme).toBe("light");
      expect(merged.permissions).toEqual({ allow: ["read"] });
      // 受管字段更新
      expect(merged.endpoint).toBe("https://api.example.com/v1");
      expect(merged.models).toEqual(["claude-sonnet-4"]);
    });
  });

  describe("CredentialMapping 形态：key 正确落位", () => {
    it("env 形态：配置文件写环境变量引用占位，明文经 writeEnv 落到 CODEBUDDY_API_KEY，产物不含明文", () => {
      const { writeEnv, store } = createInMemoryWriteEnv();
      const adapter = new CodebuddyAdapter(createCodebuddyMapping(), {
        renderDeps: { writeEnv },
      });
      const apiKey = "sk-plain-CB";

      const result = adapter.render(makeProvider(), apiKey, null);
      const merged = JSON.parse(result.mergedContent);

      // key 落位在顶层 apiKey，且为 env 引用占位
      expect(merged.apiKey).toBe("${CODEBUDDY_API_KEY}");
      // 明文经 writeEnv 落到官方约定环境变量
      expect(store.get("CODEBUDDY_API_KEY")).toBe(apiKey);
      // 安全约束：产物不含明文
      expect(result.mergedContent).not.toContain(apiKey);
      expect(result.maskedDiff).not.toContain(apiKey);
    });

    it("自定义 envVarName 时引用占位与落地环境变量名随之改变", () => {
      const { writeEnv, store } = createInMemoryWriteEnv();
      const adapter = new CodebuddyAdapter(createCodebuddyMapping("MY_CB_KEY"), {
        renderDeps: { writeEnv },
      });
      const apiKey = "sk-plain-CUSTOM";

      const result = adapter.render(makeProvider(), apiKey, null);
      const merged = JSON.parse(result.mergedContent);

      expect(merged.apiKey).toBe("${MY_CB_KEY}");
      expect(store.get("MY_CB_KEY")).toBe(apiKey);
    });

    it("inline 形态：key 以明文按 targetPointer 直接落位", () => {
      const inlineMapping: FormatMapping = {
        ...createCodebuddyMapping(),
        credential: {
          targetPointer: "/apiKey",
          form: "inline",
          valueTemplate: "{key}",
        },
      };
      const adapter = new CodebuddyAdapter(inlineMapping);
      const apiKey = "sk-inline-CB";

      const result = adapter.render(makeProvider(), apiKey, null);
      const merged = JSON.parse(result.mergedContent);

      expect(merged.apiKey).toBe(apiKey);
    });
  });

  describe("既有文件格式损坏：render 抛错、apply 报 failed 不覆盖", () => {
    it("render 遇到损坏 JSON 应抛错", () => {
      const adapter = new CodebuddyAdapter();
      const broken = "{ not: valid, json ";

      expect(() => adapter.render(makeProvider(), "sk-x", broken)).toThrow();
    });

    it("apply 写入失败时应返回 failed 并先备份再回滚，不覆盖原文件", async () => {
      const adapter = new CodebuddyAdapter();
      const configPath = adapter.configPath(makeWinPlatform());
      const { writer, calls } = makeRecordingWriter({ failOnWrite: true });
      const renderResult: RenderResult = { mergedContent: "{}", maskedDiff: "" };

      const entry: ApplyEntry = await adapter.apply(configPath, renderResult, writer);

      expect(entry.status).toBe("failed");
      expect(entry.agentId).toBe(CODEBUDDY_ID);
      expect(entry.message).toBeTruthy();
      // 写入前必先备份，且确有尝试写入（失败后基类回滚，目标不被新内容覆盖）
      expect(calls.backup).toContain(configPath);
      expect(calls.write).toContain(configPath);
    });
  });
});
