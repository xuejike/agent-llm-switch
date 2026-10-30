// codebuddy 适配器（CodebuddyAdapter）
//
// 本模块实现对 codebuddy（腾讯云 CodeBuddy Code，终端 AI 编码 agent）的数据驱动适配：
// 声明一份 FormatMapping（含 CredentialMapping），把供应商中立的 ProviderConfig 映射到
// codebuddy 的配置文件格式，复用任务 9.1 的 BaseAdapter 完成通用流程
//（对应需求 8.1 / 9.1 / 9.6 / 9.7）。
//
// codebuddy 配置约定（依据公开文档：CodeBuddy Code 支持 CODEBUDDY_API_KEY 环境变量，
// CLI 会写入 settings.json；精确 schema 随版本变化，采用数据驱动声明，后续只需调整本映射）：
//   - 用户级配置文件：~/.config/codebuddy/settings.json（JSON 格式）。
//   - baseUrl（endpoint）与模型列表作为受管字段写入配置。
//   - key 表达（安全优先，需求 9.6）：采用环境变量引用形态——配置文件只写 env 引用占位，
//     明文落到官方约定的 CODEBUDDY_API_KEY 环境变量，配置文件本身不含明文。
//
// 关键约束：key 的 codebuddy 差异（字段名/位置/env 引用形式）全部在 render 内经
// CredentialMapping 由 injectCredential 转换，绝不污染中立 ProviderConfig（需求 9.1 / 9.7）。

import type { FormatMapping } from "@shared/types";
import { BaseAdapter, type BaseAdapterDeps } from "./base";

/** codebuddy 的 agent 唯一标识 */
export const CODEBUDDY_ID = "codebuddy";

/**
 * codebuddy 的配置文件路径模板（JSON）。
 *
 * CodeBuddy Code 的用户级配置在「所有平台」都位于 home 目录下的 ~/.codebuddy/settings.json
 * （依据腾讯云 CodeBuddy 文档与本机实测：Windows 下为 %USERPROFILE%\.codebuddy\settings.json），
 * 不落在 %APPDATA%。故用以 ~ 开头的三平台统一模板，交由 PathResolver 展开 ~ 为绝对路径。
 */
export const CODEBUDDY_CONFIG_PATH_TEMPLATE = "~/.codebuddy/settings.json";

/** codebuddy 官方约定的 API Key 环境变量名 */
const CODEBUDDY_ENV_VAR = "CODEBUDDY_API_KEY";

/**
 * 构造 codebuddy 的 FormatMapping。
 *
 * 字段映射遵循 codebuddy 的 settings.json 结构；受管字段仅覆盖 baseUrl 与 models。
 * 凭据走 env 引用形态：apiKey 字段写 "${CODEBUDDY_API_KEY}" 占位，明文经 writeEnv 落到
 * 官方约定的 CODEBUDDY_API_KEY 环境变量。
 *
 * @param envVarName 环境变量名（默认官方的 CODEBUDDY_API_KEY，允许上层按需覆盖）
 * @returns codebuddy 的格式映射声明
 */
export function createCodebuddyMapping(envVarName: string = CODEBUDDY_ENV_VAR): FormatMapping {
  return {
    // codebuddy 配置为标准 JSON
    format: "json",
    // 中立逻辑字段 → codebuddy 配置中的 JSON 指针位置
    fieldPaths: {
      // API 基础地址落在顶层 env.ANTHROPIC_BASE_URL 风格的 endpoint 字段：此处用 /endpoint
      baseUrl: "/endpoint",
      // 已选分发模型落在顶层 models（数组）
      models: "/models",
    },
    // 受本程序管理的字段：仅 baseUrl 与 models
    managedPaths: ["baseUrl", "models"],
    // 凭据声明：env 引用形态（安全优先，复用官方环境变量 CODEBUDDY_API_KEY）
    credential: {
      // key 的引用写入顶层 apiKey
      targetPointer: "/apiKey",
      form: "env",
      // env 引用写法（${VAR}）；配置文件只保留引用，不含明文
      valueTemplate: `\${${envVarName}}`,
      // 明文实际写入的环境变量名（官方约定）
      envVarName,
    },
  };
}

/**
 * codebuddy 适配器：继承 BaseAdapter，仅声明 codebuddy 的差异（id/displayName/路径/映射）。
 *
 * 通用流程复用基类；key 的 codebuddy 差异在 render 内经 CredentialMapping 转换，不污染 ProviderConfig。
 */
export class CodebuddyAdapter extends BaseAdapter {
  /**
   * @param mapping 可选的 FormatMapping 覆盖（默认 createCodebuddyMapping()）
   * @param deps    可选的基类依赖（文件存在性检查 / render 依赖），便于测试注入
   */
  constructor(mapping: FormatMapping = createCodebuddyMapping(), deps: BaseAdapterDeps = {}) {
    super(
      {
        id: CODEBUDDY_ID,
        displayName: "codebuddy",
        configPathTemplate: CODEBUDDY_CONFIG_PATH_TEMPLATE,
        mapping,
        // 以 codebuddy CLI 的版本命令判定安装与版本（本机实测：codebuddy --version → 2.45.1）
        detectCommand: { command: "codebuddy", args: ["--version"] },
      },
      deps,
    );
  }
}
