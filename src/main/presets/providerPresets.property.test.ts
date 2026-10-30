import { describe, it, expect } from "vitest";
import fc from "fast-check";
import { fcAssert } from "@shared/testing/fcConfig";
import type { AuthInjection, ModelListingConfig, ModelProbeConfig } from "@shared/types";
import {
  PROVIDER_PRESETS,
  type ProviderPreset,
} from "./providerPresets";
import {
  injectAuth,
  type HttpRequest,
  type Sigv4SignerAdapter,
} from "../core/injectAuth";
import { createSigv4Adapter } from "./sigv4Adapter";

// 预设与数据驱动引擎的属性测试（providerPresets.property.test）
//
// 覆盖任务 8.3：
//   **Property 13: 预设数据驱动，不影响核心引擎**
//   对任意两份预设 p1/p2，用同一通用引擎按各自声明执行拉取/探测的「鉴权注入」构造，
//   断言「新增 p2」不改变 p1 的注入/构造行为（隔离性）；sigv4 特例在专用适配器内处理，
//   不影响其它预设的声明式注入结果。
//
// 验证路径说明：
//   任务 6.2/6.3 的 ModelDiscovery.fetchModels/probeModels 此时尚未实现（src/main/services/modelDiscovery.ts
//   不存在），因此本测试围绕「数据驱动引擎的核心部分」——即 injectAuth 按预设 auth 声明构造请求——
//   来验证 Property 13。拉取（modelListing）与探测（modelProbe）两条链路的鉴权构造均由同一个
//   injectAuth 引擎按各自声明驱动，故对该引擎的隔离性/数据驱动性验证即覆盖 Property 13 的核心主张：
//   「新增一份预设不需改动引擎代码，也不改变既有预设的拉取/探测行为」。
//
// **Validates: Requirements 4.5 / Property 13**

// ---------------------------------------------------------------------------
// 测试辅助：用同一通用引擎按某预设声明构造「拉取」与「探测」请求的鉴权头/查询
// ---------------------------------------------------------------------------

/**
 * 构造一个干净的初始请求对象。
 *
 * 用固定但贴合预设的 URL（结合预设 baseUrl 与端点 path），使不同预设得到各自真实的请求形状；
 * sigv4 适配器需要从主机名解析 service/region，故 URL 必须真实可解析。
 */
function makeRequest(url: string, method: "GET" | "POST"): HttpRequest {
  return { url, method, headers: {} };
}

/**
 * 可注入的 sigv4 签名适配器：供 kind="sigv4" 的预设（AWS Bedrock）委托。
 *
 * 复用生产实现 createSigv4Adapter，并注入固定时间源以获得确定性签名——
 * 这保证「同一预设用同一引擎、同一密钥构造」在多次调用间结果可比对（隔离性断言需要确定性）。
 */
function makeSigner(): Sigv4SignerAdapter {
  return createSigv4Adapter({ now: () => new Date("2024-01-01T00:00:00.000Z") });
}

/**
 * 按某预设的「拉取」声明（modelListing.auth）用通用 injectAuth 引擎构造鉴权。
 * 返回注入后的请求头与查询参数快照（即引擎对该预设的「拉取鉴权构造行为」）。
 */
function buildListingAuth(preset: ProviderPreset, apiKey: string, signer: Sigv4SignerAdapter) {
  const listing: ModelListingConfig = preset.modelListing;
  const url = preset.baseUrl + (listing.path ?? "/v1/models");
  const req = makeRequest(url, listing.method ?? "GET");
  injectAuth(req, listing.auth, apiKey, { sigv4Signer: signer });
  return snapshot(req);
}

/**
 * 按某预设的「探测」声明（modelProbe.auth）用通用 injectAuth 引擎构造鉴权。
 * 返回注入后的请求头与查询参数快照（即引擎对该预设的「探测鉴权构造行为」）。
 */
function buildProbeAuth(preset: ProviderPreset, apiKey: string, signer: Sigv4SignerAdapter) {
  const probe: ModelProbeConfig = preset.modelProbe;
  // 探测路径可能含 {model} 占位，用固定模型名替换，得到真实可解析的 URL
  const path = probe.path.split("{model}").join("probe-model");
  const url = preset.baseUrl + path;
  const req = makeRequest(url, probe.method ?? "POST");
  // 探测请求带 body（最小代价请求），sigv4 载荷哈希依赖 body，一并带上以贴近真实构造
  if (probe.bodyTemplate) {
    req.body = probe.bodyTemplate;
  }
  injectAuth(req, probe.auth, apiKey, { sigv4Signer: signer });
  return snapshot(req);
}

/**
 * 把请求的鉴权相关结果归一化为可比对快照（稳定排序，便于深相等断言）。
 */
function snapshot(req: HttpRequest): { headers: Record<string, string>; query: Record<string, string> } {
  const headers: Record<string, string> = {};
  for (const name of Object.keys(req.headers).sort()) {
    headers[name] = req.headers[name];
  }
  const query: Record<string, string> = {};
  if (req.query) {
    for (const name of Object.keys(req.query).sort()) {
      query[name] = req.query[name];
    }
  }
  return { headers, query };
}

/**
 * 判断一份预设的鉴权是否为无鉴权（none）。
 * 无鉴权预设在构造时不需要密钥；本测试对其传入空串亦可。
 */
function isNoneAuth(auth: AuthInjection): boolean {
  return auth.in === "none" || auth.kind === "none";
}

// 所有内置预设的下标集合，供 fast-check 从中任取两份（允许 p1===p2 以覆盖自比对）
const PRESET_INDICES = PROVIDER_PRESETS.map((_, i) => i);

describe("Property 13: 预设数据驱动，不影响核心引擎", () => {
  it("新增 p2 不改变 p1 的拉取/探测鉴权构造（隔离性）", () => {
    fcAssert(
      fc.property(
        fc.constantFrom(...PRESET_INDICES), // p1 预设下标
        fc.constantFrom(...PRESET_INDICES), // p2 预设下标（代表「新增/并存」的另一份预设）
        fc.string({ minLength: 1, maxLength: 40 }), // p1 使用的密钥材料
        fc.string({ minLength: 1, maxLength: 40 }), // p2 使用的密钥材料
        (i1, i2, key1Raw, key2Raw) => {
          const p1 = PROVIDER_PRESETS[i1];
          const p2 = PROVIDER_PRESETS[i2];

          // sigv4 预设需要 "AK:SK" 形态的密钥材料；其它预设用任意非空串；none 预设用空串即可
          const key1 = materializeKey(p1, key1Raw);
          const key2 = materializeKey(p2, key2Raw);

          const signer = makeSigner();

          // 基线：仅用 p1 自身声明，经同一引擎构造其拉取/探测鉴权
          const baselineListing = buildListingAuth(p1, key1, signer);
          const baselineProbe = buildProbeAuth(p1, key1, signer);

          // 「新增 p2」：先用同一引擎按 p2 声明构造一次（模拟系统中并存另一份预设被使用），
          // 再对 p1 重新构造——p1 的结果不应被 p2 的存在/使用所改变（隔离、无共享可变状态）。
          buildListingAuth(p2, key2, signer);
          buildProbeAuth(p2, key2, signer);
          const afterListing = buildListingAuth(p1, key1, signer);
          const afterProbe = buildProbeAuth(p1, key1, signer);

          // 断言 p1 的拉取/探测鉴权构造结果在「p2 并存前后」完全一致
          expect(afterListing).toEqual(baselineListing);
          expect(afterProbe).toEqual(baselineProbe);

          return true;
        },
      ),
    );
  });

  it("同一引擎对同一预设按自身声明构造是确定性的（数据驱动、无隐藏状态）", () => {
    fcAssert(
      fc.property(
        fc.constantFrom(...PRESET_INDICES),
        fc.string({ minLength: 1, maxLength: 40 }),
        (i, keyRaw) => {
          const preset = PROVIDER_PRESETS[i];
          const key = materializeKey(preset, keyRaw);
          const signer = makeSigner();

          // 同一预设、同一密钥、同一引擎，两次独立构造应得到相同鉴权结果
          const a = buildListingAuth(preset, key, signer);
          const b = buildListingAuth(preset, key, signer);
          expect(b).toEqual(a);

          const pa = buildProbeAuth(preset, key, signer);
          const pb = buildProbeAuth(preset, key, signer);
          expect(pb).toEqual(pa);

          return true;
        },
      ),
    );
  });

  it("sigv4 特例在专用适配器内处理，不影响其它预设的声明式注入结果", () => {
    // 分离出 sigv4 预设与非 sigv4 预设
    const sigv4Indices = PRESET_INDICES.filter(
      (i) => PROVIDER_PRESETS[i].auth.kind === "sigv4",
    );
    const nonSigv4Indices = PRESET_INDICES.filter(
      (i) => PROVIDER_PRESETS[i].auth.kind !== "sigv4",
    );

    // 前置确认：内置预设里既有 sigv4（AWS Bedrock）也有非 sigv4 预设，否则本属性无意义
    expect(sigv4Indices.length).toBeGreaterThan(0);
    expect(nonSigv4Indices.length).toBeGreaterThan(0);

    fcAssert(
      fc.property(
        fc.constantFrom(...nonSigv4Indices), // 任一非 sigv4 预设 p1
        fc.constantFrom(...sigv4Indices), // 任一 sigv4 预设（AWS Bedrock）
        fc.string({ minLength: 1, maxLength: 40 }), // 非 sigv4 预设的密钥
        fc.string({ minLength: 1, maxLength: 20 }), // sigv4 的原始密钥材料（经 materializeKey 物化为合法 "AK:SK"）
        (nonIdx, sigIdx, nonKeyRaw, sigKeyRaw) => {
          const nonSigv4 = PROVIDER_PRESETS[nonIdx];
          const sigv4 = PROVIDER_PRESETS[sigIdx];
          const nonKey = materializeKey(nonSigv4, nonKeyRaw);
          // sigv4 密钥材料统一经 materializeKey 物化：保证 AK/SK 两段均非空（含 AKIA/SECRET 兜底），
          // 避免随机输入（如全空白段）生成空凭据触发 sigv4Adapter 的合法性拒绝（那属于生成器问题而非被测行为）。
          const sigKey = materializeKey(sigv4, sigKeyRaw);

          const signer = makeSigner();

          // 基线：仅按非 sigv4 预设自身声明构造鉴权
          const baselineListing = buildListingAuth(nonSigv4, nonKey, signer);
          const baselineProbe = buildProbeAuth(nonSigv4, nonKey, signer);

          // 让 sigv4 预设经专用适配器构造一次（Bedrock 的拉取/探测均走 sigv4 签名），
          // 其签名逻辑完全封闭在 sigv4Adapter 内，不应外溢影响其它预设的声明式注入。
          buildListingAuth(sigv4, sigKey, signer);
          buildProbeAuth(sigv4, sigKey, signer);

          // 再次构造非 sigv4 预设的鉴权——结果应与基线完全一致
          const afterListing = buildListingAuth(nonSigv4, nonKey, signer);
          const afterProbe = buildProbeAuth(nonSigv4, nonKey, signer);

          expect(afterListing).toEqual(baselineListing);
          expect(afterProbe).toEqual(baselineProbe);

          // 额外断言：非 sigv4 预设的注入结果不含任何 sigv4 专属签名头
          const listingHeaderNames = Object.keys(afterListing.headers).map((n) => n.toLowerCase());
          expect(listingHeaderNames).not.toContain("x-amz-date");
          expect(listingHeaderNames).not.toContain("x-amz-content-sha256");

          return true;
        },
      ),
    );
  });
});

/**
 * 按预设的鉴权形态把随机原始串「物化」为合法的密钥材料。
 * - none 预设：返回空串（无鉴权不读取密钥）。
 * - sigv4 预设：返回 "AK:SK" 形态（去冒号后拼装），满足 sigv4Adapter 的凭据解析约定。
 * - 其它预设：返回非空原始串（去除冒号以免干扰，保证非空）。
 */
function materializeKey(preset: ProviderPreset, raw: string): string {
  if (isNoneAuth(preset.auth)) {
    return "";
  }
  if (preset.auth.kind === "sigv4") {
    const cleaned = raw.replace(/:/g, "");
    const ak = cleaned.slice(0, Math.max(1, Math.ceil(cleaned.length / 2))) || "AKIA";
    const sk = cleaned.slice(ak.length) || "SECRET";
    return `${ak}:${sk}`;
  }
  // header/query 形态：确保非空（injectAuth 对非 none 形态要求密钥非空）
  const cleaned = raw.replace(/:/g, "");
  return cleaned.length > 0 ? cleaned : "k";
}
