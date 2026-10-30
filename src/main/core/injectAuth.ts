// 鉴权注入分派（injectAuth）
//
// 本模块负责把明文密钥按 provider 声明的 AuthInjection 注入到一次 HTTP 请求中。
// 它是模型发现（fetchModels）与模型探测（probeModels）构造请求时的统一鉴权入口，
// 对现有预设向后兼容：未显式声明 kind 时由 in + name + valueTemplate 推断行为。
//
// 分派规则（按 auth.in / auth.kind）：
// - none            → 跳过注入（本地/自托管场景，apiKeyRef 可为空，不读取也不要求密钥）
// - header / bearer → 把 {key} 注入请求头（Authorization: Bearer {key} 或自定义头如 x-api-key）
// - query           → 把 {key} 注入查询参数（如 Google Gemini 的 ?key={key}）
// - sigv4           → 委托专用的代码级签名适配器（AWS Bedrock 特例，实现见任务 8.2）
//
// 无论何种方式，声明的 extraHeaders（如 Anthropic 的 anthropic-version）都会一并附加。
//
// 设计约束：
// - 明文密钥仅在主进程内存中短暂存在；本模块不记录、不回传明文。
// - 本模块只做「注入」这一纯粹动作，HTTP 发送由可注入的 httpSend 负责（见任务 6.1）。

import type { AuthInjection } from "@shared/types";

/**
 * 一次 HTTP 请求的可变对象（供鉴权注入与 http 层复用）。
 *
 * 之所以在本模块本地定义并导出：鉴权注入需要在「构造请求」阶段就地改写请求头/查询参数，
 * 而 http 发送层（任务 6.1）也要消费同一形状的请求对象，故在此集中声明、供后续复用。
 */
export interface HttpRequest {
  /** 请求的完整 URL（查询参数注入会在此基础上追加 query 键值） */
  url: string;
  /** HTTP 方法，默认由调用方决定（列表多为 GET、探测多为 POST） */
  method?: "GET" | "POST";
  /** 请求头集合：鉴权头与 extraHeaders 都写入这里 */
  headers: Record<string, string>;
  /** 查询参数集合：query 形态鉴权把 {key} 写入这里 */
  query?: Record<string, string>;
  /** 请求体（探测的最小代价请求等），鉴权注入不改写它 */
  body?: unknown;
}

/**
 * SigV4 签名适配器接口占位。
 *
 * AWS Bedrock 使用 SigV4 对整个请求（方法、路径、头、载荷、时间戳）做派生签名，
 * 无法用简单的 header/query 值模板表达，需要代码级的专门适配器接管。
 * 本接口仅作为注入点占位，真实实现见任务 8.2（sigv4Adapter）。
 */
export interface Sigv4SignerAdapter {
  /**
   * 对给定请求做 SigV4 签名，就地写入所需的签名头（如 Authorization、X-Amz-Date 等）。
   * @param req    待签名的请求对象（将被就地改写）
   * @param apiKey 明文密钥材料（如 AK/SK 等，具体格式由实现约定）
   */
  sign(req: HttpRequest, apiKey: string): void;
}

/**
 * injectAuth 的可选依赖：注入 SigV4 签名适配器。
 *
 * 保持可注入而非硬编码，既便于单测（可注入 mock），也让本模块不必依赖任务 8 的具体实现。
 */
export interface InjectAuthDeps {
  /** SigV4 签名适配器（kind="sigv4" 时使用）；缺省时遇到 sigv4 将抛出未配置错误 */
  sigv4Signer?: Sigv4SignerAdapter;
}

/**
 * 推断有效的鉴权种类（kind）。
 *
 * 向后兼容：未显式声明 kind 时，按 in 推断——
 * in="none" → "none"；in="query" → "query"；in="header" → "header"。
 * header 形态下不强行区分 bearer/自定义头，统一按 valueTemplate 注入（bearer 只是模板的一种）。
 */
function resolveKind(auth: AuthInjection): NonNullable<AuthInjection["kind"]> {
  if (auth.kind) {
    return auth.kind;
  }
  // 缺省由注入位置推断，保持与现有预设声明兼容
  switch (auth.in) {
    case "none":
      return "none";
    case "query":
      return "query";
    case "header":
    default:
      return "header";
  }
}

/**
 * 按值模板把明文密钥展开为实际注入值。
 *
 * 用 {key} 占位明文密钥，如 "Bearer {key}" → "Bearer sk-xxx"、"{key}" → "sk-xxx"。
 * 未声明 valueTemplate 时：bearer 默认 "Bearer {key}"，其它默认裸 "{key}"。
 */
function renderValue(auth: AuthInjection, apiKey: string, kind: NonNullable<AuthInjection["kind"]>): string {
  const template = auth.valueTemplate ?? (kind === "bearer" ? "Bearer {key}" : "{key}");
  // 全局替换，兼容模板中出现多个 {key} 的少见情形
  return template.split("{key}").join(apiKey);
}

/**
 * 把声明的额外固定头附加到请求（如 Anthropic 的 anthropic-version）。
 *
 * 鉴权头已先行写入，extraHeaders 作为补充；若与鉴权头同名，以 extraHeaders 为准（供预设覆盖）。
 */
function applyExtraHeaders(req: HttpRequest, extraHeaders?: Record<string, string>): void {
  if (!extraHeaders) {
    return;
  }
  for (const [name, value] of Object.entries(extraHeaders)) {
    req.headers[name] = value;
  }
}

/**
 * 鉴权注入分派：按 auth.in / auth.kind 把密钥注入到请求对象（就地改写 req）。
 *
 * @param req    待注入的请求对象（headers/query 将被就地改写）
 * @param auth   鉴权注入声明（数据驱动，来自 provider 预设）
 * @param apiKey 明文密钥；none 形态下允许为空/undefined（不读取也不要求）
 * @param deps   可选依赖（如 SigV4 签名适配器）
 *
 * 行为：
 * - none  ：不注入任何鉴权头/查询，但仍附加 extraHeaders（若声明）。
 * - header/bearer：把 {key} 按模板写入名为 auth.name 的请求头（header 需要 name）。
 * - query ：把 {key} 按模板写入名为 auth.name 的查询参数（query 需要 name）。
 * - sigv4 ：委托注入的 SigV4 签名适配器（未注入适配器则抛出未配置错误）。
 */
export function injectAuth(
  req: HttpRequest,
  auth: AuthInjection,
  apiKey?: string,
  deps: InjectAuthDeps = {},
): void {
  const kind = resolveKind(auth);

  switch (kind) {
    case "none": {
      // 无鉴权：不注入任何密钥相关的头/查询；仅附加声明的额外固定头
      applyExtraHeaders(req, auth.extraHeaders);
      return;
    }

    case "sigv4": {
      // 特殊签名鉴权：委托专用代码级适配器（实现见任务 8.2）
      if (!deps.sigv4Signer) {
        throw new Error("未配置 SigV4 签名适配器，无法处理 kind=\"sigv4\" 的鉴权注入");
      }
      if (!apiKey) {
        throw new Error("SigV4 签名鉴权需要密钥材料，但 apiKey 为空");
      }
      deps.sigv4Signer.sign(req, apiKey);
      // 签名适配器之外仍允许附加声明的额外固定头
      applyExtraHeaders(req, auth.extraHeaders);
      return;
    }

    case "query": {
      // 查询参数注入 {key}
      if (!auth.name) {
        throw new Error("query 形态的鉴权注入缺少参数名 auth.name");
      }
      if (!apiKey) {
        throw new Error("query 形态的鉴权注入需要密钥，但 apiKey 为空");
      }
      const value = renderValue(auth, apiKey, kind);
      // 确保 query 容器存在再写入，避免覆盖既有查询参数
      const query = req.query ?? (req.query = {});
      query[auth.name] = value;
      applyExtraHeaders(req, auth.extraHeaders);
      return;
    }

    case "bearer":
    case "header":
    default: {
      // 请求头注入 {key}（Authorization: Bearer {key} 或自定义头如 x-api-key）
      if (!auth.name) {
        throw new Error("header 形态的鉴权注入缺少头名 auth.name");
      }
      if (!apiKey) {
        throw new Error("header 形态的鉴权注入需要密钥，但 apiKey 为空");
      }
      const value = renderValue(auth, apiKey, kind);
      req.headers[auth.name] = value;
      applyExtraHeaders(req, auth.extraHeaders);
      return;
    }
  }
}
