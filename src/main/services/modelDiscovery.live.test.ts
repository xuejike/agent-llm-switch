// 真实 API 集成测试（打到真实 LLM 网关，验证完整数据链路）
//
// 与其它单元/属性测试不同：本测试**真实访问外网**，直接用生产服务
// （真实 ModelDiscovery + 真实 createDefaultHttpSend + 内存 SecretStore）
// 打到一个 OpenAI 兼容网关，验证：
//   1. fetchModels 能真实拉取并归一化模型清单（arrayPointer=/data, idField=id）；
//   2. probeModels 对「真实可用模型」判定 available、对「不存在模型」判定 unavailable。
//
// 运行门控：默认跳过（避免普通 CI 被外网/限流/密钥缺失干扰）。仅当设置环境变量
//   LLM_SWITCH_LIVE_API=1 且提供 LLM_SWITCH_LIVE_API_KEY 时才运行。
//   baseUrl 可用 LLM_SWITCH_LIVE_API_BASE 覆盖，默认 https://llm-admin.csisolar.com。
//
// 安全：密钥只从环境变量读取，绝不硬编码进仓库；结果断言不打印明文。

import { describe, it, expect } from 'vitest';
import type { ProviderConfig } from '@shared/types';
import { createModelDiscovery } from './modelDiscovery';
import { createDefaultHttpSend } from './http';
import { InMemorySecretStore } from './secretStore';

// —— 运行开关与配置（全部来自环境变量） ——
const LIVE = process.env.LLM_SWITCH_LIVE_API === '1';
const API_KEY = process.env.LLM_SWITCH_LIVE_API_KEY ?? '';
const BASE_URL = process.env.LLM_SWITCH_LIVE_API_BASE ?? 'https://llm-admin.csisolar.com';

// OpenAI 兼容端点声明（与渲染侧 DeepSeek/OpenAI 预设等价）：
// - 列表：GET /v1/models → /data[].id
// - 探测：POST /v1/chat/completions，200 视为可用
const LIVE_LISTING = {
  path: '/v1/models',
  method: 'GET' as const,
  auth: {
    in: 'header' as const,
    kind: 'bearer' as const,
    name: 'Authorization',
    valueTemplate: 'Bearer {key}',
  },
  responseMapping: { arrayPointer: '/data', idField: 'id' },
};

const LIVE_PROBE = {
  path: '/v1/chat/completions',
  method: 'POST' as const,
  auth: {
    in: 'header' as const,
    kind: 'bearer' as const,
    name: 'Authorization',
    valueTemplate: 'Bearer {key}',
  },
  bodyTemplate: {
    model: '{model}',
    messages: [{ role: 'user', content: 'ping' }],
    max_tokens: 1,
  },
  availableStatuses: [200],
};

/** 构造指向真实网关的 Provider 配置（apiKeyRef 指向内存凭据库条目） */
function liveProvider(apiKeyRef: string): ProviderConfig {
  return {
    id: 'live-csi',
    name: 'csi-llm-gateway',
    baseUrl: BASE_URL,
    apiKeyRef,
    models: [],
    isLocal: false,
    modelListing: LIVE_LISTING,
    modelProbe: LIVE_PROBE,
    timeoutMs: 30_000,
  };
}

// 仅在显式开启真实 API 测试时运行；否则整组跳过（并在 run 列表中标记 skipped）
const describeLive = LIVE && API_KEY ? describe : describe.skip;

describeLive('真实 API 集成（OpenAI 兼容网关）', () => {
  it('fetchModels 真实拉取并归一化模型清单', async () => {
    const secretStore = new InMemorySecretStore();
    const apiKeyRef = 'live-key';
    await secretStore.saveSecret(apiKeyRef, API_KEY);
    const discovery = createModelDiscovery({
      secretStore,
      httpSend: createDefaultHttpSend(),
    });

    const result = await discovery.fetchModels(liveProvider(apiKeyRef));

    // 支持列表 API，且成功拉取到非空清单，无 warning
    expect(result.supportsListing).toBe(true);
    expect(result.warning).toBeUndefined();
    expect(result.models.length).toBeGreaterThan(0);
    // 归一化字段：均为 fetched 来源、未探测状态、id 非空
    for (const m of result.models) {
      expect(m.source).toBe('fetched');
      expect(m.availability).toBe('unknown');
      expect(typeof m.id).toBe('string');
      expect(m.id.length).toBeGreaterThan(0);
    }
    // 该网关清单应包含若干已知模型 id
    const ids = result.models.map((m) => m.id);
    expect(ids).toContain('qwen-plus');
  }, 40_000);

  it('probeModels 对可用/不存在模型给出正确可用性判定', async () => {
    const secretStore = new InMemorySecretStore();
    const apiKeyRef = 'live-key';
    await secretStore.saveSecret(apiKeyRef, API_KEY);
    const discovery = createModelDiscovery({
      secretStore,
      httpSend: createDefaultHttpSend(),
    });

    // qwen-plus：真实可用（200）；deepseek-r1：该网关返回 404 模型不存在（不可用）
    const modelIds = ['qwen-plus', 'deepseek-r1'];
    const results = await discovery.probeModels(liveProvider(apiKeyRef), modelIds, {
      timeoutMs: 30_000,
      concurrency: 2,
    });

    // 一一对应
    expect(results).toHaveLength(2);
    expect(results.map((r) => r.modelId)).toEqual(modelIds);

    const byId = new Map(results.map((r) => [r.modelId, r]));
    const qwen = byId.get('qwen-plus')!;
    const deepseek = byId.get('deepseek-r1')!;

    // 诊断输出：便于观察真实网关此刻的返回（真实端点会随限流/下线波动）
    // eslint-disable-next-line no-console
    console.log('[live-probe] qwen-plus =>', JSON.stringify(qwen));
    // eslint-disable-next-line no-console
    console.log('[live-probe] deepseek-r1 =>', JSON.stringify(deepseek));

    // —— 稳健断言：验证「探测链路」行为正确，而非绑定某模型此刻的可用性 ——
    // 真实网关存在限流(429)/模型上下线等波动，故断言可用性判定与状态码「自洽」，
    // 并至少覆盖一次「真实可用(200)判 available」或「真实非 200 判 unavailable」。

    // 1) qwen-plus：availability 必须与 statusCode 自洽
    expect(['available', 'unavailable', 'unknown']).toContain(qwen.availability);
    if (qwen.availability === 'available') {
      // 判为可用 ⇔ 命中 availableStatuses(=200)
      expect(qwen.statusCode).toBe(200);
      expect(qwen.latencyMs).toBeGreaterThanOrEqual(0);
    } else if (qwen.statusCode !== undefined) {
      // 判为不可用/未知时，若有状态码则不应是 200
      expect(qwen.statusCode).not.toBe(200);
      expect(qwen.error).toBeTruthy();
    }

    // 2) deepseek-r1：该网关对其返回 404「模型不存在」→ 必不可用（200 之外）
    expect(deepseek.availability).not.toBe('available');
    expect(deepseek.error).toBeTruthy();
    if (deepseek.statusCode !== undefined) {
      expect(deepseek.statusCode).not.toBe(200);
    }

    // 3) 链路完整性：两条探测都产生了确定的时间戳
    expect(qwen.probedAt).toBeTruthy();
    expect(deepseek.probedAt).toBeTruthy();
  }, 60_000);

  it('存在至少一个真实可用模型被判为 available（带限流退避重试）', async () => {
    const secretStore = new InMemorySecretStore();
    const apiKeyRef = 'live-key';
    await secretStore.saveSecret(apiKeyRef, API_KEY);
    const discovery = createModelDiscovery({
      secretStore,
      httpSend: createDefaultHttpSend(),
    });
    const provider = liveProvider(apiKeyRef);

    // 候选真实模型（按经验更可能在线）；逐个探测，遇 429 限流退避后重试
    const candidates = ['qwen-plus', 'qwen-max', 'qwen-turbo', 'deepseek-v3.1'];
    let found = false;
    let lastSeen = '';

    for (const modelId of candidates) {
      // 单模型最多尝试 3 次，429 时指数退避
      for (let attempt = 0; attempt < 3 && !found; attempt++) {
        const r = await discovery.probeModel(provider, modelId, { timeoutMs: 30_000 });
        lastSeen = `${modelId}:${r.availability}:${r.statusCode ?? r.error ?? ''}`;
        if (r.availability === 'available') {
          // 命中一次真实「200 → available」：链路确证
          expect(r.statusCode).toBe(200);
          found = true;
          break;
        }
        // 限流则退避重试；其它状态直接试下一个模型
        if (r.statusCode === 429) {
          await new Promise((res) => setTimeout(res, 1500 * (attempt + 1)));
          continue;
        }
        break;
      }
      if (found) {
        break;
      }
    }

    // eslint-disable-next-line no-console
    console.log('[live-probe] 可用性探测最终观测：', lastSeen);
    expect(found, `未能在候选模型中观测到可用模型（最后一次：${lastSeen}）`).toBe(true);
  }, 90_000);
});
