// workbuddy 适配器（WorkbuddyAdapter）
//
// 本模块实现对 workbuddy（腾讯系 AI 工作助手 agent）的数据驱动适配：声明一份
// FormatMapping（含 CredentialMapping），把供应商中立的 ProviderConfig 映射到
// workbuddy 的配置文件格式，复用任务 9.1 的 BaseAdapter 完成通用流程
//（对应需求 8.1 / 9.1 / 9.6 / 9.7）。
//
// workbuddy 配置约定（依据公开文档：登录流程/CLI 会写入 settings.json，API Key 可经
// 环境变量提供；精确 schema 随版本变化，采用数据驱动声明，后续只需调整本映射）：
//   - 用户级配置文件：~/.config/workbuddy/settings.json（JSON 格式）。
//   - provider/模型相关设置以顶层字段或 provider 块表达；此处把 baseUrl 与 models 作为
//     受管字段写入配置。
//   - key 表达（安全优先，需求 9.6）：采用环境变量引用形态——配置文件只写 env 引用占位，
//     明文落到环境变量（WORKBUDDY_API_KEY），配置文件本身不含明文。
//
// 关键约束：key 的 workbuddy 差异（字段名/位置/env 引用形式）全部在 render 内经
// CredentialMapping 由 injectCredential 转换，绝不污染中立 ProviderConfig（需求 9.1 / 9.7）。

import type { FormatMapping } from "@shared/types";
import { BaseAdapter, type BaseAdapterDeps } from "./base";

/** workbuddy 的 agent 唯一标识 */
export const WORKBUDDY_ID = "workbuddy";

/**
 * workbuddy 的配置文件路径模板（按平台声明）。
 *
 * WorkBuddy 是 Electron 桌面应用（非 CLI），其用户数据/配置落在各平台的 Electron userData 目录：
 *   - win32：%APPDATA%\WorkBuddy（本机实测含 Preferences、Local State、User 等）
 *   - darwin：~/Library/Application Support/WorkBuddy
 *   - linux：~/.config/WorkBuddy
 * 这里登记该用户数据目录下的 Preferences 作为「配置文件存在性」锚点（供 fileExists 展示
 * 已安装·已有配置 / 将创建配置）。
 *
 * 注：WorkBuddy 的 provider/模型分发写入 schema 仍需按其真实配置结构核实（Electron userData
 * 下的 Preferences 为浏览器偏好，未必是分发目标）；该项属分发映射范畴，与本处的
 * 「安装探测（见 WORKBUDDY_DETECT_FILE）/ 配置文件探测路径」相互独立。
 */
export const WORKBUDDY_CONFIG_PATH_TEMPLATE = {
  win32: "%APPDATA%/WorkBuddy/Preferences",
  darwin: "~/Library/Application Support/WorkBuddy/Preferences",
  linux: "~/.config/WorkBuddy/Preferences",
};

/**
 * workbuddy 的安装探测标志文件（按平台声明）。
 *
 * WorkBuddy 为桌面应用、无 `workbuddy --version` 命令，故以安装目录下的 install-manifest.json
 * 作为安装判定锚点，并从其 appVersion 字段读取应用版本（本机实测：win 安装目录为
 * %LOCALAPPDATA%\Programs\WorkBuddy，install-manifest.json 的 appVersion=5.7.7，与应用「关于」
 * 对话框一致）。
 *
 * mac/linux 的安装路径依 Electron 应用常见约定给出，尚待在对应平台核实；核实后按需调整。
 */
export const WORKBUDDY_DETECT_FILE_PATH = {
  win32: "%LOCALAPPDATA%/Programs/WorkBuddy/resources/install-manifest.json",
  darwin: "/Applications/WorkBuddy.app/Contents/Resources/install-manifest.json",
  linux: "/opt/WorkBuddy/resources/install-manifest.json",
};

/** workbuddy 环境变量引用所用的环境变量名 */
const WORKBUDDY_ENV_VAR = "WORKBUDDY_API_KEY";

/**
 * 构造 workbuddy 的 FormatMapping。
 *
 * 字段映射遵循 workbuddy 的 settings.json 结构；受管字段仅覆盖 baseUrl 与 models。
 * 凭据走 env 引用形态：apiKey 字段写 "${WORKBUDDY_API_KEY}" 占位，明文经 writeEnv 落到环境变量。
 *
 * @param envVarName 环境变量名（默认 WORKBUDDY_API_KEY，允许上层按需覆盖）
 * @returns workbuddy 的格式映射声明
 */
export function createWorkbuddyMapping(envVarName: string = WORKBUDDY_ENV_VAR): FormatMapping {
  return {
    // workbuddy 配置为标准 JSON
    format: "json",
    // 中立逻辑字段 → workbuddy 配置中的 JSON 指针位置
    fieldPaths: {
      // API 基础地址落在顶层 model.baseUrl
      baseUrl: "/model/baseUrl",
      // 已选分发模型落在顶层 model.models（数组）
      models: "/model/models",
    },
    // 受本程序管理的字段：仅 baseUrl 与 models
    managedPaths: ["baseUrl", "models"],
    // 凭据声明：env 引用形态（安全优先）
    credential: {
      // key 的引用写入 model.apiKey
      targetPointer: "/model/apiKey",
      form: "env",
      // env 引用写法（${VAR}）；配置文件只保留引用，不含明文
      valueTemplate: `\${${envVarName}}`,
      // 明文实际写入的环境变量名
      envVarName,
    },
  };
}

/**
 * workbuddy 适配器：继承 BaseAdapter，仅声明 workbuddy 的差异（id/displayName/路径/映射）。
 *
 * 通用流程复用基类；key 的 workbuddy 差异在 render 内经 CredentialMapping 转换，不污染 ProviderConfig。
 */
export class WorkbuddyAdapter extends BaseAdapter {
  /**
   * @param mapping 可选的 FormatMapping 覆盖（默认 createWorkbuddyMapping()）
   * @param deps    可选的基类依赖（文件存在性检查 / render 依赖），便于测试注入
   */
  constructor(mapping: FormatMapping = createWorkbuddyMapping(), deps: BaseAdapterDeps = {}) {
    super(
      {
        id: WORKBUDDY_ID,
        displayName: "WorkBuddy",
        configPathTemplate: WORKBUDDY_CONFIG_PATH_TEMPLATE,
        mapping,
        // 桌面应用：以安装目录下 install-manifest.json 判定安装，并取其 appVersion 作为版本
        detectFile: {
          pathTemplate: WORKBUDDY_DETECT_FILE_PATH,
          version: { jsonField: "appVersion" },
        },
      },
      deps,
    );
  }
}
