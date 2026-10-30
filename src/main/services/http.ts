// 可注入的 HTTP 发送抽象（httpSend）
//
// 本模块封装「发送一次 HTTP 请求」这一底层能力，供模型发现（fetchModels）与
// 模型探测（probeModels）复用。设计目标：
// - 复用鉴权注入阶段（injectAuth）就地构造的 HttpRequest 作为请求对象形状，避免重复定义；
// - 支持单请求超时（基于 AbortController，服务未启动/网络慢时快速失败而非长时间阻塞）；
// - 支持代理注入（proxy 可选；本地/自托管场景通常不走代理）；
// - 把「如何发送」抽象为可注入的 HttpSend 接口——生产用基于 Node fetch 的默认实现，
//   测试注入 mock，从而 CI 绝不访问真实外网。
//
// 安全与副作用约束：
// - 本模块不负责鉴权注入（由 injectAuth 完成），也不读取/回传明文密钥；
//   请求头里可能已含鉴权信息，本模块不记录、不打印请求头与请求体。
// - 发送是只读语义的底层动作本身不写任何本地配置；调用方自行决定请求方法与载荷。

import type { ProxyConfig } from "@shared/types";
import type { HttpRequest } from "../core/injectAuth";

/**
 * 一次 HTTP 响应的归一化结果。
 *
 * body 做了「智能解析」：响应为 JSON（Content-Type 含 application/json，或文本可被 JSON.parse）
 * 时返回解析后的对象/数组/值；否则返回原始文本字符串。调用方（如 fetchModels 的
 * responseMapping）据此按指针取值，无需各自重复解析。
 */
export interface HttpResponse {
  /** HTTP 状态码（如 200、401、500） */
  status: number;
  /** 响应头集合（头名统一小写，便于大小写无关地查找） */
  headers: Record<string, string>;
  /** 解析后的响应体：JSON 成功则为解析值，否则为原始文本字符串 */
  body: unknown;
  /** 本次请求的往返耗时（毫秒），用于探测延迟展示 */
  latencyMs: number;
}

/**
 * httpSend 的可选控制参数。
 */
export interface HttpSendOptions {
  /**
   * 单请求超时（毫秒）。超时后请求被中止并以超时错误拒绝。
   * 缺省表示不设超时（交由底层默认行为）；探测场景应显式传入以保证快速失败。
   */
  timeout?: number;
  /**
   * 代理设置（可选）。声明后请求经由该代理发送；本地/自托管 provider 通常无需代理。
   * 具体代理实现由默认实现在运行时按能力装配（见下方 createDefaultHttpSend 说明）。
   */
  proxy?: ProxyConfig;
}

/**
 * HTTP 发送函数签名接口：输入一个已构造好的请求对象与控制参数，返回归一化响应。
 *
 * 之所以抽象为可注入的函数类型：
 * - 生产环境注入基于 Node fetch 的默认实现（createDefaultHttpSend）；
 * - 单元/属性测试注入 mock（返回预置响应），从而不依赖真实外网，满足「CI 禁止真实外网」。
 *
 * @param req     待发送的请求对象（鉴权已由 injectAuth 就地注入到 headers/query）
 * @param options 超时与代理等控制参数
 * @returns 归一化后的响应（含状态码、响应头、解析后的 body、往返延迟）
 * @throws  超时、网络不可达、连接被拒绝等传输层错误（非 2xx 不抛错，由状态码体现）
 */
export type HttpSend = (req: HttpRequest, options?: HttpSendOptions) => Promise<HttpResponse>;

/**
 * 代理装配器：把 ProxyConfig 转换为可供 fetch 使用的 dispatcher（undici ProxyAgent 之类）。
 *
 * 之所以抽象为可注入依赖而非在本模块硬编码 import undici：
 * - 保持本模块对具体代理实现零硬依赖，便于测试与裁剪；
 * - 运行时由上层按环境能力装配（Node/Electron 内置 undici），本模块只负责「用」。
 * 返回值作为 fetch 的 dispatcher 透传；返回 undefined 表示不使用代理。
 */
export type ProxyDispatcherFactory = (proxy: ProxyConfig) => unknown;

/**
 * 默认实现的可注入依赖。
 */
export interface DefaultHttpSendDeps {
  /**
   * fetch 实现，默认取全局 fetch（Node 18+ / Electron 主进程内置）。
   * 允许注入便于在无全局 fetch 的环境或测试中替换。
   */
  fetchImpl?: typeof fetch;
  /**
   * 代理 dispatcher 装配器（可选）。声明且请求带 proxy 时，用它构造 dispatcher 注入 fetch；
   * 未声明则忽略 proxy（由上层决定是否要求代理能力）。
   */
  proxyDispatcherFactory?: ProxyDispatcherFactory;
}

/**
 * 把一个 HttpRequest 的 url 与 query 合并为最终请求 URL。
 *
 * injectAuth 的 query 形态鉴权会把 {key} 写入 req.query，这里统一追加到 URL 查询串，
 * 保留 url 中已有的查询参数（不覆盖），再附加 query 中的键值。
 */
function buildUrl(req: HttpRequest): string {
  if (!req.query || Object.keys(req.query).length === 0) {
    return req.url;
  }
  // 以 req.url 为基准构造 URL 对象，逐个追加 query 键值
  const u = new URL(req.url);
  for (const [name, value] of Object.entries(req.query)) {
    u.searchParams.set(name, value);
  }
  return u.toString();
}

/**
 * 大小写无关地判断请求头集合中是否已存在某个头名。
 * 用于在补默认 Content-Type 前检查调用方是否已显式声明（避免覆盖）。
 */
function hasHeaderCaseInsensitive(
  headers: Record<string, string>,
  name: string,
): boolean {
  const target = name.toLowerCase();
  return Object.keys(headers).some((k) => k.toLowerCase() === target);
}

/**
 * 把 fetch 的 Headers 归一化为「头名小写」的普通对象，便于大小写无关查找。
 */
function normalizeHeaders(headers: Headers): Record<string, string> {
  const result: Record<string, string> = {};
  headers.forEach((value, key) => {
    result[key.toLowerCase()] = value;
  });
  return result;
}

/**
 * 判定响应是否应按 JSON 解析：Content-Type 含 application/json 视为 JSON。
 */
function isJsonContentType(headers: Record<string, string>): boolean {
  const contentType = headers["content-type"] ?? "";
  return contentType.toLowerCase().includes("application/json");
}

/**
 * 智能解析响应体：
 * - Content-Type 标明 JSON：按 JSON 解析（解析失败则退回原始文本，避免因服务端瑕疵抛错）；
 * - 否则：返回原始文本字符串。
 */
function parseBody(rawText: string, headers: Record<string, string>): unknown {
  if (rawText.length === 0) {
    // 空响应体统一返回空字符串，交由调用方处理
    return "";
  }
  if (isJsonContentType(headers)) {
    try {
      return JSON.parse(rawText) as unknown;
    } catch {
      // Content-Type 声称 JSON 但内容非法：退回原始文本，不中断调用方流程
      return rawText;
    }
  }
  return rawText;
}

/**
 * 创建基于 Node fetch 的默认 HttpSend 实现。
 *
 * 行为：
 * - 超时：options.timeout 存在时用 AbortController 在超时后中止请求，并以可识别的超时错误拒绝；
 * - 代理：options.proxy 存在且注入了 proxyDispatcherFactory 时，构造 dispatcher 透传给 fetch；
 * - 响应：统一归一化为 HttpResponse（状态码、小写头、智能解析的 body、往返延迟）；
 * - 错误：非 2xx 不抛错（由状态码体现，便于 fetchModels/probeModels 据状态码分类）；
 *   仅传输层错误（超时、连接被拒绝、DNS 失败等）以异常形式抛出。
 *
 * @param deps 可注入依赖（fetch 实现、代理装配器），便于测试与运行时能力装配
 */
export function createDefaultHttpSend(deps: DefaultHttpSendDeps = {}): HttpSend {
  const fetchImpl = deps.fetchImpl ?? globalThis.fetch;
  if (typeof fetchImpl !== "function") {
    // 运行环境缺少全局 fetch 时给出清晰错误，提示注入 fetchImpl
    throw new Error("当前环境无可用的全局 fetch，请通过 deps.fetchImpl 注入 fetch 实现");
  }

  return async function defaultHttpSend(req: HttpRequest, options: HttpSendOptions = {}): Promise<HttpResponse> {
    const url = buildUrl(req);
    const method = req.method ?? "GET";

    // 超时控制：用 AbortController 在超时后中止底层请求
    const controller = new AbortController();
    let timedOut = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    if (typeof options.timeout === "number" && options.timeout > 0) {
      timer = setTimeout(() => {
        timedOut = true;
        controller.abort();
      }, options.timeout);
    }

    // 组装 fetch 初始化参数
    // 说明：Node/undici 为 fetch 的 RequestInit 扩展了 dispatcher 字段用于代理注入，
    // 但其类型随运行时声明而定（Dispatcher）。此处把 init 收敛为「标准 RequestInit +
    // 可选 dispatcher 记录」的宽松结构体，dispatcher 以 unknown 承载装配器返回值，
    // 最终赋给 fetch 时整体断言为 RequestInit，不改变任何运行时行为。
    const init: Record<string, unknown> = {
      method,
      headers: req.headers,
      signal: controller.signal,
    };
    // 仅在有请求体时附加；对象体序列化为 JSON，字符串/Buffer 等原样透传
    if (req.body !== undefined && method !== "GET") {
      const isObjectBody = typeof req.body !== "string";
      init.body = isObjectBody ? JSON.stringify(req.body) : (req.body as string);
      // 对象体序列化为 JSON 时，若调用方未显式声明 Content-Type，则补默认的 application/json。
      // 许多 OpenAI 兼容网关要求显式 Content-Type，否则对无类型的 JSON 体返回 400。
      // 仅在缺省时补充（大小写无关查找已有头），绝不覆盖调用方显式设置的类型。
      if (isObjectBody && !hasHeaderCaseInsensitive(req.headers, "content-type")) {
        init.headers = { ...req.headers, "Content-Type": "application/json" };
      }
    }
    // 代理注入：有 proxy 且提供了装配器时，构造 dispatcher 透传给 fetch
    if (options.proxy && deps.proxyDispatcherFactory) {
      init.dispatcher = deps.proxyDispatcherFactory(options.proxy);
    }

    const start = Date.now();
    try {
      const response = await fetchImpl(url, init as RequestInit);
      const latencyMs = Date.now() - start;
      const headers = normalizeHeaders(response.headers);
      const rawText = await response.text();
      const body = parseBody(rawText, headers);
      return {
        status: response.status,
        headers,
        body,
        latencyMs,
      };
    } catch (err) {
      // 区分「超时中止」与其它传输层错误，给出可识别的错误信息
      if (timedOut) {
        throw new Error(`HTTP 请求超时（${options.timeout}ms）：${method} ${url}`);
      }
      // 其它错误（连接被拒绝、DNS 失败、网络不可达等）原样抛出，交由调用方分类处理
      throw err;
    } finally {
      if (timer !== undefined) {
        clearTimeout(timer);
      }
    }
  };
}
