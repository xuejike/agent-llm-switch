// ProviderConfig 配置校验纯函数
//
// 本模块对统一的「配置真相」ProviderConfig 做逐项校验，返回所有未通过项，
// 供 UI 的表单校验态逐项展示、并在分发前把关（校验失败则不执行分发）。
//
// 设计约束（参照 design.md 的 Data Models 校验规则与 requirements 1.5/1.6/1.7/4.4）：
// - name：长度 1 至 100 的非空字符串。
// - baseUrl：可解析的 http 或 https URL（本地场景允许指向 localhost / 127.0.0.1 / 自定义内网主机与端口）。
// - models：包含 1 至 50 个元素。
// - timeoutMs（若提供）：正整数。
// - 鉴权放宽规则：当 provider 标记为本地（isLocal=true）或其鉴权方式为无鉴权
//   （modelListing.auth.in="none" 或 kind="none"）时，apiKeyRef 允许为空，
//   且不要求其在 SecretStore 中可解析；否则 apiKeyRef 必须非空。
//   注：本纯函数不触达 SecretStore，仅做「是否要求非空」的静态校验，
//   明文的「可解析」校验由分发阶段（Distributor）在写盘前完成。
// - candidateModels 非空时，其中各模型 id 唯一。
//
// 本模块为纯函数，不含任何 I/O，便于单元测试与属性测试。

import type { ProviderConfig } from "@shared/types";

/** name 允许的最大长度 */
const NAME_MAX_LENGTH = 100;
/** models 允许的最大项数 */
const MODELS_MAX_COUNT = 50;

/** 单项校验错误：标识出错字段与可读原因 */
export interface ValidationError {
  /** 出错字段名，如 "name" / "baseUrl" / "models" / "timeoutMs" / "candidateModels" */
  field: string;
  /** 可读的错误原因（中文） */
  message: string;
}

/** 校验结果：是否通过与逐项错误列表 */
export interface ValidationResult {
  /** 是否全部校验通过（errors 为空时为 true） */
  valid: boolean;
  /** 未通过项列表；全部通过时为空数组 */
  errors: ValidationError[];
}

/**
 * 判断该 provider 是否为「无鉴权」场景——此时 apiKeyRef 允许为空。
 * 条件：标记为本地（isLocal=true），或其模型列表端点鉴权声明为无鉴权
 * （auth.in="none" 或 auth.kind="none"）。
 */
function isAuthRelaxed(config: ProviderConfig): boolean {
  if (config.isLocal === true) {
    return true;
  }
  const auth = config.modelListing?.auth;
  if (auth && (auth.in === "none" || auth.kind === "none")) {
    return true;
  }
  return false;
}

/**
 * 判断字符串是否为合法的 http/https URL。
 * 使用 URL 解析并限定协议为 http: 或 https:。
 */
function isValidHttpUrl(value: string): boolean {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return false;
  }
  return url.protocol === "http:" || url.protocol === "https:";
}

/**
 * 校验 ProviderConfig，返回逐项错误。
 *
 * 校验项：
 * - name：长度 1-100 的非空字符串。
 * - baseUrl：合法的 http/https URL。
 * - models：1-50 项。
 * - timeoutMs（若提供）：正整数。
 * - apiKeyRef：非无鉴权场景下必须非空（无鉴权场景放宽，允许为空）。
 * - candidateModels（若非空）：各模型 id 唯一。
 *
 * @param config 待校验的统一 Provider 配置
 * @returns 校验结果（valid 与逐项 errors）
 */
export function validate(config: ProviderConfig): ValidationResult {
  const errors: ValidationError[] = [];

  // name：长度 1-100 的非空字符串
  if (typeof config.name !== "string" || config.name.length < 1) {
    errors.push({ field: "name", message: "名称不能为空" });
  } else if (config.name.length > NAME_MAX_LENGTH) {
    errors.push({
      field: "name",
      message: `名称长度不能超过 ${NAME_MAX_LENGTH} 个字符`,
    });
  }

  // baseUrl：合法的 http/https URL
  if (typeof config.baseUrl !== "string" || !isValidHttpUrl(config.baseUrl)) {
    errors.push({
      field: "baseUrl",
      message: "baseUrl 必须是合法的 http 或 https 地址",
    });
  }

  // models：包含 1-50 个元素
  if (!Array.isArray(config.models) || config.models.length < 1) {
    errors.push({ field: "models", message: "至少需要选择 1 个模型" });
  } else if (config.models.length > MODELS_MAX_COUNT) {
    errors.push({
      field: "models",
      message: `模型数量不能超过 ${MODELS_MAX_COUNT} 个`,
    });
  }

  // timeoutMs（若提供）：正整数
  if (config.timeoutMs !== undefined) {
    if (!Number.isInteger(config.timeoutMs) || config.timeoutMs <= 0) {
      errors.push({
        field: "timeoutMs",
        message: "超时时间必须为正整数（毫秒）",
      });
    }
  }

  // apiKeyRef：非无鉴权场景下必须非空；无鉴权场景（本地或 auth=none）放宽允许为空
  if (!isAuthRelaxed(config)) {
    if (typeof config.apiKeyRef !== "string" || config.apiKeyRef.length < 1) {
      errors.push({
        field: "apiKeyRef",
        message: "该 Provider 需要 API Key，请先录入密钥",
      });
    }
  }

  // candidateModels（若非空）：各模型 id 唯一
  if (Array.isArray(config.candidateModels) && config.candidateModels.length > 0) {
    const seen = new Set<string>();
    const duplicated = new Set<string>();
    for (const model of config.candidateModels) {
      if (seen.has(model.id)) {
        duplicated.add(model.id);
      } else {
        seen.add(model.id);
      }
    }
    if (duplicated.size > 0) {
      errors.push({
        field: "candidateModels",
        message: `候选模型 id 存在重复：${Array.from(duplicated).join("、")}`,
      });
    }
  }

  return { valid: errors.length === 0, errors };
}
