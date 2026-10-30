// 字段级合并 render 引擎（数据驱动）
//
// 本模块实现 AgentAdapter 的核心能力之一：把供应商中立的 ProviderConfig 与某个
// agent 既有配置文件内容做「字段级合并」，只改写 FormatMapping.managedPaths 指定的
// 受管字段，完整保留用户的非 API 设置（主题、快捷键、MCP 等），再序列化为该 agent
// 约定格式的完整文本，并产出一份对明文密钥掩码的 diff 供 UI 预览。
//
// 设计依据（参照 design.md「字段级合并算法：render」与 FormatMapping 声明）：
//   1. 解析既有内容为可操作的树（按 mapping.format）；不存在则以空对象起步。
//   2. 遍历 managedPaths，按 fieldPaths 把 config 的中立字段值深层写入目标指针，
//      保留不属于该路径的兄弟字段（依赖 setByPointer 的兄弟保真语义）。
//   3. 凭据适配：key 的 agent 差异（字段名/位置/引用形式/格式）在此转换，
//      优先用声明式 CredentialMapping 覆盖，不污染 ProviderConfig（经 injectCredential）。
//      特殊封装（base64/签名/连接串等）经可注入的 transform 钩子兜底；transform 失败则
//      终止 render、不产生部分写入的合并内容，并以 RenderError 形式抛出错误。
//   4. 序列化为该格式文本，并基于「原始树」与「掩码后的新树」生成掩码 diff，
//      确保 maskedDiff 中绝不出现明文密钥。
//
// 密钥安全约束（对应需求 2.8 / Property 1）：
//   - maskedDiff 无论 inline/env/secrets-file 形态都不得包含明文 apiKey；
//   - 本模块对「将写入文件的树」做一次深拷贝并掩码其中的 key 相关值后再做 diff，
//     原始待写入的 tree（含明文或引用占位）仅用于序列化 mergedContent。

import type { ConfigFormat, FormatMapping, ProviderConfig, RenderResult } from "@shared/types";
import { setByPointer, getByPointer } from "./pointer";
import { maskSecret } from "./mask";
import {
  injectCredential,
  RenderError,
  type InjectCredentialDeps,
  type TransformResolver,
} from "./injectCredential";
import * as YAML from "js-yaml";
import * as TOML from "@iarna/toml";

/** 文档树节点的通用类型（object / array / 基础值任意嵌套） */
type Json = unknown;

// 重新导出凭据/渲染错误类型，便于上层（适配器基类、Distributor）统一从 render 处消费。
export { RenderError } from "./injectCredential";
export type {
  RenderErrorCode,
  WriteEnv,
  WriteSecretsFile,
  TransformHook,
  TransformResolver,
  InjectCredentialDeps,
} from "./injectCredential";

/**
 * render 的可注入依赖集合（全部可选，保持与既有调用向后兼容）。
 *
 * - writeEnv / writeSecretsFile：凭据 env / secrets-file 形态下把明文落到引用目标的依赖，
 *   缺省使用面向生产的默认实现（写 process.env / 写 JSON secrets 文件）。测试注入内存实现。
 * - transformResolver：transform 钩子解析器；声明了 mapping.transform 时必须注入，否则按
 *   transform-not-found 终止 render。
 */
export interface RenderDeps extends InjectCredentialDeps {
  /** transform 钩子解析器；缺省且声明了 transform 时按 not-found 处理 */
  transformResolver?: TransformResolver;
}

// ===========================================================================
// 解析与序列化：按 ConfigFormat 分派到对应的编解码实现
// ===========================================================================

/**
 * 把既有配置文本解析为可操作的文档树。
 *
 * - json / jsonc：用 JSON 解析；jsonc 先剥离注释与尾随逗号后再解析，保证容错。
 * - yaml：用 js-yaml 解析（空文档得到 undefined，归一化为 {}）。
 * - toml：用 @iarna/toml 解析。
 *
 * @param content 既有文件文本
 * @param format  目标格式
 * @returns 解析得到的对象树（根通常为对象）
 * @throws 当文本无法按声明格式解析时抛出错误（供上层判定「既有文件损坏」而不覆盖）
 */
function parseContent(content: string, format: ConfigFormat): Record<string, Json> {
  switch (format) {
    case "json": {
      const parsed = JSON.parse(content) as Json;
      return asObjectTree(parsed);
    }
    case "jsonc": {
      // jsonc 允许注释与尾随逗号：先剥离再按 JSON 解析
      const stripped = stripJsonc(content);
      const parsed = JSON.parse(stripped) as Json;
      return asObjectTree(parsed);
    }
    case "yaml": {
      const parsed = YAML.load(content) as Json;
      // 空 YAML 文档解析为 undefined，归一化为空对象
      return parsed === undefined || parsed === null ? {} : asObjectTree(parsed);
    }
    case "toml": {
      const parsed = TOML.parse(content) as Json;
      return asObjectTree(parsed);
    }
    default: {
      // 穷尽所有已知格式；新增格式需在此补充分支
      return assertNeverFormat(format);
    }
  }
}

/**
 * 把文档树序列化为目标格式的完整文本。
 *
 * - json：两空格缩进的标准 JSON。
 * - jsonc：以 JSON 形式输出（保留合并后的数据；注释不作为数据回写，属已知取舍）。
 * - yaml：用 js-yaml dump。
 * - toml：用 @iarna/toml stringify。
 *
 * @param tree   待序列化的文档树
 * @param format 目标格式
 * @returns 序列化后的文本
 */
function serializeTree(tree: Record<string, Json>, format: ConfigFormat): string {
  switch (format) {
    case "json":
    case "jsonc": {
      // jsonc 暂以标准 JSON 输出：合并后的数据完整、可被 jsonc 解析器读取；
      // 既有注释不随数据回写（如需保留注释需引入保留式编辑器，属后续扩展点）。
      return JSON.stringify(tree, null, 2);
    }
    case "yaml": {
      return YAML.dump(tree);
    }
    case "toml": {
      return TOML.stringify(tree as Record<string, unknown>);
    }
    default: {
      return assertNeverFormat(format);
    }
  }
}

/**
 * 剥离 jsonc 中的注释（// 行注释、块注释）与对象/数组的尾随逗号。
 *
 * 采用逐字符扫描以避免误删字符串字面量内的 `//`、`/*` 等序列；
 * 对转义字符做基本处理，覆盖常见 jsonc 配置文件。
 *
 * @param input jsonc 文本
 * @returns 去除注释与尾随逗号后的、可被标准 JSON 解析的文本
 */
function stripJsonc(input: string): string {
  let result = "";
  let inString = false; // 是否处于字符串字面量内
  let escaped = false; // 上一个字符是否为转义反斜杠
  let i = 0;
  const n = input.length;

  while (i < n) {
    const ch = input[i]!;
    const next = i + 1 < n ? input[i + 1] : "";

    if (inString) {
      // 字符串内原样保留，并正确跟踪转义，直到遇到未转义的引号
      result += ch;
      if (escaped) {
        escaped = false;
      } else if (ch === "\\") {
        escaped = true;
      } else if (ch === '"') {
        inString = false;
      }
      i += 1;
      continue;
    }

    // 非字符串状态下，识别注释起始
    if (ch === "/" && next === "/") {
      // 行注释：跳到行末
      i += 2;
      while (i < n && input[i] !== "\n") {
        i += 1;
      }
      continue;
    }
    if (ch === "/" && next === "*") {
      // 块注释：跳到 */ 之后
      i += 2;
      while (i < n && !(input[i] === "*" && input[i + 1] === "/")) {
        i += 1;
      }
      i += 2; // 跳过结尾的 */
      continue;
    }
    if (ch === '"') {
      // 进入字符串字面量
      inString = true;
      result += ch;
      i += 1;
      continue;
    }

    result += ch;
    i += 1;
  }

  // 去除对象/数组中的尾随逗号（如 { "a": 1, }、[ 1, 2, ]）
  return result.replace(/,(\s*[}\]])/g, "$1");
}

/**
 * 把解析结果规整为「对象树」。根若非对象（如数组或基础值）则包进一个空对象返回，
 * 以保证后续 setByPointer 始终在对象根上操作（指针写入需要可回填的父容器）。
 */
function asObjectTree(parsed: Json): Record<string, Json> {
  if (parsed !== null && typeof parsed === "object" && !Array.isArray(parsed)) {
    return parsed as Record<string, Json>;
  }
  // 非对象根（数组/基础值）在各 agent 配置中罕见；此处不丢失，但以空对象为合并基座。
  // 若命中此分支，说明既有文件根结构非常规，交由上层按需处理。
  return {};
}

/** 穷尽性校验：出现未知 ConfigFormat 时在运行时明确报错 */
function assertNeverFormat(format: never): never {
  throw new Error(`不支持的配置格式：${String(format)}`);
}

// ===========================================================================
// 中立字段值构建：把 ProviderConfig 的中立字段映射为「逻辑字段名 → 值」
// ===========================================================================

/**
 * 从中立 ProviderConfig 构建「逻辑字段名 → 目标值」映射。
 *
 * 这些逻辑字段名即 FormatMapping.fieldPaths 的键；render 按 managedPaths 选取
 * 其中一部分写入目标文件。注意：本映射**只含供应商中立字段，绝不含 key**，
 * key 的落位一律交由 injectCredential 按 CredentialMapping 处理。
 *
 * 约定支持的中立逻辑字段（可按需扩展）：
 * - baseUrl ：API 基础地址
 * - models  ：已选分发模型 id 列表
 * - timeout / timeoutMs ：请求超时（毫秒）
 * - proxy   ：代理地址（取 proxy.url）
 * - name    ：provider 名称
 *
 * 值为 undefined 的字段不会被写入（避免把 undefined 落进配置文件）。
 */
function buildManagedValues(config: ProviderConfig): Record<string, Json> {
  const values: Record<string, Json> = {
    baseUrl: config.baseUrl,
    models: config.models,
    name: config.name,
  };

  // 超时：同时登记 timeout / timeoutMs 两个别名，兼容不同 mapping 的字段命名
  if (config.timeoutMs !== undefined) {
    values.timeout = config.timeoutMs;
    values.timeoutMs = config.timeoutMs;
  }

  // 代理：仅在配置了代理时登记其地址
  if (config.proxy?.url !== undefined) {
    values.proxy = config.proxy.url;
  }

  return values;
}

// ===========================================================================
// 掩码 diff：对「将写入的树」深拷贝并掩码其中受管字段与凭据，再做文本级 diff
// ===========================================================================

/**
 * 对一棵即将序列化的树做深拷贝，并把「受管的字符串值」掩码后返回。
 *
 * 目的：生成 maskedDiff 时不泄露明文密钥。策略是遍历 managedPaths 与 credential
 * 的 targetPointer 指向的叶子，如为字符串则用 maskSecret 掩码。对 env/secrets-file
 * 引用形态，其值本身是引用占位（不含明文），掩码后仍为占位，不影响可读性但更保守。
 *
 * @param tree    待掩码的树（将被深拷贝，不改动原树）
 * @param mapping 格式映射（提供受管路径与凭据目标指针）
 * @param apiKey  明文密钥（用于确保不残留；此处不直接使用其值，仅保证不写入）
 * @returns 掩码后的新树
 */
function maskTreeForDiff(
  tree: Record<string, Json>,
  mapping: FormatMapping,
  apiKey: string,
): Record<string, Json> {
  // 深拷贝，避免污染待写入的真实树
  const clone = structuredCloneCompat(tree);

  // 收集需要掩码的目标指针：凭据目标指针（可能含明文），以及 fieldPaths 中
  // 任何可能承载 key 的字段映射（向后兼容：无 credential 声明时 key 走 fieldPaths）。
  const pointersToMask = new Set<string>();

  if (mapping.credential) {
    pointersToMask.add(mapping.credential.targetPointer);
  }

  // 对每个受管字段对应的目标指针也做防御性掩码：
  // 若某受管字段恰好承载了密钥（例如旧式直接明文映射），其值会被掩码。
  for (const logicalField of mapping.managedPaths) {
    const pointer = mapping.fieldPaths[logicalField];
    if (pointer) {
      pointersToMask.add(pointer);
    }
  }

  for (const pointer of pointersToMask) {
    const value = getByPointer(clone, pointer);
    if (typeof value === "string") {
      // 仅当该字符串「包含明文 apiKey」时才需要掩码其中的敏感部分；
      // 但为稳妥起见，对凭据目标指针一律掩码整串（inline 明文形态）。
      if (pointer === mapping.credential?.targetPointer) {
        setByPointer(clone, pointer, maskStringContainingKey(value, apiKey));
      } else if (apiKey !== "" && value.includes(apiKey)) {
        // 受管字段里意外混入了明文 key：掩码该明文片段
        setByPointer(clone, pointer, maskStringContainingKey(value, apiKey));
      }
    }
  }

  return clone;
}

/**
 * 掩码字符串中的密钥明文。
 *
 * - 若字符串恰好等于明文 key，直接返回 maskSecret(key)。
 * - 若字符串包含明文 key（如带前缀的 "Bearer sk-xxx"），把其中的明文片段替换为掩码串，
 *   保留非密钥前后缀（便于 diff 可读）。
 * - 若不含明文（env/secrets 引用占位），原样返回。
 *
 * @param value  待检查的字符串值
 * @param apiKey 明文密钥
 * @returns 掩码后的字符串
 */
function maskStringContainingKey(value: string, apiKey: string): string {
  if (apiKey === "") {
    return value;
  }
  if (value === apiKey) {
    return maskSecret(apiKey);
  }
  if (value.includes(apiKey)) {
    // 把明文片段替换为其掩码形式，保留前后缀（如 "Bearer ****"）
    return value.split(apiKey).join(maskSecret(apiKey));
  }
  return value;
}

/**
 * structuredClone 的兼容封装：优先用全局 structuredClone，回退到 JSON 深拷贝。
 * 配置树均为可 JSON 序列化的纯数据，JSON 回退足够安全。
 */
function structuredCloneCompat(tree: Record<string, Json>): Record<string, Json> {
  const globalClone = (globalThis as { structuredClone?: <T>(v: T) => T }).structuredClone;
  if (typeof globalClone === "function") {
    return globalClone(tree);
  }
  return JSON.parse(JSON.stringify(tree)) as Record<string, Json>;
}

/**
 * 生成「原始内容」与「合并后（已掩码）内容」的逐行差异文本。
 *
 * 采用朴素的逐行标注：以两份序列化文本的行集合做对比，
 * - 以 "-" 前缀标注仅在原始中出现的行（被改动/删除）；
 * - 以 "+" 前缀标注仅在新内容中出现的行（新增/改动后的值）；
 * - 以 " " 前缀标注两侧一致的上下文行。
 * 该 diff 仅供 UI 预览展示，不追求最小编辑脚本；新内容侧已整体掩码，绝不含明文。
 *
 * @param originalText 原始序列化文本（既有文件内容按格式重序列化，保证可比）
 * @param maskedText   合并后、已掩码的序列化文本
 * @returns 带行前缀的差异文本
 */
function buildLineDiff(originalText: string, maskedText: string): string {
  const originalLines = originalText.split("\n");
  const maskedLines = maskedText.split("\n");
  const originalSet = new Set(originalLines);
  const maskedSet = new Set(maskedLines);

  const lines: string[] = [];

  // 先输出原始侧被移除/改动的行
  for (const line of originalLines) {
    if (!maskedSet.has(line)) {
      lines.push(`- ${line}`);
    }
  }
  // 再输出新内容侧新增/改动后的行；两侧一致的行作为上下文
  for (const line of maskedLines) {
    if (originalSet.has(line)) {
      lines.push(`  ${line}`);
    } else {
      lines.push(`+ ${line}`);
    }
  }

  return lines.join("\n");
}

// ===========================================================================
// 主入口：render
// ===========================================================================

/**
 * 数据驱动的字段级合并渲染。
 *
 * 把中立 ProviderConfig 的受管字段写入某 agent 既有配置（保留非受管字段），
 * 产出合并后的完整文本与对明文密钥掩码的 diff。
 *
 * @param config          供应商中立的 Provider 配置（不含 agent 专属 key 字段）
 * @param apiKey          解析出的明文密钥（本地/无鉴权场景可为空串）
 * @param existingContent 既有配置文件文本；不存在时传 null
 * @param mapping         该 agent 的格式映射（format / fieldPaths / managedPaths / credential / transform）
 * @param deps            可选依赖：凭据落地（writeEnv/writeSecretsFile）与 transform 钩子解析器
 * @returns RenderResult：mergedContent（完整文本）+ maskedDiff（掩码差异，无明文）
 * @throws 当既有内容无法按 mapping.format 解析（文件损坏）时抛出错误，供上层拒绝覆盖
 * @throws RenderError 当凭据注入边界失败（env 缺 envVarName / secrets-file 缺目标 /
 *         引用目标写入失败）或 transform 钩子失败时；此时 render 终止且不返回部分合并内容
 */
export function render(
  config: ProviderConfig,
  apiKey: string,
  existingContent: string | null,
  mapping: FormatMapping,
  deps: RenderDeps = {},
): RenderResult {
  // 1. 解析既有内容为可操作的树；不存在则以空对象起步
  const tree: Record<string, Json> =
    existingContent !== null ? parseContent(existingContent, mapping.format) : {};

  // 保存「原始树」的序列化文本用于生成 diff（对既有内容按同一格式重序列化，
  // 保证与合并后文本可逐行比较，不受原始缩进/排序差异干扰）
  const originalTree = structuredCloneCompat(tree);

  // 2. 把中立字段按映射写入目标路径（只动受管字段，保留兄弟字段）
  const values = buildManagedValues(config);
  for (const logicalField of mapping.managedPaths) {
    // 受管字段必须在 fieldPaths 中声明其目标指针
    const targetPointer = mapping.fieldPaths[logicalField];
    if (!targetPointer) {
      throw new Error(
        `managedPaths 中的字段 "${logicalField}" 未在 fieldPaths 中声明目标指针`,
      );
    }
    const value = values[logicalField];
    // 跳过 undefined 值，避免把未配置的中立字段写成 undefined/null
    if (value === undefined) {
      continue;
    }
    setByPointer(tree, targetPointer, value);
  }

  // 2b. 凭据适配（key 的 agent 差异在此转换，不污染 ProviderConfig）。
  //     优先使用声明式 CredentialMapping（inline/env/secrets-file 三形态）；无声明时沿用
  //     fieldPaths 的明文映射（向后兼容）。env/secrets-file 形态下只往 tree 写引用占位，
  //     明文经可注入的 writeEnv/writeSecretsFile 落到各自目标；边界失败（缺 envVarName /
  //     缺 secretsFile 目标 / 引用目标写入失败）由 injectCredential 抛出 RenderError，
  //     render 直接向上传播——此时尚未序列化、也未返回合并内容，故不产生部分写入。
  injectCredential(tree, mapping, config, apiKey, {
    writeEnv: deps.writeEnv,
    writeSecretsFile: deps.writeSecretsFile,
  });

  // 3. 可选自定义变换（transform）——无法用路径/声明表达的特殊封装（base64/签名/连接串等）。
  //    经可注入的 transformResolver 按钩子名解析并执行；任何失败都终止 render、不产生部分
  //    写入的合并内容，并抛出带 transform-failed/transform-not-found 错误码的 RenderError。
  const transformedTree = applyTransform(tree, mapping, config, apiKey, deps.transformResolver);

  // 4. 序列化 + 生成掩码 diff
  const mergedContent = serializeTree(transformedTree, mapping.format);

  // 对「待写入树」（已含凭据注入与 transform 结果）深拷贝并掩码其中的凭据/受管字段，
  // 再序列化用于 diff，确保无明文
  const maskedTree = maskTreeForDiff(transformedTree, mapping, apiKey);
  const originalText = serializeTree(originalTree, mapping.format);
  const maskedText = serializeTree(maskedTree, mapping.format);
  const maskedDiff = buildLineDiff(originalText, maskedText);

  // 后置断言：maskedDiff 绝不含明文密钥（对应 Property 1 / 需求 2.8）
  if (apiKey !== "" && maskedDiff.includes(apiKey)) {
    throw new Error("内部错误：maskedDiff 意外包含明文密钥，已阻断以防泄露");
  }

  return { mergedContent, maskedDiff };
}

/**
 * 应用可选的 transform 自定义变换钩子（render 第 3 步）。
 *
 * transform 用于无法用 CredentialMapping 声明表达的特殊封装（base64、签名、
 * provider+key 连接串等——少数特例）。本函数按 mapping.transform 的钩子名经可注入的
 * transformResolver 解析出钩子并执行，返回变换后的树（钩子可返回新树或就地改写后的同一树）。
 *
 * 错误语义（对应需求 9.2）：任何失败都终止 render、不产生部分写入的合并内容，
 * 并抛出带错误码的 RenderError——
 * - 未声明 transform：直接返回原树（无变换，不报错）。
 * - 声明了 transform 但未注入 transformResolver，或解析不到对应钩子：transform-not-found。
 * - 钩子执行抛出异常：transform-failed（包装原始错误便于诊断）。
 *
 * 之所以在失败时「不产生部分写入」：本函数在序列化之前执行，抛错会使 render 直接向上
 * 传播、从不返回 mergedContent；transform 返回的新树仅在成功时才进入后续序列化。
 *
 * @param tree     凭据注入后的文档树
 * @param mapping  格式映射（读取 transform 钩子名）
 * @param config   provider 配置
 * @param apiKey   明文密钥
 * @param resolver 可注入的 transform 钩子解析器；缺省且声明了 transform 时按 not-found 处理
 * @returns 变换后的树；未声明 transform 时原样返回 tree
 * @throws RenderError transform-not-found / transform-failed
 */
function applyTransform(
  tree: Record<string, Json>,
  mapping: FormatMapping,
  config: ProviderConfig,
  apiKey: string,
  resolver?: TransformResolver,
): Record<string, Json> {
  // 未声明 transform：无特殊封装，原样返回
  if (!mapping.transform) {
    return tree;
  }

  // 声明了 transform 但无解析器：无法解析钩子名，按 not-found 终止
  if (!resolver) {
    throw new RenderError(
      "transform-not-found",
      `声明了 transform 钩子 "${mapping.transform}"，但未注入 transformResolver，无法解析`,
    );
  }

  const hook = resolver.resolve(mapping.transform);
  if (!hook) {
    throw new RenderError(
      "transform-not-found",
      `transform 钩子 "${mapping.transform}" 未在解析器中注册`,
    );
  }

  try {
    const result = hook(tree, config, apiKey);
    // 钩子未返回有效对象树时视为失败，避免把 undefined/非对象带入后续序列化
    if (result === null || typeof result !== "object" || Array.isArray(result)) {
      throw new Error("transform 钩子未返回有效的对象树");
    }
    return result;
  } catch (err) {
    // 已是 RenderError（如钩子内部直接抛出）则原样传播；否则包装为 transform-failed
    if (err instanceof RenderError) {
      throw err;
    }
    throw new RenderError(
      "transform-failed",
      `transform 钩子 "${mapping.transform}" 执行失败：${err instanceof Error ? err.message : String(err)}`,
      err,
    );
  }
}
