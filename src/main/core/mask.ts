// 密钥掩码纯函数
// 用于把 API Key 等敏感明文转换为可安全展示的掩码串，确保界面预览、
// 分发差异（maskedDiff）与任何回传渲染进程的数据中都不出现明文中段字符。
// 对应需求 2.9 / 2.10。

/** 掩码字符：统一使用 `*` 替代被隐藏的字符。 */
const MASK_CHAR = '*';

/**
 * 对密钥明文生成掩码串。
 *
 * 规则（对应需求 2.9 / 2.10）：
 * - 当明文长度 >= 8：保留前 4 个字符与后 4 个字符，中段全部以掩码字符替代；
 *   输出不包含任一原始中段字符。
 * - 当明文长度 < 8：返回与原密钥等长、且全部为掩码字符的掩码串；
 *   输出不包含任一原始字符（含空串时返回空串）。
 *
 * 该函数为幂等的纯函数，不产生任何明文副本，也不写日志。
 *
 * @param apiKey 待掩码的密钥明文
 * @returns 掩码后的字符串
 */
export function maskSecret(apiKey: string): string {
  const length = apiKey.length;

  // 短串（<8）：整体掩码为等长全掩码串，连前后缀都不暴露
  if (length < 8) {
    return MASK_CHAR.repeat(length);
  }

  // 长串（>=8）：保留前 4 后 4，中段按其长度全部替换为掩码字符
  const prefix = apiKey.slice(0, 4);
  const suffix = apiKey.slice(length - 4);
  const maskedMiddle = MASK_CHAR.repeat(length - 8);
  return `${prefix}${maskedMiddle}${suffix}`;
}
