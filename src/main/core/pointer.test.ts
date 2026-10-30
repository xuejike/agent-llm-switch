import { describe, it, expect } from 'vitest';
import fc from 'fast-check';
import { fcAssert } from '@shared/testing/fcConfig';
import { setByPointer, getByPointer } from './pointer';

// pointer 模块测试
//
// 覆盖 setByPointer / getByPointer 的核心行为（需求 10.6）：
// - 深层创建：路径上缺失的中间容器被自动创建；
// - 兄弟保留：不属于写入路径的兄弟节点保持原样不变（Property 2 支撑）；
// - 数组定位：段为合法下标时在数组容器中正确读写。

describe('setByPointer 单元测试', () => {
  it('深层写入时创建沿途缺失的中间对象', () => {
    const tree: Record<string, unknown> = {};
    // 目标指针指向三层嵌套，中间对象均不存在
    setByPointer(tree, '/provider/options/baseURL', 'https://api.example.com');

    // 沿途对象被逐层创建，叶子节点写入目标值
    expect(tree).toEqual({
      provider: { options: { baseURL: 'https://api.example.com' } },
    });
    // getByPointer 可回读写入的值
    expect(getByPointer(tree, '/provider/options/baseURL')).toBe('https://api.example.com');
  });

  it('写入目标叶子时保留同级及沿途的兄弟节点', () => {
    const tree: Record<string, unknown> = {
      provider: {
        name: 'openai', // 根下兄弟
        options: {
          timeout: 30000, // 目标同级兄弟
        },
      },
      theme: 'dark', // 顶层兄弟
    };

    setByPointer(tree, '/provider/options/baseURL', 'https://api.example.com');

    // 新叶子写入成功
    expect(getByPointer(tree, '/provider/options/baseURL')).toBe('https://api.example.com');
    // 所有不在写入路径上的兄弟节点保持不变
    expect(getByPointer(tree, '/provider/name')).toBe('openai');
    expect(getByPointer(tree, '/provider/options/timeout')).toBe(30000);
    expect(getByPointer(tree, '/theme')).toBe('dark');
  });

  it('覆盖既有叶子节点时不影响其兄弟', () => {
    const tree: Record<string, unknown> = {
      provider: { name: 'old', timeout: 5000 },
    };

    setByPointer(tree, '/provider/name', 'new');

    expect(getByPointer(tree, '/provider/name')).toBe('new');
    // 同级兄弟不受覆盖影响
    expect(getByPointer(tree, '/provider/timeout')).toBe(5000);
  });

  it('按数组下标定位并写入，保留数组内其它元素', () => {
    const tree: Record<string, unknown> = {
      models: [{ id: 'a' }, { id: 'b' }, { id: 'c' }],
    };

    // 写入下标 1 元素的子字段
    setByPointer(tree, '/models/1/id', 'B');

    expect(getByPointer(tree, '/models/1/id')).toBe('B');
    // 其它数组元素保持不变
    expect(getByPointer(tree, '/models/0/id')).toBe('a');
    expect(getByPointer(tree, '/models/2/id')).toBe('c');
  });

  it('下一段为数字下标时自动创建数组作为中间容器', () => {
    const tree: Record<string, unknown> = {};
    // "/list/0" 的下一段 "0" 为合法下标，故 list 应被创建为数组
    setByPointer(tree, '/list/0/value', 42);

    expect(Array.isArray((tree as { list: unknown }).list)).toBe(true);
    expect(getByPointer(tree, '/list/0/value')).toBe(42);
  });

  it('写入根指针时抛出错误', () => {
    const tree: Record<string, unknown> = {};
    expect(() => setByPointer(tree, '', 'x')).toThrow();
  });
});

describe('getByPointer 单元测试', () => {
  it('路径缺失或类型不匹配时返回 undefined', () => {
    const tree = { a: { b: 1 } };
    // 缺失属性
    expect(getByPointer(tree, '/a/missing')).toBeUndefined();
    // 在基础类型上继续下钻
    expect(getByPointer(tree, '/a/b/c')).toBeUndefined();
    // 数组下标越界
    expect(getByPointer({ arr: [1] }, '/arr/5')).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// Property 2（支撑）: 兄弟节点保持不变
// 对随机构造的树与随机指针/值，断言 set 后不属于写入路径的兄弟节点保持原值。
// Validates: Requirements 10.6 / Property 2
// ---------------------------------------------------------------------------

/** 可安全比较与写入的标量值生成器（排除会与容器混淆的 object/array） */
const scalarArb: fc.Arbitrary<unknown> = fc.oneof(
  fc.string(),
  fc.integer(),
  fc.boolean(),
);

/** 合法对象属性名：非空、不含 "/" 与 "~"，且不是纯数字（避免被当作数组下标） */
const objectKeyArb: fc.Arbitrary<string> = fc
  .string({ minLength: 1, maxLength: 6 })
  .filter((s) => !s.includes('/') && !s.includes('~') && !/^[0-9]+$/.test(s));

describe('Property 2（支撑）: 兄弟节点保持不变', () => {
  it('set 后不在写入路径上的兄弟节点保持不变', () => {
    fcAssert(
      fc.property(
        // 写入路径的各层字段名（全部为对象键，彼此可能重复，用 uniqueArray 去重保证路径确定）
        fc.uniqueArray(objectKeyArb, { minLength: 1, maxLength: 4 }),
        // 沿途每一层要额外放置的兄弟字段集合（键 -> 标量值）
        fc.array(fc.dictionary(objectKeyArb, scalarArb), { minLength: 0, maxLength: 4 }),
        // 待写入的目标值
        scalarArb,
        (pathKeys, siblingLayers, value) => {
          // 1) 构造一棵树：沿着 pathKeys 逐层下钻，在每一层注入兄弟字段。
          //    同时记录每个兄弟字段的「绝对指针 -> 期望值」快照，供写入后比对。
          const root: Record<string, unknown> = {};
          const siblingSnapshots: Array<{ pointer: string; expected: unknown }> = [];

          let cursor: Record<string, unknown> = root;
          const prefixSegments: string[] = [];
          for (let depth = 0; depth < pathKeys.length; depth += 1) {
            const key = pathKeys[depth]!;
            // 在当前层注入兄弟字段：排除与本层路径键相同的键，避免被路径占用
            const layer = siblingLayers[depth] ?? {};
            for (const [sibKey, sibVal] of Object.entries(layer)) {
              if (sibKey === key) {
                continue;
              }
              cursor[sibKey] = sibVal;
              const sibPointer = toPointer([...prefixSegments, sibKey]);
              siblingSnapshots.push({ pointer: sibPointer, expected: sibVal });
            }

            if (depth < pathKeys.length - 1) {
              // 非末层：下钻进入下一层对象容器
              const child: Record<string, unknown> = {};
              cursor[key] = child;
              cursor = child;
              prefixSegments.push(key);
            }
          }

          // 2) 目标指针指向 pathKeys 构成的完整路径
          const targetPointer = toPointer(pathKeys);

          // 3) 执行写入
          setByPointer(root, targetPointer, value);

          // 4) 断言：目标写入成功
          expect(getByPointer(root, targetPointer)).toStrictEqual(value);

          // 5) 断言：所有记录的兄弟节点保持原值不变
          for (const { pointer, expected } of siblingSnapshots) {
            expect(getByPointer(root, pointer)).toStrictEqual(expected);
          }

          return true;
        },
      ),
    );
  });
});

/**
 * 将分段数组编码为 RFC 6901 JSON 指针字符串（对 "~" 与 "/" 做转义）。
 * 测试内部使用：此处生成的键已通过生成器约束排除了 "/" 与 "~"，转义仅为稳健。
 */
function toPointer(segments: string[]): string {
  if (segments.length === 0) {
    return '';
  }
  return `/${segments
    .map((s) => s.replace(/~/g, '~0').replace(/\//g, '~1'))
    .join('/')}`;
}
