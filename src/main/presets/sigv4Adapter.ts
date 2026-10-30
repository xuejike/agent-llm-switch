// AWS SigV4 代码级签名适配器（sigv4Adapter）
//
// 本模块实现 injectAuth 在 kind="sigv4" 时委托的 Sigv4SignerAdapter 接口。
// AWS Bedrock 使用 SigV4（Signature Version 4）对整个请求（HTTP 方法、规范路径、
// 查询串、请求头、载荷哈希、时间戳）做派生签名，无法用简单的 header/query 值模板表达，
// 故需要一个代码级的专门适配器接管签名计算。
//
// 本适配器只做「对一次已构造好的请求就地写入签名头」这一件事：
//   - 复用 ModelListingConfig/ModelProbeConfig 构造出的同一个 HttpRequest（url/method/headers/body），
//     不改变其业务语义，仅追加 SigV4 要求的签名相关头（Authorization、X-Amz-Date 等）。
//   - region/service 优先使用构造参数，缺省时从请求 URL 的主机名解析
//     （形如 bedrock.us-east-1.amazonaws.com → service=bedrock, region=us-east-1）。
//
// 标准 SigV4 四步（AWS 文档约定）：
//   1) 构造规范请求（Canonical Request）：方法、规范 URI、规范查询串、规范头、签名头列表、载荷哈希
//   2) 构造待签字符串（String To Sign）：算法、时间戳、凭据范围、规范请求的哈希
//   3) 派生签名密钥（Signing Key）：对 "AWS4"+secretKey 逐级 HMAC（date → region → service → "aws4_request"）
//   4) 计算签名（Signature）：用签名密钥对待签字符串做 HMAC-SHA256
//
// 全程使用 Node 内置 crypto，不引入任何第三方 AWS SDK，保持与可注入 httpSend 一致的轻量实现。
//
// 设计约束：
//   - 明文密钥材料仅在内存中短暂使用；本模块不记录、不回传、不序列化任何明文或派生密钥。
//   - 本模块只「注入签名」，HTTP 发送仍由 httpSend 负责。

import { createHash, createHmac } from "node:crypto";
import type { HttpRequest, Sigv4SignerAdapter } from "../core/injectAuth";

/** SigV4 固定算法标识（HMAC-SHA256 派生）。 */
const SIGV4_ALGORITHM = "AWS4-HMAC-SHA256";
/** 凭据范围末尾固定的请求类型终止串。 */
const AWS4_REQUEST = "aws4_request";

/**
 * SigV4 签名适配器的构造参数。
 *
 * apiKey 材料的格式约定（见 sign 方法注释）之外，region/service 可在此显式指定；
 * 若不指定，则在签名时从请求 URL 的主机名自动解析。
 */
export interface Sigv4AdapterOptions {
  /**
   * AWS 区域（如 "us-east-1"）。
   * 缺省时从请求主机名解析（bedrock.us-east-1.amazonaws.com → us-east-1）。
   */
  region?: string;
  /**
   * AWS 服务名（如 "bedrock"）。
   * 缺省时从请求主机名解析（取主机名的第一段）。
   */
  service?: string;
  /**
   * 可注入的时间源，便于单元测试获得确定性签名。
   * 缺省使用 new Date()。
   */
  now?: () => Date;
}

/**
 * 解析后的 apiKey 凭据材料。
 *
 * apiKey 材料格式约定（与 SecretStore 存入的明文一致）：
 *   "accessKeyId:secretAccessKey"            —— 长期凭据
 *   "accessKeyId:secretAccessKey:sessionToken" —— 临时凭据（STS），第三段为会话令牌
 * 即以英文冒号分隔的 2 段或 3 段。仅对 secretAccessKey 中出现冒号的罕见情形不做兼容，
 * 约定 accessKeyId / sessionToken 不含冒号（AWS 凭据本身满足该约定）。
 */
interface AwsCredentials {
  /** 访问密钥 ID（AKIA...／ASIA...）。 */
  accessKeyId: string;
  /** 私有访问密钥。 */
  secretAccessKey: string;
  /** 可选的临时会话令牌（STS 临时凭据），存在时注入 X-Amz-Security-Token 头。 */
  sessionToken?: string;
}

/**
 * 从约定格式的 apiKey 字符串解析出 AWS 凭据材料。
 *
 * @param apiKey 形如 "AK:SK" 或 "AK:SK:TOKEN"
 * @throws 当段数不足或关键字段为空时抛出，避免用空凭据产出无效签名
 */
function parseCredentials(apiKey: string): AwsCredentials {
  const parts = apiKey.split(":");
  if (parts.length < 2) {
    throw new Error(
      'SigV4 凭据材料格式错误：应为 "accessKeyId:secretAccessKey" 或 "accessKeyId:secretAccessKey:sessionToken"',
    );
  }
  const [accessKeyId, secretAccessKey, sessionToken] = parts;
  if (!accessKeyId || !secretAccessKey) {
    throw new Error("SigV4 凭据材料缺少 accessKeyId 或 secretAccessKey");
  }
  return {
    accessKeyId,
    secretAccessKey,
    // 第三段存在且非空时作为会话令牌
    sessionToken: sessionToken ? sessionToken : undefined,
  };
}

/**
 * 从请求 URL 的主机名推断 service 与 region。
 *
 * AWS 区域化服务端点通常形如：{service}.{region}.amazonaws.com
 * 例：bedrock.us-east-1.amazonaws.com → service=bedrock, region=us-east-1。
 * 无法可靠推断 region 时返回 undefined，交由上层报错（显式优于错误签名）。
 */
function parseServiceRegionFromHost(host: string): { service?: string; region?: string } {
  // 去除可能的端口部分
  const hostname = host.split(":")[0];
  const labels = hostname.split(".");
  // 期望形如 [service, region, "amazonaws", "com"]；少于 3 段无法可靠推断 region
  if (labels.length < 3) {
    return { service: labels[0] || undefined, region: undefined };
  }
  return { service: labels[0] || undefined, region: labels[1] || undefined };
}

/**
 * 生成 SigV4 要求的时间戳对。
 *
 * amzDate：ISO8601 基本格式 "YYYYMMDDTHHMMSSZ"（用于 X-Amz-Date 与待签字符串）。
 * dateStamp：短日期 "YYYYMMDD"（用于凭据范围与派生签名密钥第一级）。
 */
function formatAmzDate(date: Date): { amzDate: string; dateStamp: string } {
  // 统一用 UTC，去除 ISO 字符串中的分隔符与毫秒
  const iso = date.toISOString().replace(/[:-]/g, "").replace(/\.\d{3}/, "");
  // iso 形如 "YYYYMMDDTHHMMSSZ"
  const amzDate = iso;
  const dateStamp = iso.slice(0, 8);
  return { amzDate, dateStamp };
}

/** 计算 SHA256 十六进制摘要（小写）。 */
function sha256Hex(data: string | Buffer): string {
  return createHash("sha256").update(data).digest("hex");
}

/** 计算 HMAC-SHA256，返回原始 Buffer（供逐级派生签名密钥）。 */
function hmac(key: string | Buffer, data: string): Buffer {
  return createHmac("sha256", key).update(data, "utf8").digest();
}

/**
 * 对单个 URI 段做 AWS 规范化百分号编码。
 *
 * AWS 规定未保留字符 A-Z a-z 0-9 - _ . ~ 不编码，其余字节按 %XX 大写编码。
 * 注意：encodeURIComponent 不编码 ! * ' ( )，需要补齐；斜杠由调用方决定是否保留。
 */
function uriEncode(segment: string): string {
  return encodeURIComponent(segment).replace(/[!*'()]/g, (c) => {
    // 对 encodeURIComponent 遗漏的字符做大写百分号编码
    return "%" + c.charCodeAt(0).toString(16).toUpperCase();
  });
}

/**
 * 构造规范查询串（Canonical Query String）。
 *
 * 规则：对每个键和值分别做 URI 编码，按「编码后的键」字典序升序排序，用 & 连接 key=value。
 * 请求无查询参数时返回空串。
 */
function buildCanonicalQuery(query?: Record<string, string>): string {
  if (!query) {
    return "";
  }
  const entries = Object.entries(query).map(([k, v]) => [uriEncode(k), uriEncode(v)] as const);
  // 按编码后的键排序，保证规范化顺序稳定
  entries.sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0));
  return entries.map(([k, v]) => `${k}=${v}`).join("&");
}

/**
 * 构造规范 URI（Canonical URI）。
 *
 * 规则：对路径按 "/" 切分，对每一段做 URI 编码后再用 "/" 连接（保留路径分隔符，编码段内特殊字符）。
 * 空路径按根路径 "/" 处理。
 */
function buildCanonicalUri(pathname: string): string {
  if (!pathname || pathname === "/") {
    return "/";
  }
  return pathname
    .split("/")
    .map((seg) => (seg === "" ? "" : uriEncode(seg)))
    .join("/");
}

/**
 * AWS SigV4 签名适配器实现。
 *
 * 构造时可注入 region/service（否则从请求主机名解析）与时间源（便于测试）。
 * sign() 对传入的 HttpRequest 就地写入 SigV4 所需的签名头。
 */
export class Sigv4Adapter implements Sigv4SignerAdapter {
  private readonly options: Sigv4AdapterOptions;

  constructor(options: Sigv4AdapterOptions = {}) {
    this.options = options;
  }

  /**
   * 对给定请求做 SigV4 签名，就地写入签名相关头。
   *
   * 写入的头：
   *   - Host：规范化必需（从 URL 主机名推导，若调用方未设置）
   *   - X-Amz-Date：请求时间戳（amzDate）
   *   - X-Amz-Security-Token：仅临时凭据（含 sessionToken）时写入
   *   - X-Amz-Content-Sha256：载荷哈希（部分服务要求，统一写入更稳妥）
   *   - Authorization：算法 + 凭据范围 + 签名头列表 + 签名
   *
   * @param req    待签名请求（就地改写 headers）
   * @param apiKey 约定格式的凭据材料（见 AwsCredentials 注释）
   */
  sign(req: HttpRequest, apiKey: string): void {
    const credentials = parseCredentials(apiKey);

    // 解析 URL，得到主机名、路径与查询（与请求对象的 query 合并）
    const parsed = new URL(req.url);
    const host = parsed.host;

    // 确定 service 与 region：优先构造参数，其次从主机名解析
    const fromHost = parseServiceRegionFromHost(host);
    const service = this.options.service ?? fromHost.service;
    const region = this.options.region ?? fromHost.region;
    if (!service || !region) {
      throw new Error(
        `无法确定 SigV4 的 service/region（host=${host}）；请在适配器构造参数中显式指定 region 与 service`,
      );
    }

    // 合并查询参数：URL 自带的查询 + 请求对象 query 字段（后者覆盖同名项）
    const mergedQuery: Record<string, string> = {};
    parsed.searchParams.forEach((value, key) => {
      mergedQuery[key] = value;
    });
    if (req.query) {
      for (const [k, v] of Object.entries(req.query)) {
        mergedQuery[k] = v;
      }
    }

    // 时间戳：可注入时间源，便于测试确定性
    const now = (this.options.now ?? (() => new Date()))();
    const { amzDate, dateStamp } = formatAmzDate(now);

    // 载荷哈希：对请求体 JSON 序列化后求 SHA256；无 body 时按空串哈希（AWS 约定）
    const payload = this.serializeBody(req.body);
    const payloadHash = sha256Hex(payload);

    // 先把签名无关但规范化必需的头写入请求（Host / X-Amz-Date / 内容哈希 / 可选安全令牌）
    req.headers["Host"] = host;
    req.headers["X-Amz-Date"] = amzDate;
    req.headers["X-Amz-Content-Sha256"] = payloadHash;
    if (credentials.sessionToken) {
      req.headers["X-Amz-Security-Token"] = credentials.sessionToken;
    }

    // —— 第 1 步：构造规范请求（Canonical Request）——
    const method = req.method ?? "GET";
    const canonicalUri = buildCanonicalUri(parsed.pathname);
    const canonicalQuery = buildCanonicalQuery(mergedQuery);
    const { canonicalHeaders, signedHeaders } = this.buildCanonicalHeaders(req.headers);
    const canonicalRequest = [
      method,
      canonicalUri,
      canonicalQuery,
      canonicalHeaders,
      signedHeaders,
      payloadHash,
    ].join("\n");

    // —— 第 2 步：构造待签字符串（String To Sign）——
    const credentialScope = `${dateStamp}/${region}/${service}/${AWS4_REQUEST}`;
    const stringToSign = [
      SIGV4_ALGORITHM,
      amzDate,
      credentialScope,
      sha256Hex(canonicalRequest),
    ].join("\n");

    // —— 第 3 步：派生签名密钥（Signing Key）——
    const signingKey = this.deriveSigningKey(credentials.secretAccessKey, dateStamp, region, service);

    // —— 第 4 步：计算签名（Signature）——
    const signature = createHmac("sha256", signingKey).update(stringToSign, "utf8").digest("hex");

    // 组装 Authorization 头并就地写入
    req.headers["Authorization"] =
      `${SIGV4_ALGORITHM} ` +
      `Credential=${credentials.accessKeyId}/${credentialScope}, ` +
      `SignedHeaders=${signedHeaders}, ` +
      `Signature=${signature}`;
  }

  /**
   * 把请求体序列化为用于计算载荷哈希的字符串。
   *
   * - undefined/null：空串（GET 等无体请求的 AWS 约定）
   * - 字符串：原样
   * - 其它对象：JSON 序列化（Bedrock InvokeModel 的 bodyTemplate 为 JSON 对象）
   * 注意：该序列化结果仅用于计算哈希，实际发送由 httpSend 负责，两者需保持一致的编码约定。
   */
  private serializeBody(body: unknown): string {
    if (body === undefined || body === null) {
      return "";
    }
    if (typeof body === "string") {
      return body;
    }
    return JSON.stringify(body);
  }

  /**
   * 构造规范头（Canonical Headers）与签名头列表（SignedHeaders）。
   *
   * 规则：头名小写、去除值首尾空白并压缩内部连续空白；按头名字典序升序；
   * 每行 "name:value\n"；签名头列表为分号连接的小写头名。
   */
  private buildCanonicalHeaders(headers: Record<string, string>): {
    canonicalHeaders: string;
    signedHeaders: string;
  } {
    // 头名归一化为小写，值做空白规整
    const normalized = Object.entries(headers).map(([name, value]) => {
      const lowerName = name.toLowerCase();
      const trimmedValue = String(value).trim().replace(/\s+/g, " ");
      return [lowerName, trimmedValue] as const;
    });
    // 按头名字典序升序排序
    normalized.sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0));
    const canonicalHeaders = normalized.map(([n, v]) => `${n}:${v}`).join("\n") + "\n";
    const signedHeaders = normalized.map(([n]) => n).join(";");
    return { canonicalHeaders, signedHeaders };
  }

  /**
   * 逐级 HMAC 派生 SigV4 签名密钥。
   *
   * kDate    = HMAC("AWS4"+secretKey, dateStamp)
   * kRegion  = HMAC(kDate, region)
   * kService = HMAC(kRegion, service)
   * kSigning = HMAC(kService, "aws4_request")
   */
  private deriveSigningKey(secretAccessKey: string, dateStamp: string, region: string, service: string): Buffer {
    const kDate = hmac("AWS4" + secretAccessKey, dateStamp);
    const kRegion = hmac(kDate, region);
    const kService = hmac(kRegion, service);
    return hmac(kService, AWS4_REQUEST);
  }
}

/**
 * 便捷工厂：按可选的 region/service 创建一个 SigV4 适配器实例。
 *
 * injectAuth 需要 Sigv4SignerAdapter 时，可用本工厂注入；region/service 省略则由请求主机名解析。
 */
export function createSigv4Adapter(options: Sigv4AdapterOptions = {}): Sigv4SignerAdapter {
  return new Sigv4Adapter(options);
}
