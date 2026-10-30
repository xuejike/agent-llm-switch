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
  WorkbuddyAdapter,
  WORKBUDDY_ID,
  WORKBUDDY_CONFIG_PATH_TEMPLATE,
  WORKBUDDY_DETECT_FILE_PATH,
  createWorkbuddyMapping,
} from "./workbuddyAdapter";

// workbuddy 适配器单元测试（WorkbuddyAdapter）
//
// 覆盖任务 9.4 对每个适配器的四项要求：
// 1. detect：解析配置路径（settings.json，三平台变量展开）与文件存在性
// 2. render：JSON 字段级合并，受管字段（model.baseUrl/model.models）更新且保留非受管字段
// 3. 不同 CredentialMapping 形态下 key 正确落位——workbuddy 默认 env 引用形态，另覆盖 secrets-file 形态
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
    models: ["glm-4", "glm-4-air"],
    ...overrides,
  };
}

function makeWinPlatform(): PlatformContext {
  return {
    os: "win32",
    homeDir: "C:\\Users\\tester",
    env: {
      APPDATA: "C:\\Users\\tester\\AppData\\Roaming",
      LOCALAPPDATA: "C:\\Users\\tester\\AppData\\Local",
    },
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

describe("WorkbuddyAdapter", () => {
  describe("detect：桌面应用经安装标志文件判定安装与版本", () => {
    it("Windows 下以安装目录 install-manifest.json 判定已安装并读取 appVersion", async () => {
      const platform = makeWinPlatform();
      // 配置路径锚点：Electron userData 下的 Preferences
      const expectedConfigPath =
        "C:\\Users\\tester\\AppData\\Roaming\\WorkBuddy\\Preferences";
      // 安装标志文件：%LOCALAPPDATA%\Programs\WorkBuddy\resources\install-manifest.json
      const manifestPath =
        "C:\\Users\\tester\\AppData\\Local\\Programs\\WorkBuddy\\resources\\install-manifest.json";
      const adapter = new WorkbuddyAdapter(createWorkbuddyMapping(), {
        // 标志文件存在并返回含 appVersion 的 JSON，其它路径返回 null
        readFile: async (p) =>
          p === manifestPath ? JSON.stringify({ appVersion: "5.7.7" }) : null,
        // 配置文件（Preferences）存在
        fileExists: async (p) => p === expectedConfigPath,
      });

      const result = await adapter.detect(platform);

      expect(result.installed).toBe(true);
      expect(result.version).toBe("5.7.7");
      expect(result.configPath).toBe(expectedConfigPath);
      expect(result.fileExists).toBe(true);
    });

    it("安装标志文件不存在时应判为未安装（忽略配置文件存在与否）", async () => {
      const adapter = new WorkbuddyAdapter(createWorkbuddyMapping(), {
        readFile: async () => null,
        fileExists: async () => true,
      });

      const result = await adapter.detect(makeLinuxPlatform());

      expect(result.installed).toBe(false);
      expect(result.version).toBeUndefined();
    });

    it("标志文件存在但 JSON 损坏时仍判已安装，版本为 undefined", async () => {
      const adapter = new WorkbuddyAdapter(createWorkbuddyMapping(), {
        readFile: async () => "{ invalid json ,,, ",
        fileExists: async () => false,
      });

      const result = await adapter.detect(makeMacPlatform());

      expect(result.installed).toBe(true);
      expect(result.version).toBeUndefined();
    });

    it("configPath 按平台解析到各平台 Electron userData 下的 Preferences", () => {
      const adapter = new WorkbuddyAdapter();
      expect(adapter.configPath(makeWinPlatform())).toBe(
        "C:\\Users\\tester\\AppData\\Roaming\\WorkBuddy\\Preferences",
      );
      expect(adapter.configPath(makeMacPlatform())).toBe(
        "/Users/tester/Library/Application Support/WorkBuddy/Preferences",
      );
      expect(adapter.configPath(makeLinuxPlatform())).toBe(
        "/home/tester/.config/WorkBuddy/Preferences",
      );
    });

    it("适配器 id 与路径模板应与声明一致（按平台声明）", () => {
      const adapter = new WorkbuddyAdapter();
      expect(adapter.id).toBe(WORKBUDDY_ID);
      expect(WORKBUDDY_CONFIG_PATH_TEMPLATE.win32).toBe("%APPDATA%/WorkBuddy/Preferences");
      expect(WORKBUDDY_DETECT_FILE_PATH.win32).toBe(
        "%LOCALAPPDATA%/Programs/WorkBuddy/resources/install-manifest.json",
      );
    });
  });

  describe("render：字段级合并保留非受管字段", () => {
    it("应更新受管字段（model.baseUrl/model.models）同时保留用户的非受管字段", () => {
      const { writeEnv } = createInMemoryWriteEnv();
      const adapter = new WorkbuddyAdapter(createWorkbuddyMapping(), {
        renderDeps: { writeEnv },
      });
      // 既有配置：顶层非受管字段 ui，model 块内受管旧值与非受管字段 temperature
      const existing = JSON.stringify({
        ui: { lang: "zh-CN" },
        model: {
          baseUrl: "https://old.example.com",
          models: ["old"],
          temperature: 0.7,
        },
      });

      const result = adapter.render(makeProvider(), "sk-secret-123", existing);
      const merged = JSON.parse(result.mergedContent);

      // 非受管字段保留
      expect(merged.ui).toEqual({ lang: "zh-CN" });
      expect(merged.model.temperature).toBe(0.7);
      // 受管字段更新
      expect(merged.model.baseUrl).toBe("https://api.example.com/v1");
      expect(merged.model.models).toEqual(["glm-4", "glm-4-air"]);
    });
  });

  describe("CredentialMapping 形态：key 正确落位", () => {
    it("env 形态：配置文件写环境变量引用占位，明文经 writeEnv 落到 WORKBUDDY_API_KEY，产物不含明文", () => {
      const { writeEnv, store } = createInMemoryWriteEnv();
      const adapter = new WorkbuddyAdapter(createWorkbuddyMapping(), {
        renderDeps: { writeEnv },
      });
      const apiKey = "sk-plain-WB";

      const result = adapter.render(makeProvider(), apiKey, null);
      const merged = JSON.parse(result.mergedContent);

      // key 落位在 model.apiKey，且为 env 引用占位
      expect(merged.model.apiKey).toBe("${WORKBUDDY_API_KEY}");
      // 明文经 writeEnv 落到官方约定环境变量
      expect(store.get("WORKBUDDY_API_KEY")).toBe(apiKey);
      // 安全约束：产物不含明文
      expect(result.mergedContent).not.toContain(apiKey);
      expect(result.maskedDiff).not.toContain(apiKey);
    });

    it("secrets-file 形态：key 以引用占位落位，明文经 writeSecretsFile 落到独立文件", () => {
      const { writeSecretsFile, store } = createInMemoryWriteSecretsFile();
      // 覆盖默认 env 形态为 secrets-file 形态
      const secretsMapping: FormatMapping = {
        ...createWorkbuddyMapping(),
        credential: {
          targetPointer: "/model/apiKeyRef",
          form: "secrets-file",
          valueTemplate: "secrets:workbuddy.api_key",
          secretsFile: { path: "/abs/workbuddy/secrets.json", entryKey: "workbuddy.api_key" },
        },
      };
      const adapter = new WorkbuddyAdapter(secretsMapping, {
        renderDeps: { writeSecretsFile },
      });
      const apiKey = "sk-secrets-WB";

      const result = adapter.render(makeProvider(), apiKey, null);
      const merged = JSON.parse(result.mergedContent);

      expect(merged.model.apiKeyRef).toBe("secrets:workbuddy.api_key");
      const entries = store.get("/abs/workbuddy/secrets.json");
      expect(entries?.get("workbuddy.api_key")).toBe(apiKey);
      expect(result.mergedContent).not.toContain(apiKey);
    });

    it("env 形态缺少 envVarName 时应终止并抛错（不产生部分写入）", () => {
      const { writeEnv } = createInMemoryWriteEnv();
      const brokenMapping: FormatMapping = {
        ...createWorkbuddyMapping(),
        credential: {
          targetPointer: "/model/apiKey",
          form: "env",
          valueTemplate: "${WORKBUDDY_API_KEY}",
          // 刻意不提供 envVarName
        },
      };
      const adapter = new WorkbuddyAdapter(brokenMapping, {
        renderDeps: { writeEnv },
      });

      expect(() => adapter.render(makeProvider(), "sk-x", null)).toThrow();
    });
  });

  describe("既有文件格式损坏：render 抛错、apply 报 failed 不覆盖", () => {
    it("render 遇到损坏 JSON 应抛错", () => {
      const adapter = new WorkbuddyAdapter();
      const broken = "{ invalid json ,,, ";

      expect(() => adapter.render(makeProvider(), "sk-x", broken)).toThrow();
    });

    it("apply 写入失败时应返回 failed 并先备份再回滚，不覆盖原文件", async () => {
      const adapter = new WorkbuddyAdapter();
      const configPath = adapter.configPath(makeWinPlatform());
      const { writer, calls } = makeRecordingWriter({ failOnWrite: true });
      const renderResult: RenderResult = { mergedContent: "{}", maskedDiff: "" };

      const entry: ApplyEntry = await adapter.apply(configPath, renderResult, writer);

      expect(entry.status).toBe("failed");
      expect(entry.agentId).toBe(WORKBUDDY_ID);
      expect(entry.message).toBeTruthy();
      // 写入前必先备份，且确有尝试写入（失败后基类回滚，目标不被新内容覆盖）
      expect(calls.backup).toContain(configPath);
      expect(calls.write).toContain(configPath);
    });
  });
});
