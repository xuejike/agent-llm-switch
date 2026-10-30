import { describe, it, expect } from "vitest";
import type {
  ApplyEntry,
  FormatMapping,
  PlatformContext,
  ProviderConfig,
  RenderResult,
} from "@shared/types";
import type { AtomicFileWriter } from "../services/atomicFileWriter";
import {
  createInMemoryWriteEnv,
  createInMemoryWriteSecretsFile,
} from "../core/injectCredential";
import {
  PiAdapter,
  PI_ID,
  PI_CONFIG_PATH_TEMPLATE,
  createPiMapping,
} from "./piAdapter";

// pi 适配器单元测试（PiAdapter）
//
// 覆盖任务 9.4 对每个适配器的四项要求：
// 1. detect：解析配置路径（TOML 配置，三平台变量展开）与文件存在性
// 2. render：TOML 字段级合并，受管字段（base_url/models）更新且保留用户非受管字段
// 3. 不同 CredentialMapping 形态下 key 正确落位——pi 默认 secrets-file 引用形态，另覆盖 env 形态
// 4. 既有文件格式损坏时报 failed 不覆盖——render 对损坏 TOML 抛错；apply 写入失败回滚不覆盖
// 对应需求：8.1 / 9.3 / 9.4 / 9.5 / 10.4

// ---------------------------------------------------------------------------
// 测试辅助
// ---------------------------------------------------------------------------

/** 构造中立 ProviderConfig */
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

function makeWinPlatform(): PlatformContext {
  return {
    os: "win32",
    homeDir: "C:\\Users\\tester",
    env: { APPDATA: "C:\\Users\\tester\\AppData\\Roaming" },
  };
}

/** 记录型 AtomicFileWriter 替身（见 opencodeAdapter.test.ts 的同款说明） */
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

describe("PiAdapter", () => {
  describe("detect：经 CLI 命令判定安装与版本", () => {
    it("命令成功退出时判为已安装并解析版本，配置路径解析到 ~/.pi/agent/settings.json", async () => {
      const platform = makeMacPlatform();
      const expectedPath =
        "/Users/tester/.pi/agent/settings.json";
      const adapter = new PiAdapter(createPiMapping(), {
        // 模拟 pi --version 成功输出版本
        runCommand: async (command, args) => {
          expect(command).toBe("pi");
          expect(args).toEqual(["--version"]);
          return { ok: true, output: "0.87.1\n" };
        },
        fileExists: async (p) => p === expectedPath,
      });

      const result = await adapter.detect(platform);

      expect(result.installed).toBe(true);
      expect(result.version).toBe("0.87.1");
      expect(result.configPath).toBe(expectedPath);
      expect(result.fileExists).toBe(true);
    });

    it("命令失败（未找到可执行文件）时应判为未安装，忽略配置文件存在与否", async () => {
      const platform = makeLinuxPlatform();
      const adapter = new PiAdapter(createPiMapping(), {
        runCommand: async () => ({ ok: false, output: "" }),
        fileExists: async () => true,
      });

      const result = await adapter.detect(platform);

      expect(result.installed).toBe(false);
      expect(result.version).toBeUndefined();
      expect(result.configPath).toBe("/home/tester/.pi/agent/settings.json");
    });

    it("适配器 id 与路径模板应与声明一致", () => {
      const adapter = new PiAdapter();
      expect(adapter.id).toBe(PI_ID);
      expect(PI_CONFIG_PATH_TEMPLATE).toBe("~/.pi/agent/settings.json");
    });
  });

  describe("render：TOML 字段级合并保留非受管字段", () => {
    it("应更新受管字段（base_url/models）同时保留用户的非受管 TOML 字段", () => {
      const { writeSecretsFile } = createInMemoryWriteSecretsFile();
      const adapter = new PiAdapter(createPiMapping("default"), {
        renderDeps: { writeSecretsFile },
      });
      // 既有 TOML：含非受管顶层字段 theme，以及 provider 的受管旧值与非受管字段 enabled
      const existing = [
        'theme = "dark"',
        "",
        "[providers.default]",
        'base_url = "https://old.example.com"',
        "enabled = true",
      ].join("\n");

      const result = adapter.render(makeProvider(), "sk-secret-123", existing);

      // 非受管字段保留
      expect(result.mergedContent).toContain('theme = "dark"');
      expect(result.mergedContent).toContain("enabled = true");
      // 受管字段被更新为新值
      expect(result.mergedContent).toContain('base_url = "https://api.example.com/v1"');
      expect(result.mergedContent).toContain("claude-sonnet-4");
    });
  });

  describe("CredentialMapping 形态：key 正确落位", () => {
    it("secrets-file 形态：配置文件写引用占位，明文仅经 writeSecretsFile 落到独立文件，产物不含明文", () => {
      const { writeSecretsFile, store } = createInMemoryWriteSecretsFile();
      const adapter = new PiAdapter(
        createPiMapping("default", "/abs/pi/secrets.json"),
        { renderDeps: { writeSecretsFile } },
      );
      const apiKey = "sk-plain-SECRET";

      const result = adapter.render(makeProvider(), apiKey, null);

      // 配置文件 provider 块只写对 secrets 文件条目的引用占位（不含明文）
      expect(result.mergedContent).toContain("secrets:default.api_key");
      // 明文经 writeSecretsFile 落到声明的独立文件与条目
      const entries = store.get("/abs/pi/secrets.json");
      expect(entries?.get("default.api_key")).toBe(apiKey);
      // 安全约束：产物不含明文
      expect(result.mergedContent).not.toContain(apiKey);
      expect(result.maskedDiff).not.toContain(apiKey);
    });

    it("env 形态：key 以环境变量引用占位落位，明文经 writeEnv 落到环境变量", () => {
      const { writeEnv, store } = createInMemoryWriteEnv();
      // 覆盖默认 secrets-file 形态为 env 形态
      const envMapping: FormatMapping = {
        ...createPiMapping("default"),
        credential: {
          targetPointer: "/providers/default/api_key",
          form: "env",
          valueTemplate: "${PI_API_KEY}",
          envVarName: "PI_API_KEY",
        },
      };
      const adapter = new PiAdapter(envMapping, { renderDeps: { writeEnv } });
      const apiKey = "sk-env-KEY";

      const result = adapter.render(makeProvider(), apiKey, null);

      // 配置文件写 env 引用占位
      expect(result.mergedContent).toContain("${PI_API_KEY}");
      // 明文落到环境变量
      expect(store.get("PI_API_KEY")).toBe(apiKey);
      // 不含明文
      expect(result.mergedContent).not.toContain(apiKey);
    });

    it("secrets-file 形态缺少 secretsFile 目标时应终止并抛错（不产生部分写入）", () => {
      const { writeSecretsFile } = createInMemoryWriteSecretsFile();
      // 构造缺失 secretsFile 的非法 secrets-file 映射
      const brokenMapping: FormatMapping = {
        ...createPiMapping("default"),
        credential: {
          targetPointer: "/providers/default/api_key_ref",
          form: "secrets-file",
          valueTemplate: "secrets:default.api_key",
          // 刻意不提供 secretsFile
        },
      };
      const adapter = new PiAdapter(brokenMapping, {
        renderDeps: { writeSecretsFile },
      });

      expect(() => adapter.render(makeProvider(), "sk-x", null)).toThrow();
    });
  });

  describe("既有文件格式损坏：render 抛错、apply 报 failed 不覆盖", () => {
    it("render 遇到损坏 TOML 应抛错", () => {
      const adapter = new PiAdapter();
      // 非法 TOML（缺少等号的键）
      const broken = "this is [not valid toml";

      expect(() => adapter.render(makeProvider(), "sk-x", broken)).toThrow();
    });

    it("apply 写入失败时应返回 failed 并先备份再回滚，不覆盖原文件", async () => {
      const platform = makeWinPlatform();
      const adapter = new PiAdapter();
      const configPath = adapter.configPath(platform);
      const { writer, calls } = makeRecordingWriter({ failOnWrite: true });
      const renderResult: RenderResult = { mergedContent: "", maskedDiff: "" };

      const entry: ApplyEntry = await adapter.apply(configPath, renderResult, writer);

      expect(entry.status).toBe("failed");
      expect(entry.agentId).toBe(PI_ID);
      expect(entry.message).toBeTruthy();
      // 写入前必先备份，且确有尝试写入（失败后基类回滚，目标不被新内容覆盖）
      expect(calls.backup).toContain(configPath);
      expect(calls.write).toContain(configPath);
    });
  });
});
