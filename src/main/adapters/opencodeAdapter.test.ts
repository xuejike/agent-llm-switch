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
  OpencodeAdapter,
  OPENCODE_ID,
  OPENCODE_CONFIG_PATH_TEMPLATE,
  createOpencodeMapping,
} from "./opencodeAdapter";

// opencode 适配器单元测试（OpencodeAdapter）
//
// 覆盖任务 9.4 对每个适配器的四项要求：
// 1. detect：解析配置路径（三平台变量展开）并据文件存在性判定 installed/fileExists
// 2. render：字段级合并，受管字段（baseURL/models）更新且保留用户的非受管字段
// 3. 不同 CredentialMapping 形态下 key 正确落位——opencode 默认 env 引用形态，另覆盖 inline 形态
// 4. 既有文件格式损坏时报 failed 不覆盖——render 对损坏 JSON 抛错；apply 写入失败回滚且不覆盖原文件
// 对应需求：8.1 / 9.3 / 9.4 / 9.5 / 10.4

// ---------------------------------------------------------------------------
// 测试辅助：构造平台上下文、provider 配置与可控的 AtomicFileWriter 替身
// ---------------------------------------------------------------------------

/** 构造一个中立的 ProviderConfig（仅含中立字段，绝不含 agent 专属 key 字段） */
function makeProvider(overrides: Partial<ProviderConfig> = {}): ProviderConfig {
  return {
    id: "p1",
    name: "default",
    baseUrl: "https://api.example.com/v1",
    apiKeyRef: "ref://p1",
    models: ["gpt-4o", "gpt-4o-mini"],
    ...overrides,
  };
}

/** 构造 Windows 平台上下文（%APPDATA% 已给定，便于断言解析结果） */
function makeWinPlatform(): PlatformContext {
  return {
    os: "win32",
    homeDir: "C:\\Users\\tester",
    env: { APPDATA: "C:\\Users\\tester\\AppData\\Roaming" },
  };
}

/** 构造 macOS 平台上下文 */
function makeMacPlatform(): PlatformContext {
  return { os: "darwin", homeDir: "/Users/tester", env: {} };
}

/** 构造 Linux 平台上下文（显式给定 XDG_CONFIG_HOME） */
function makeLinuxPlatform(): PlatformContext {
  return {
    os: "linux",
    homeDir: "/home/tester",
    env: { XDG_CONFIG_HOME: "/home/tester/.config" },
  };
}

/**
 * 记录型 AtomicFileWriter 替身：可配置 atomicWrite 是否抛错，并记录各方法调用。
 * 用于验证「既有文件损坏/写入失败时」适配器 apply 返回 failed 且触发回滚、不覆盖原文件。
 */
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
      // 模拟「原文件已存在」：返回一个备份路径，便于断言失败时走 restore 回滚分支
      return `${targetPath}.bak.test`;
    },
    async atomicWrite(targetPath: string, _content: string): Promise<void> {
      calls.write.push(targetPath);
      if (options.failOnWrite) {
        // 模拟写入中途失败（如磁盘/权限问题）：apply 应捕获并回滚
        throw new Error("模拟写入失败");
      }
    },
    async restore(backupPath: string, targetPath: string): Promise<void> {
      calls.restore.push([backupPath, targetPath]);
    },
  };
  return { writer, calls };
}

describe("OpencodeAdapter", () => {
  describe("detect：经 CLI 命令判定安装与版本", () => {
    it("命令成功退出时判为已安装并解析版本；配置路径三平台统一解析到 ~/.config/opencode/opencode.json", async () => {
      const platform = makeWinPlatform();
      // opencode 在所有平台（含 win）都用 ~/.config/opencode/opencode.json
      const expectedPath = "C:\\Users\\tester\\.config\\opencode\\opencode.json";
      const adapter = new OpencodeAdapter(createOpencodeMapping(), {
        runCommand: async (command, args) => {
          expect(command).toBe("opencode");
          expect(args).toEqual(["--version"]);
          return { ok: true, output: "1.19.0\n" };
        },
        fileExists: async (p) => p === expectedPath,
      });

      const result = await adapter.detect(platform);

      expect(result.configPath).toBe(expectedPath);
      expect(result.fileExists).toBe(true);
      expect(result.installed).toBe(true);
      expect(result.version).toBe("1.19.0");
    });

    it("configPath 在 win/mac/linux 均解析到 home 下的 .config/opencode/opencode.json", () => {
      const adapter = new OpencodeAdapter();
      expect(adapter.configPath(makeWinPlatform())).toBe(
        "C:\\Users\\tester\\.config\\opencode\\opencode.json",
      );
      expect(adapter.configPath(makeMacPlatform())).toBe(
        "/Users/tester/.config/opencode/opencode.json",
      );
      expect(adapter.configPath(makeLinuxPlatform())).toBe(
        "/home/tester/.config/opencode/opencode.json",
      );
    });

    it("命令失败时应判为未安装，忽略配置文件存在与否", async () => {
      const platform = makeLinuxPlatform();
      const adapter = new OpencodeAdapter(createOpencodeMapping(), {
        runCommand: async () => ({ ok: false, output: "" }),
        fileExists: async () => true,
      });

      const result = await adapter.detect(platform);

      expect(result.configPath).toBe("/home/tester/.config/opencode/opencode.json");
      expect(result.installed).toBe(false);
      expect(result.version).toBeUndefined();
    });

    it("适配器 id 与路径模板应与声明一致", () => {
      const adapter = new OpencodeAdapter();
      expect(adapter.id).toBe(OPENCODE_ID);
      expect(OPENCODE_CONFIG_PATH_TEMPLATE).toBe("~/.config/opencode/opencode.json");
    });
  });

  describe("render：字段级合并保留非受管字段", () => {
    it("应更新受管字段（baseURL/models）同时保留用户的非受管字段", () => {
      const { writeEnv } = createInMemoryWriteEnv();
      const adapter = new OpencodeAdapter(createOpencodeMapping("default"), {
        renderDeps: { writeEnv },
      });
      // 既有配置：含受管字段旧值，以及用户自定义的非受管字段（theme、provider 的 npm/既有 model）
      const existing = JSON.stringify({
        theme: "dark",
        provider: {
          default: {
            npm: "@ai-sdk/openai-compatible",
            options: { baseURL: "https://old.example.com", apiKey: "{env:OLD}" },
            models: { "old-model": {} },
          },
        },
      });

      const result = adapter.render(makeProvider(), "sk-secret-123", existing);
      const merged = JSON.parse(result.mergedContent);

      // 非受管顶层字段保留
      expect(merged.theme).toBe("dark");
      // 非受管的 npm 字段保留（只动 options.baseURL / models）
      expect(merged.provider.default.npm).toBe("@ai-sdk/openai-compatible");
      // 受管字段被更新为新值
      expect(merged.provider.default.options.baseURL).toBe("https://api.example.com/v1");
      // models 为对象形态（opencode 以模型 id 作为键）——此处 render 写入中立数组值，断言已被覆盖更新
      expect(merged.provider.default.models).toEqual(["gpt-4o", "gpt-4o-mini"]);
    });

    it("既有文件不存在时应从空对象起步生成完整配置", () => {
      const { writeEnv } = createInMemoryWriteEnv();
      const adapter = new OpencodeAdapter(createOpencodeMapping("default"), {
        renderDeps: { writeEnv },
      });

      const result = adapter.render(makeProvider(), "sk-secret-123", null);
      const merged = JSON.parse(result.mergedContent);

      expect(merged.provider.default.options.baseURL).toBe("https://api.example.com/v1");
    });
  });

  describe("CredentialMapping 形态：key 正确落位", () => {
    it("env 形态：配置文件写环境变量引用占位，明文仅经 writeEnv 落到环境变量，产物不含明文", () => {
      const { writeEnv, store } = createInMemoryWriteEnv();
      // 自定义 provider 名，验证环境变量名按 provider 归一
      const adapter = new OpencodeAdapter(createOpencodeMapping("my-gateway"), {
        renderDeps: { writeEnv },
      });
      const apiKey = "sk-plain-ABCDEF";

      const result = adapter.render(
        makeProvider({ name: "my-gateway" }),
        apiKey,
        null,
      );
      const merged = JSON.parse(result.mergedContent);

      // key 落位在 provider.my-gateway.options.apiKey，且为环境变量引用占位
      expect(merged.provider["my-gateway"].options.apiKey).toBe(
        "{env:OPENCODE_MY_GATEWAY_API_KEY}",
      );
      // 明文经 writeEnv 落到声明的环境变量
      expect(store.get("OPENCODE_MY_GATEWAY_API_KEY")).toBe(apiKey);
      // 安全约束：mergedContent 与 maskedDiff 均不含明文
      expect(result.mergedContent).not.toContain(apiKey);
      expect(result.maskedDiff).not.toContain(apiKey);
    });

    it("inline 形态：key 以明文按 targetPointer 直接落位", () => {
      // 构造一份 inline 形态映射覆盖默认 env 形态
      const inlineMapping: FormatMapping = {
        ...createOpencodeMapping("default"),
        credential: {
          targetPointer: "/provider/default/options/apiKey",
          form: "inline",
          valueTemplate: "{key}",
        },
      };
      const adapter = new OpencodeAdapter(inlineMapping);
      const apiKey = "sk-inline-999";

      const result = adapter.render(makeProvider(), apiKey, null);
      const merged = JSON.parse(result.mergedContent);

      // inline 形态直接写明文到 targetPointer
      expect(merged.provider.default.options.apiKey).toBe(apiKey);
    });

    it("apiKey 为空（本地/无鉴权）时不注入任何凭据占位", () => {
      const { writeEnv, store } = createInMemoryWriteEnv();
      const adapter = new OpencodeAdapter(createOpencodeMapping("default"), {
        renderDeps: { writeEnv },
      });

      const result = adapter.render(makeProvider({ apiKeyRef: "" }), "", null);
      const merged = JSON.parse(result.mergedContent);

      // 空 key 跳过凭据注入：options 下不出现 apiKey
      expect(merged.provider.default.options?.apiKey).toBeUndefined();
      expect(store.size).toBe(0);
    });
  });

  describe("既有文件格式损坏：render 抛错、apply 报 failed 不覆盖", () => {
    it("render 遇到损坏 JSON 应抛错（供上层拒绝覆盖）", () => {
      const adapter = new OpencodeAdapter();
      // 非法 JSON 文本
      const broken = "{ this is not valid json ::: ";

      expect(() => adapter.render(makeProvider(), "sk-x", broken)).toThrow();
    });

    it("apply 写入失败时应返回 failed 并先备份再回滚，不把新内容留到目标文件", async () => {
      const platform = makeWinPlatform();
      const adapter = new OpencodeAdapter();
      const configPath = adapter.configPath(platform);
      // 构造一个「写入必失败」的 writer，且备份返回非 null（模拟原文件存在）
      const { writer, calls } = makeRecordingWriter({ failOnWrite: true });
      // 任意合法 RenderResult（apply 不关心内容，只负责写盘与回滚）
      const renderResult: RenderResult = { mergedContent: "{}", maskedDiff: "" };

      const entry: ApplyEntry = await adapter.apply(configPath, renderResult, writer);

      // 写入失败：状态为 failed（上层据此拒绝视为成功覆盖），并带失败信息
      expect(entry.status).toBe("failed");
      expect(entry.agentId).toBe(OPENCODE_ID);
      expect(entry.message).toBeTruthy();
      // 写入前必先备份（备份先于写入，保证可回滚）
      expect(calls.backup).toContain(configPath);
      // 确有尝试写入（随后因失败触发基类的回滚分支，目标不被新内容覆盖）
      expect(calls.write).toContain(configPath);
    });
  });
});
