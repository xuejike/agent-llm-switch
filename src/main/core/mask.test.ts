// maskSecret 掩码函数的单元测试与属性测试
//
// 覆盖需求 2.9 / 2.10：
// - 2.9：长度 >= 8 的密钥保留前 4 后 4、中段全掩码；长度 < 8 返回等长全掩码串。
// - 2.10：掩码输出不得泄露原始密钥的中段字符。
//
// 属性测试对应设计中的 Property 1「密钥不泄露」（基础部分）：
// 对随机 apiKey，断言掩码输出不包含原始的中段字符，保证明文中段不被泄露。
// 所有属性测试统一经共享约定 fcAssert 运行（numRuns >= 100）。

import { describe, it, expect } from 'vitest';
import fc from 'fast-check';
import { maskSecret } from './mask';
import { fcAssert } from '@shared/testing/fcConfig';

/** 掩码字符，与被测模块保持一致，便于断言输出结构。 */
const MASK = '*';

describe('maskSecret 单元测试', () => {
  it('空串：返回空串', () => {
    // 边界：长度为 0，等长全掩码即空串
    expect(maskSecret('')).toBe('');
  });

  it('短串（长度 < 8）：返回等长的全掩码串，不暴露任何原始字符', () => {
    // 长度 1 到 7 均属短串分支，应被整体掩码
    expect(maskSecret('a')).toBe('*');
    expect(maskSecret('abc')).toBe('***');
    expect(maskSecret('1234567')).toBe('*******'); // 长度 7，仍为短串
  });

  it('边界 7 与 8：7 走全掩码、8 走前后缀保留', () => {
    // 长度 7：短串，全掩码
    expect(maskSecret('abcdefg')).toBe('*******');
    // 长度 8：长串边界，保留前 4 后 4，中段长度为 0（无掩码字符）
    expect(maskSecret('abcdefgh')).toBe('abcdefgh');
  });

  it('长串（长度 >= 8）：保留前 4 后 4、中段全部掩码', () => {
    // 长度 13：前 4 "sk-1"、后 4 "cdef"、中段 5 位掩码
    expect(maskSecret('sk-1234abcdef')).toBe('sk-1*****cdef');
    // 长度 16：前 4 ABCD，后 4 WXYZ，中段 8 位掩码
    expect(maskSecret('ABCD________WXYZ')).toBe('ABCD********WXYZ');
  });

  it('长串掩码长度与原密钥长度一致', () => {
    const key = 'abcdefghijklmnop'; // 长度 16
    const masked = maskSecret(key);
    expect(masked.length).toBe(key.length);
    expect(masked.startsWith('abcd')).toBe(true);
    expect(masked.endsWith('mnop')).toBe(true);
    // 中段应全部为掩码字符
    expect(masked.slice(4, -4)).toBe(MASK.repeat(key.length - 8));
  });
});

describe('maskSecret 属性测试 - Property 1: 密钥不泄露（基础部分）', () => {
  it('Property 1：掩码输出不包含原始密钥的中段字符', () => {
    // 生成策略：
    // - 前缀 prefix / 后缀 suffix 由不含掩码字符的任意可见字符组成（固定各 4 位），
    //   作为长串两端会被保留的部分。
    // - 中段 middle 由一组“标记字符集”生成（与掩码字符 '*' 不相交），
    //   这样可精确断言：掩码输出的中段区域不含任何原始中段字符即为不泄露。
    //
    // 由于前后缀会被原样保留，若允许中段字符与前后缀相同将无法区分“泄露”与“恰巧相同”，
    // 因此让中段使用与前后缀不相交的独立字符集，使“不泄露”这一性质可被严格判定。

    // 用于前后缀的字符集（不含掩码字符，也不含下面中段专用字符）
    const edgeChar = fc.constantFrom(...'abcdefghijklmnopqrstuvwxyz'.split(''));
    // 中段专用字符集：大写字母与数字，与 edgeChar、掩码字符均不相交
    const middleChar = fc.constantFrom(...'ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789'.split(''));

    fcAssert(
      fc.property(
        fc.array(edgeChar, { minLength: 4, maxLength: 4 }), // 前缀 4 位
        fc.array(edgeChar, { minLength: 4, maxLength: 4 }), // 后缀 4 位
        // 中段至少 1 位（保证确实存在需要被掩码的中段），长度随机
        fc.array(middleChar, { minLength: 1, maxLength: 40 }),
        (prefixArr, suffixArr, middleArr) => {
          const prefix = prefixArr.join('');
          const suffix = suffixArr.join('');
          const middle = middleArr.join('');
          const apiKey = prefix + middle + suffix; // 长度 >= 9，必走长串分支

          const masked = maskSecret(apiKey);

          // 性质 1：掩码长度与原密钥一致
          expect(masked.length).toBe(apiKey.length);

          // 性质 2（核心不泄露）：掩码的中段区域（去掉保留的前 4 后 4）
          // 不包含任何原始中段字符——应全部为掩码字符。
          const maskedMiddle = masked.slice(4, apiKey.length - 4);
          for (const ch of middle) {
            expect(maskedMiddle.includes(ch)).toBe(false);
          }
          // 中段区域应恰为等长的掩码字符串
          expect(maskedMiddle).toBe(MASK.repeat(middle.length));
        },
      ),
    );
  });

  it('Property 1：短串（<8）整体掩码，输出不含任何原始字符', () => {
    // 短串分支的不泄露性质：输出为等长全掩码串，连前后缀都不暴露。
    const anyChar = fc.constantFrom(
      ...'ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789'.split(''),
    );
    fcAssert(
      fc.property(fc.array(anyChar, { minLength: 0, maxLength: 7 }), (arr) => {
        const apiKey = arr.join('');
        const masked = maskSecret(apiKey);
        // 等长且全为掩码字符
        expect(masked).toBe(MASK.repeat(apiKey.length));
        // 不含任一原始字符
        for (const ch of apiKey) {
          expect(masked.includes(ch)).toBe(false);
        }
      }),
    );
  });
});
