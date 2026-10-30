import { describe, it, expect } from "vitest";
import type { AuthInjection } from "@shared/types";
import {
  injectAuth,
  type HttpRequest,
  type Sigv4SignerAdapter,
} from "./injectAuth";

// injectAuth 鉴权注入分派单元测试
//
// 覆盖任务 3.14 要求的各分支：
// - bearer header 注入（Authorization: Bearer {key}）
// - 自定义 header 注入（如 x-api-key）
// - query 查询参数注入（如 ?key={key}）
// - none 不注入任何鉴权头/查询
// - extraHeaders 附加（各形态下均应附加声明的额外固定头）
// 对应需求：4.6（鉴权注入分派）、7.3（发现/探测统一鉴权入口、不泄露明文）

/** 构造一个干净的初始请求对象，供各用例独立使用 */
function makeRequest(overrides: Partial<HttpRequest> = {}): HttpRequest {
  return {
    url: "https://api.example.com/v1/models",
    method: "GET",
    headers: {},
    ...overrides,
  };
}

describe("injectAuth", () => {
  describe("bearer header 注入", () => {
    it("应按默认模板写入 Authorization: Bearer {key}", () => {
      const req = makeRequest();
      const auth: AuthInjection = { in: "header", kind: "bearer", name: "Authorization" };

      injectAuth(req, auth, "sk-abc123");

      // 默认模板为 "Bearer {key}"，密钥展开后写入指定头
      expect(req.headers["Authorization"]).toBe("Bearer sk-abc123");
      // bearer 形态不应写入任何查询参数
      expect(req.query).toBeUndefined();
    });

    it("应尊重显式声明的 valueTemplate", () => {
      const req = makeRequest();
      const auth: AuthInjection = {
        in: "header",
        kind: "bearer",
        name: "Authorization",
        valueTemplate: "Token {key}",
      };

      injectAuth(req, auth, "sk-xyz");

      expect(req.headers["Authorization"]).toBe("Token sk-xyz");
    });

    it("未显式声明 kind 时，in=header 默认按 header 形态注入裸密钥", () => {
      const req = makeRequest();
      // 缺省 kind：按 in 推断为 header，默认模板为裸 "{key}"
      const auth: AuthInjection = { in: "header", name: "Authorization" };

      injectAuth(req, auth, "plain-key");

      expect(req.headers["Authorization"]).toBe("plain-key");
    });
  });

  describe("自定义 header 注入（x-api-key）", () => {
    it("应把密钥写入自定义头名，默认不加前缀", () => {
      const req = makeRequest();
      // Anthropic 风格：自定义头 x-api-key，裸密钥
      const auth: AuthInjection = { in: "header", kind: "header", name: "x-api-key" };

      injectAuth(req, auth, "anthropic-secret");

      expect(req.headers["x-api-key"]).toBe("anthropic-secret");
      // 不应误写 Authorization 或查询参数
      expect(req.headers["Authorization"]).toBeUndefined();
      expect(req.query).toBeUndefined();
    });

    it("自定义 header 也可带模板前缀", () => {
      const req = makeRequest();
      const auth: AuthInjection = {
        in: "header",
        kind: "header",
        name: "api-key",
        valueTemplate: "key-{key}",
      };

      injectAuth(req, auth, "42");

      expect(req.headers["api-key"]).toBe("key-42");
    });
  });

  describe("query 查询参数注入（?key=）", () => {
    it("应把密钥写入指定查询参数名", () => {
      const req = makeRequest();
      // Google Gemini 风格：?key={key}
      const auth: AuthInjection = { in: "query", kind: "query", name: "key" };

      injectAuth(req, auth, "gemini-key");

      expect(req.query).toEqual({ key: "gemini-key" });
      // query 形态不应写入鉴权头
      expect(Object.keys(req.headers)).toHaveLength(0);
    });

    it("应保留请求中既有的查询参数", () => {
      const req = makeRequest({ query: { alt: "json" } });
      const auth: AuthInjection = { in: "query", name: "key" };

      injectAuth(req, auth, "k1");

      // 既有参数保留，新增鉴权参数并存
      expect(req.query).toEqual({ alt: "json", key: "k1" });
    });

    it("未声明 kind 时，in=query 默认按 query 形态注入", () => {
      const req = makeRequest();
      const auth: AuthInjection = { in: "query", name: "access_token" };

      injectAuth(req, auth, "tok");

      expect(req.query).toEqual({ access_token: "tok" });
    });
  });

  describe("none 不注入任何鉴权", () => {
    it("不应写入任何鉴权头或查询参数，且允许 apiKey 为空", () => {
      const req = makeRequest();
      const auth: AuthInjection = { in: "none" };

      // 本地/自托管场景：apiKey 可缺省，不读取也不要求
      injectAuth(req, auth);

      expect(Object.keys(req.headers)).toHaveLength(0);
      expect(req.query).toBeUndefined();
    });

    it("kind=none 同样跳过鉴权注入", () => {
      const req = makeRequest();
      const auth: AuthInjection = { in: "none", kind: "none" };

      injectAuth(req, auth, "ignored-key");

      // 即便传入了密钥，也不应注入任何鉴权相关内容
      expect(Object.keys(req.headers)).toHaveLength(0);
      expect(req.query).toBeUndefined();
    });
  });

  describe("extraHeaders 附加", () => {
    it("none 形态下仍应附加声明的额外固定头", () => {
      const req = makeRequest();
      const auth: AuthInjection = {
        in: "none",
        extraHeaders: { "x-custom": "v1" },
      };

      injectAuth(req, auth);

      // 无鉴权但仍附加额外头
      expect(req.headers["x-custom"]).toBe("v1");
    });

    it("header 形态下应同时注入鉴权头与 extraHeaders", () => {
      const req = makeRequest();
      // Anthropic 风格：x-api-key + anthropic-version 固定头
      const auth: AuthInjection = {
        in: "header",
        kind: "header",
        name: "x-api-key",
        extraHeaders: { "anthropic-version": "2023-06-01" },
      };

      injectAuth(req, auth, "ant-key");

      expect(req.headers["x-api-key"]).toBe("ant-key");
      expect(req.headers["anthropic-version"]).toBe("2023-06-01");
    });

    it("query 形态下应在注入查询参数的同时附加 extraHeaders", () => {
      const req = makeRequest();
      const auth: AuthInjection = {
        in: "query",
        name: "key",
        extraHeaders: { "x-trace": "on" },
      };

      injectAuth(req, auth, "qk");

      expect(req.query).toEqual({ key: "qk" });
      expect(req.headers["x-trace"]).toBe("on");
    });
  });

  describe("边界与错误处理", () => {
    it("header 形态缺少 name 时应抛错", () => {
      const req = makeRequest();
      const auth: AuthInjection = { in: "header", kind: "header" };

      expect(() => injectAuth(req, auth, "k")).toThrow();
    });

    it("header 形态缺少 apiKey 时应抛错", () => {
      const req = makeRequest();
      const auth: AuthInjection = { in: "header", kind: "bearer", name: "Authorization" };

      expect(() => injectAuth(req, auth)).toThrow();
    });

    it("query 形态缺少 name 时应抛错", () => {
      const req = makeRequest();
      const auth: AuthInjection = { in: "query" };

      expect(() => injectAuth(req, auth, "k")).toThrow();
    });

    it("sigv4 形态应委托注入的签名适配器", () => {
      const req = makeRequest();
      const auth: AuthInjection = { in: "header", kind: "sigv4" };
      // 记录适配器是否被调用及其入参
      let signed = false;
      const signer: Sigv4SignerAdapter = {
        sign(request, apiKey) {
          signed = true;
          request.headers["Authorization"] = `AWS4 ${apiKey}`;
        },
      };

      injectAuth(req, auth, "aws-cred", { sigv4Signer: signer });

      expect(signed).toBe(true);
      expect(req.headers["Authorization"]).toBe("AWS4 aws-cred");
    });

    it("sigv4 形态未注入签名适配器时应抛错", () => {
      const req = makeRequest();
      const auth: AuthInjection = { in: "header", kind: "sigv4" };

      expect(() => injectAuth(req, auth, "aws-cred")).toThrow();
    });
  });
});
