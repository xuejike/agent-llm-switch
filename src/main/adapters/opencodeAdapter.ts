// opencode 适配器（OpencodeAdapter）
//
// 本模块实现对 opencode（开源终端 AI 编码 agent）的数据驱动适配：声明一份
// FormatMapping（含 CredentialMapping），把供应商中立的 ProviderConfig 映射到
// opencode 的配置文件格式，复用任务 9.1 的 BaseAdapter 完成通用的
// detect/configPath/render/apply 流程（对应需求 8.1 / 9.1 / 9.6 / 9.7）。
//
// opencode 配置约定（依据社区文档/配置参考，数据驱动声明，随版本变化只需改本映射）：
//   - 全局配置文件：~/.config/opencode/opencode.json（JSON 格式）。
//   - provider 块以「provider 名」为键，结构形如：
//       {
//         "provider": {
//           "<providerName>": {
//             "npm": "@ai-sdk/openai-compatible",
//             "options": { "baseURL": "...", "apiKey": "{env:VAR}" },
//             "models": { "<modelId>": {} }
//           }
//         }
//       }
//   - key 表达：opencode 原生支持在 apiKey 字段写环境变量引用「{env:VAR}」，明文落到
//     环境变量，配置文件本身不含明文。遵循「安全优先」（需求 9.6），本适配器对 key 采用
//     env 引用形态而非明文内联。
//
// 关键约束：key 的 opencode 差异（字段名 apiKey、位置在 provider.<name>.options、引用形式
// {env:VAR}）全部在 render 内经 CredentialMapping 由 injectCredential 转换，绝不污染
// 供应商中立的 ProviderConfig（需求 9.1 / 9.7）。

import type { FormatMapping } from "@shared/types";
import { BaseAdapter, type BaseAdapterDeps } from "./base";

/** opencode 的 agent 唯一标识 */
export const OPENCODE_ID = "opencode";

/**
 * opencode 的配置文件路径模板。
 *
 * opencode 在「所有平台（含 Windows）」都把全局配置放在 ~/.config/opencode/opencode.json，
 * 并不遵循 Windows 的 %APPDATA% 或 macOS 的 Application Support 约定（依据 opencode 官方/
 * 社区文档与本机实测：Windows 下同样位于 %USERPROFILE%\.config\opencode\opencode.json）。
 * 故此处用以 ~ 开头的三平台统一模板，交由 PathResolver 展开 ~（win=USERPROFILE）为绝对路径。
 */
export const OPENCODE_CONFIG_PATH_TEMPLATE = "~/.config/opencode/opencode.json";

/**
 * opencode 环境变量引用所用的环境变量名模板。
 *
 * 形如 OPENCODE_<PROVIDERNAME>_API_KEY。provider 名在构造 mapping 时按具体 provider
 * 代入（见 createOpencodeMapping）；此处保留一个默认通用名以兼容未指定 provider 的场景。
 */
const OPENCODE_DEFAULT_ENV_VAR = "OPENCODE_API_KEY";

/**
 * 构造 opencode 的 FormatMapping。
 *
 * 字段映射遵循 opencode 的 provider.<providerName> 结构；受管字段仅覆盖本程序负责分发的
 * baseURL 与 models，npm 适配器字段等由用户或 opencode 既有配置保留（字段级合并只动受管路径）。
 * 凭据走 env 引用形态：apiKey 写 "{env:VAR}" 占位，明文经 writeEnv 落到环境变量。
 *
 * @param providerName 目标 provider 名（用于拼接 JSON 指针中的 provider 键与环境变量名）；
 *                     缺省为 "default"，实际分发时应由调用方按 ProviderConfig.name 传入
 * @returns opencode 的格式映射声明
 */
export function createOpencodeMapping(providerName = "default"): FormatMapping {
  // provider 块的基路径：/provider/<providerName>
  const base = `/provider/${providerName}`;
  // 环境变量名：按 provider 名大写归一，避免不同 provider 的 key 串用同一变量
  const envVarName = providerName === "default"
    ? OPENCODE_DEFAULT_ENV_VAR
    : `OPENCODE_${toEnvSegment(providerName)}_API_KEY`;

  return {
    // opencode 配置为标准 JSON
    format: "json",
    // 中立逻辑字段 → opencode 配置中的 JSON 指针位置
    fieldPaths: {
      // API 基础地址落在 provider.<name>.options.baseURL
      baseUrl: `${base}/options/baseURL`,
      // 已选分发模型落在 provider.<name>.models（对象键为模型 id）
      models: `${base}/models`,
    },
    // 受本程序管理的字段：仅 baseURL 与 models；其余（npm、name 等）保留用户设置
    managedPaths: ["baseUrl", "models"],
    // 凭据声明：env 引用形态（安全优先），key 字段名 apiKey、位置在 options 块
    credential: {
      // key 写入 provider.<name>.options.apiKey
      targetPointer: `${base}/options/apiKey`,
      // env 引用：配置文件只写占位，明文落到环境变量
      form: "env",
      // opencode 原生支持的环境变量引用写法
      valueTemplate: `{env:${envVarName}}`,
      // 明文实际写入的环境变量名
      envVarName,
    },
  };
}

/**
 * 把 provider 名归一为可用于环境变量名的大写片段。
 *
 * 规则：非字母数字字符替换为下划线，整体转大写。例如 "my-gateway" → "MY_GATEWAY"。
 *
 * @param name provider 名
 * @returns 适合拼进环境变量名的大写片段
 */
function toEnvSegment(name: string): string {
  return name.replace(/[^A-Za-z0-9]+/g, "_").replace(/^_+|_+$/g, "").toUpperCase();
}

/**
 * opencode 适配器：继承 BaseAdapter，仅声明 opencode 的差异（id/displayName/路径/映射）。
 *
 * 通用的 detect/configPath/render/apply 流程全部复用基类实现；key 的 opencode 差异在
 * render 内经 CredentialMapping 由 injectCredential 转换，不污染 ProviderConfig。
 */
export class OpencodeAdapter extends BaseAdapter {
  /**
   * @param mapping 可选的 FormatMapping 覆盖（默认用 createOpencodeMapping() 的声明）；
   *                允许上层按具体 provider 名注入定制映射，保持数据驱动可配置
   * @param deps    可选的基类依赖（文件存在性检查 / render 依赖），便于测试注入
   */
  constructor(mapping: FormatMapping = createOpencodeMapping(), deps: BaseAdapterDeps = {}) {
    super(
      {
        id: OPENCODE_ID,
        displayName: "opencode",
        configPathTemplate: OPENCODE_CONFIG_PATH_TEMPLATE,
        mapping,
        // 以 opencode CLI 的版本命令判定安装与版本（本机实测：opencode --version → 1.19.0）
        detectCommand: { command: "opencode", args: ["--version"] },
      },
      deps,
    );
  }
}
