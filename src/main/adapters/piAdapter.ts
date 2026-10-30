// pi 适配器（PiAdapter）
//
// 本模块实现对 pi（终端 AI agent）的数据驱动适配：声明一份 FormatMapping（含
// CredentialMapping），把供应商中立的 ProviderConfig 映射到 pi 的配置文件格式，
// 复用任务 9.1 的 BaseAdapter 完成通用 detect/configPath/render/apply 流程
//（对应需求 8.1 / 9.1 / 9.6 / 9.7）。
//
// pi 配置约定（pi 的精确 schema 随版本可能变化；依据 design.md 数据驱动映射约定给出
// 合理且可通过字段级合并测试的声明，后续只需按实际调研调整本映射，不改核心逻辑）：
//   - 全局配置文件：~/.config/pi/config.toml（TOML 格式——对 TOML 做一次字段级合并覆盖）。
//   - provider 以 [providers.<name>] 表声明，含 base_url 与 models；
//     TOML 以 "/providers/<name>/..." 的指针式路径表达嵌套表。
//   - key 表达（安全优先，需求 9.6）：pi 采用「独立 secrets 文件引用」形态——配置文件里
//     只写对独立 secrets 文件条目的引用占位，明文落到独立 secrets 文件
//     （~/.config/pi/secrets.json 的对应条目），配置文件本身不含明文。
//
// 关键约束：key 的 pi 差异（字段名/位置/secrets-file 引用形式）全部在 render 内经
// CredentialMapping 由 injectCredential 转换，绝不污染中立 ProviderConfig（需求 9.1 / 9.7）。

import type { FormatMapping } from "@shared/types";
import { BaseAdapter, type BaseAdapterDeps } from "./base";

/** pi 的 agent 唯一标识 */
export const PI_ID = "pi";

/**
 * pi 的配置文件路径模板。
 *
 * pi 在「所有平台」都把配置放在 home 目录下的 ~/.pi/agent/（可由环境变量 PI_CODING_AGENT_DIR
 * 覆盖，缺省即 ~/.pi/agent；依据 pi --help 的环境变量说明与本机实测：目录内含 settings.json、
 * models.json、auth.json 等）。主配置文件为 settings.json（JSON 格式）。
 * 故用以 ~ 开头的三平台统一模板，交由 PathResolver 展开 ~ 为绝对路径。
 *
 * 注：pi 的 provider/模型分发写入 schema 与本程序既有 FormatMapping 尚需按真实 settings.json
 * 结构进一步对齐（本机当前 settings.json 仅含 theme 等），该项属分发映射范畴，与本处的
 * 「安装/配置文件探测路径」相互独立。
 */
export const PI_CONFIG_PATH_TEMPLATE = "~/.pi/agent/settings.json";

/**
 * pi 的独立 secrets 文件路径模板。
 *
 * secrets-file 形态下，明文密钥落到该文件对应条目，配置文件里只保留引用占位。
 * 同样以相对路径交给 PathResolver；注意：injectCredential 的 writeSecretsFile 依赖
 * 期望收到已解析的绝对路径，故在构造具体适配器实例时应由上层注入已解析路径，
 * 或由分发编排器在落盘前完成平台变量解析（本映射给出模板，保持与运行平台无关）。
 */
export const PI_SECRETS_PATH_TEMPLATE = "pi/secrets.json";

/**
 * 构造 pi 的 FormatMapping。
 *
 * 字段映射遵循 pi 的 [providers.<name>] 结构（TOML）；受管字段仅覆盖 base_url 与 models。
 * 凭据走 secrets-file 引用形态：配置文件 provider 块的 api_key_ref 写引用占位，明文落到
 * 独立 secrets 文件的对应条目。
 *
 * @param providerName 目标 provider 名（用于拼接 TOML 指针与 secrets 条目键）；缺省 "default"
 * @param secretsFilePath secrets 文件路径（默认用模板；上层可注入已由 PathResolver 解析的绝对路径）
 * @returns pi 的格式映射声明
 */
export function createPiMapping(
  providerName = "default",
  secretsFilePath: string = PI_SECRETS_PATH_TEMPLATE,
): FormatMapping {
  // provider 表的基路径：/providers/<providerName>
  const base = `/providers/${providerName}`;
  // secrets 文件内的条目键：按 provider 名区分，避免多 provider 串用同一条目
  const entryKey = `${providerName}.api_key`;

  return {
    // pi 配置为 TOML
    format: "toml",
    // 中立逻辑字段 → pi 配置中的指针位置
    fieldPaths: {
      // base_url（下划线命名）落在 providers.<name>.base_url
      baseUrl: `${base}/base_url`,
      // 已选分发模型落在 providers.<name>.models（数组）
      models: `${base}/models`,
    },
    // 受本程序管理的字段：仅 base_url 与 models
    managedPaths: ["baseUrl", "models"],
    // 凭据声明：secrets-file 引用形态（安全优先，不写明文到配置文件）
    credential: {
      // 配置文件里 key 的引用位置：providers.<name>.api_key_ref
      targetPointer: `${base}/api_key_ref`,
      form: "secrets-file",
      // 引用占位：指向独立 secrets 文件的条目（不含明文；{providerName} 会被展开）
      valueTemplate: `secrets:${entryKey}`,
      // 明文实际落地的独立 secrets 文件与条目
      secretsFile: { path: secretsFilePath, entryKey },
    },
  };
}

/**
 * pi 适配器：继承 BaseAdapter，仅声明 pi 的差异（id/displayName/路径/映射）。
 *
 * 通用流程复用基类；key 的 pi 差异在 render 内经 CredentialMapping 转换，不污染 ProviderConfig。
 */
export class PiAdapter extends BaseAdapter {
  /**
   * @param mapping 可选的 FormatMapping 覆盖（默认 createPiMapping()）
   * @param deps    可选的基类依赖（文件存在性检查 / render 依赖），便于测试注入
   */
  constructor(mapping: FormatMapping = createPiMapping(), deps: BaseAdapterDeps = {}) {
    super(
      {
        id: PI_ID,
        displayName: "pi",
        configPathTemplate: PI_CONFIG_PATH_TEMPLATE,
        mapping,
        // 以 pi CLI 的版本命令判定安装与版本（本机实测：pi --version → 0.87.1）
        detectCommand: { command: "pi", args: ["--version"] },
      },
      deps,
    );
  }
}
