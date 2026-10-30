// JSON 指针式路径读写工具（纯函数）
//
// 本模块提供对文档树（object / array 任意嵌套）的按指针读写能力，供字段级合并
// render 引擎（任务 3.9）与模型响应归一化（任务 6.2）复用。
//
// 指针语法遵循 RFC 6901 JSON Pointer 约定：
// - 以 "/" 分隔的若干段（token）构成，如 "/provider/name/options/baseURL"；
// - 空字符串 "" 指向整棵树的根节点；
// - 段内的转义：`~1` 表示字面量 "/"，`~0` 表示字面量 "~"；
// - 当目标容器为数组时，段为十进制数字字符串表示下标。
//
// 对应需求 10.6：setByPointer 写入目标指针时，创建沿途缺失的中间对象，
// 并保持不属于该路径的兄弟节点不变。

/** 文档树中任意可出现的值类型 */
type Json = unknown;

/**
 * 解析 JSON 指针字符串为分段数组，并对 `~1`/`~0` 做反转义。
 *
 * @param pointer 指针字符串；空串表示根，非空串必须以 "/" 开头
 * @returns 反转义后的分段数组；根指针返回空数组
 * @throws 当 pointer 非空且未以 "/" 开头时抛出错误（非法指针）
 */
function parsePointer(pointer: string): string[] {
  // 空指针表示根节点，分段为空
  if (pointer === '') {
    return [];
  }
  // 合法的非根指针必须以 "/" 起始
  if (pointer[0] !== '/') {
    throw new Error(`非法的 JSON 指针（必须以 "/" 开头）：${pointer}`);
  }
  // 去掉首个 "/" 后按 "/" 切分，并对每段做反转义
  // 注意：转义顺序必须先还原 ~1 再还原 ~0，以避免 "~01" 被误解
  return pointer
    .substring(1)
    .split('/')
    .map((segment) => segment.replace(/~1/g, '/').replace(/~0/g, '~'));
}

/**
 * 判断某个分段是否表示合法的数组下标（非负整数的十进制字符串）。
 *
 * @param segment 指针分段
 * @returns 该段为纯数字且可作为数组下标时返回 true
 */
function isArrayIndex(segment: string): boolean {
  // 仅接受由数字组成且无前导零歧义的十进制串（"0" 合法，"01" 不合法）
  return /^(0|[1-9][0-9]*)$/.test(segment);
}

/**
 * 读取指针指向的节点。支持对象属性与数组下标的混合定位。
 *
 * 常用于读取响应中的模型数组（如 arrayPointer="/data"）。当路径中任一环节
 * 不存在或类型不匹配（例如在非对象/非数组上继续下钻）时，返回 undefined，
 * 不抛出异常，便于调用方据此判定"格式非预期"。
 *
 * @param tree 待读取的文档树
 * @param pointer JSON 指针字符串
 * @returns 指针指向的值；无法定位时返回 undefined
 */
export function getByPointer(tree: Json, pointer: string): Json {
  const segments = parsePointer(pointer);
  // 从根开始逐段下钻
  let current: Json = tree;
  for (const segment of segments) {
    // 命中 null/undefined 或基础类型时无法继续下钻
    if (current === null || current === undefined) {
      return undefined;
    }
    if (Array.isArray(current)) {
      // 数组环节：段必须是合法下标且在范围内
      if (!isArrayIndex(segment)) {
        return undefined;
      }
      const index = Number(segment);
      if (index >= current.length) {
        return undefined;
      }
      current = current[index];
    } else if (typeof current === 'object') {
      // 对象环节：按属性名取值（缺失属性得到 undefined，下一轮循环即返回）
      current = (current as Record<string, Json>)[segment];
    } else {
      // 基础类型（string/number/boolean）上无法继续下钻
      return undefined;
    }
  }
  return current;
}

/**
 * 将 value 写入指针指向的位置，并创建沿途缺失的中间对象。
 *
 * 写入行为遵循需求 10.6：
 * - 深层写入：路径上缺失的中间容器会被自动创建；
 * - 兄弟保留：不属于该路径的兄弟节点保持原样不变（原地修改既有容器，
 *   仅覆盖目标叶子节点，不重建整条分支，从而不触碰同级其它字段）；
 * - 容器类型推断：若某段为合法数组下标，则缺失时创建数组，否则创建普通对象。
 *
 * 该函数就地修改传入的 tree 并原样返回，便于链式调用。
 *
 * @param tree 可变文档树（根通常为对象或数组）
 * @param pointer JSON 指针字符串；根指针（""）不支持整树替换，将抛出错误
 * @param value 要写入目标位置的值
 * @returns 修改后的同一棵树
 * @throws 当 pointer 为根指针，或在数组与对象之间出现类型冲突时抛出错误
 */
export function setByPointer<T extends object>(tree: T, pointer: string, value: Json): T {
  const segments = parsePointer(pointer);
  // 根指针无法作为"设置目标"：没有可供回填的父容器
  if (segments.length === 0) {
    throw new Error('setByPointer 不支持写入根指针（"")');
  }

  // 逐段下钻至目标叶子的父容器，沿途按需创建缺失的中间容器
  let current: Record<string, Json> | Json[] = tree as Record<string, Json> | Json[];
  for (let i = 0; i < segments.length - 1; i += 1) {
    const segment = segments[i]!;
    // 下一段决定"本段若缺失时"应创建数组还是对象
    const nextSegment = segments[i + 1]!;
    const childShouldBeArray = isArrayIndex(nextSegment);

    if (Array.isArray(current)) {
      // 当前容器是数组：本段必须是合法下标
      if (!isArrayIndex(segment)) {
        throw new Error(`指针段与容器类型冲突：在数组上使用非下标段 "${segment}"`);
      }
      const index = Number(segment);
      const existing = current[index];
      if (existing === null || existing === undefined) {
        // 缺失则按下一段推断类型创建中间容器
        const created: Record<string, Json> | Json[] = childShouldBeArray ? [] : {};
        current[index] = created;
        current = created;
      } else if (typeof existing === 'object') {
        // 已存在的容器原地复用，保留其内部兄弟节点
        current = existing as Record<string, Json> | Json[];
      } else {
        throw new Error(`指针路径与既有基础类型冲突于下标 "${segment}"`);
      }
    } else {
      // 当前容器是对象：按属性名下钻
      const existing = current[segment];
      if (existing === null || existing === undefined) {
        // 缺失则按下一段推断类型创建中间容器
        const created: Record<string, Json> | Json[] = childShouldBeArray ? [] : {};
        current[segment] = created;
        current = created;
      } else if (typeof existing === 'object') {
        // 已存在的容器原地复用，保留其内部兄弟节点
        current = existing as Record<string, Json> | Json[];
      } else {
        throw new Error(`指针路径与既有基础类型冲突于字段 "${segment}"`);
      }
    }
  }

  // 在父容器上写入目标叶子节点
  const lastSegment = segments[segments.length - 1]!;
  if (Array.isArray(current)) {
    if (!isArrayIndex(lastSegment)) {
      throw new Error(`指针段与容器类型冲突：在数组上使用非下标段 "${lastSegment}"`);
    }
    current[Number(lastSegment)] = value;
  } else {
    current[lastSegment] = value;
  }

  return tree;
}
