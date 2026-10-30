// Provider 连接/可用状态的 UI 展示辅助
//
// 职责：把 ProviderConfig 的「本地/鉴权」语义与（后续探测得到的）连接状态，
// 归一化为左栏列表状态点（Badge/ellipse）所需的 antd 语义色与文案。
//
// 说明：本任务（12.1）尚未接入真实的「测试连接/探测」结果，
// 故状态先依据 ProviderConfig 自身可推断的信息给出：
// - 本地 provider（isLocal）→ 以 warning 色提示「本地·未验证」
// - 其余 → 以默认（success）色占位
// 后续任务（12.4 探测）可据 candidateModels 的 availability 回填更精确状态。

import type { ProviderConfig } from '@shared/types';

/** 列表状态点的语义级别：对应 antd Badge 的 status 取值 */
export type ProviderStatusLevel = 'success' | 'warning' | 'error' | 'default';

/** 状态点的展示信息：语义色 + 文案的 i18n key（由调用方翻译） */
export interface ProviderStatusView {
  /** antd Badge 的 status（success=绿、warning=橙、error=红、default=灰） */
  level: ProviderStatusLevel;
  /** 文案的 i18n 翻译键（调用方用 t() 翻译为 title/aria 文案） */
  textKey: 'providerStatus.localUnverified' | 'providerStatus.configured';
}

/**
 * 依据 ProviderConfig 推断左栏列表状态点的展示信息。
 * 纯函数、无副作用，便于单测与后续扩展（接入探测结果时在此集中调整）。
 */
export function getProviderStatusView(provider: ProviderConfig): ProviderStatusView {
  // 本地/自托管 provider：通常无需鉴权，连接性需实际探测才能确认，先以 warning 占位
  if (provider.isLocal) {
    return { level: 'warning', textKey: 'providerStatus.localUnverified' };
  }
  // 其余远端 provider：默认以 success 占位（真实连接状态待 12.4 探测回填）
  return { level: 'success', textKey: 'providerStatus.configured' };
}
