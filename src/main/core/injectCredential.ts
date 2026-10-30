// 凭据适配引擎（injectCredential，数据驱动）
//
// 本模块是 AgentAdapter.render 的凭据注入核心：把供应商中立的明文密钥（apiKey）
// 适配成「某个 agent 要求的字段名 / 位置 / 引用形式 / 格式」，写入该 agent 的配置
// 文档树（tree）。各 agent 的 key 差异一律在此经声明式 CredentialMapping 转换，
// 从而保证统一真相 ProviderConfig 的供应商中立（不为任何 agent 的 key 写法保留字段）。
//
// 分派规则（按 CredentialMapping.form，参照 design.md「凭据适配算法：injectCredential」）：
//   - inline       ：targetPointer 处写入按 valueTemplate 渲染的明文（含可能的前缀/封装）。
//   - env          ：targetPointer 处只写「环境变量引用占位」（不含明文），
//                    明文经可注入的 writeEnv 落到 envVarName 对应的环境变量 / 该 agent 的 .env。
//   - secrets-file ：targetPointer 处只写「对独立 secrets 文件的引用占位」（不含明文），
//                    明文经可注入的 writeSecretsFile 落到 secretsFile.path 的 entryKey。
//
// 边界与错误语义（对应需求 9.3 / 9.4 / 9.5）：
//   - apiKey 为空（本地/无鉴权场景）：直接跳过凭据注入，不做任何写入。
//   - 无 credential 声明：向后兼容，沿用 fieldPaths 对 key 字段的直接明文映射（此处不额外处理）。
//   - env 形态缺少 envVarName：终止并抛出带错误码的 RenderError（env 缺少 envVarName）。
//   - secrets-file 形态缺少 secretsFile（路径或条目）：终止并抛出 RenderError。
//   为保证「不产生部分写入」：引擎先对声明做完整性校验，只有校验通过后才执行
//   setByPointer 写占位与 writeEnv/writeSecretsFile 落明文这两步副作用。
//
// 密钥安全约束（对应 Property 1 / Property 14）：
//   - env / secrets-file 形态下，写入 tree 的只是引用占位，配置文件本身不含明文；
//   - 明文仅经 writeEnv / writeSecretsFile 落到各自的目标，不进入配置文件与回传数据。

import * as fs from "node:fs";

import type { CredentialMapping, FormatMapping, ProviderConfig } from "@shared/types";
import { setByPointer } from "./pointer";

/** 文档树节点的通用类型 */
type Json = unknown;

// ===========================================================================
// 错误类型：带错误码的结构化 render 错误，便于上层（Distributor）判定失败原因
// ===========================================================================

/**
 * render / 凭据注入阶段的错误码。
 *
 * 上层（分发编排器）可据此区分失败类别并给出贴切提示，同时满足需求对
 * 「返回错误指示」的要求（env 缺 envVarName、secrets-file 缺目标、transform 失败等）。
 */
export type RenderErrorCode =
  /** env 形态缺少 envVarName（需求 9.4） */
  | "env-missing-var-name"
  /** secrets-file 形态缺少 secretsFile 路径或条目（需求 9.5） */
  | "secrets-file-missing-target"
  /** 凭据引用目标写入失败（env 变量 / secrets 文件落明文失败，场景 11） */
  | "credential-target-write-failed"
  /** transform 钩子执行失败（需求 9.2） */
  | "transform-failed"
  /** 声明了未知的 transform 钩子名，解析器无法解析 */
  | "transform-not-found";

/**
 * render 流程的结构化错误。
 *
 * 抛出此错误即表示本次 render 被终止、不产生部分写入的合并内容；上层据 code/message
 * 判定并把对应 agent 标记为 failed（并回滚其局部改动）。
 */
export class RenderError extends Error {
  /** 错误码，便于上层分类处理与提示 */
  readonly code: RenderErrorCode;
  /** 触发错误的底层原因（如 writeEnv 抛出的 I/O 错误），便于诊断 */
  readonly cause?: unknown;

  constructor(code: RenderErrorCode, message: string, cause?: unknown) {
    super(message);
    this.name = "RenderError";
    this.code = code;
    this.cause = cause;
  }
}

// ===========================================================================
// 可注入依赖：writeEnv / writeSecretsFile / transform 解析器
// ===========================================================================

/**
 * 环境变量 / .env 明文落地的可注入依赖。
 *
 * form="env" 时，配置文件只写引用占位，真正的明文经本依赖落到环境变量目标。
 * 设计为接口 + 默认实现：
 *   - 生产默认实现写入当前进程的 process.env（供同进程后续读取 / 该 agent 继承）；
 *   - 测试可注入内存实现（见 createInMemoryWriteEnv），不触碰真实环境。
 */
export interface WriteEnv {
  /**
   * 把明文密钥写入名为 varName 的环境变量目标。
   * @param varName 环境变量名（如 "ANTHROPIC_API_KEY"）
   * @param value   明文密钥
   * @throws 写入失败时抛出错误（由 injectCredential 包装为 credential-target-write-failed）
   */
  (varName: string, value: string): void;
}

/**
 * 独立 secrets 文件明文落地的可注入依赖。
 *
 * form="secrets-file" 时，配置文件只写引用占位，真正的明文经本依赖落到指定文件的条目。
 * 设计为接口 + 默认实现：
 *   - 生产默认实现把明文以 { entryKey: value } 的 JSON 形态写入 path（见 defaultWriteSecretsFile）；
 *   - 测试可注入内存实现（见 createInMemoryWriteSecretsFile），不触碰真实文件系统。
 */
export interface WriteSecretsFile {
  /**
   * 把明文密钥写入 path 指向的 secrets 文件的 entryKey 条目。
   * @param path     secrets 文件绝对路径（调用方已完成平台变量解析）
   * @param entryKey 文件内的条目键
   * @param value    明文密钥
   * @throws 写入失败时抛出错误（由 injectCredential 包装为 credential-target-write-failed）
   */
  (path: string, entryKey: string, value: string): void;
}

/**
 * transform 钩子：对已合并（含凭据注入后）的文档树做特殊封装变换。
 *
 * 用于无法用 CredentialMapping 声明表达的特例（base64、签名、provider+key 连接串等）。
 * 钩子接收当前 tree、provider 配置与明文 apiKey，返回变换后的新树（或就地改写后返回同一树）。
 * 钩子内部抛出的任何异常都应被 render 捕获并转为 transform-failed 的 RenderError。
 */
export interface TransformHook {
  (tree: Record<string, Json>, config: ProviderConfig, apiKey: string): Record<string, Json>;
}

/**
 * transform 钩子解析器：按钩子名解析出可执行的 TransformHook。
 *
 * 设计为可注入：适配器层在启动时注册各自的特殊封装钩子；测试可注入最小注册表或 mock。
 * 解析不到对应钩子名时返回 undefined，由 render 转为 transform-not-found 错误。
 */
export interface TransformResolver {
  resolve(name: string): TransformHook | undefined;
}

/**
 * injectCredential / render 的可注入依赖集合。
 *
 * 全部可选：缺省时使用面向生产的默认实现（写 process.env / 写 JSON secrets 文件 / 空解析器）。
 * 测试通过注入内存实现与 mock 解析器做到不触碰真实环境与文件系统。
 */
export interface InjectCredentialDeps {
  /** env 形态落明文的依赖；缺省写入 process.env */
  writeEnv?: WriteEnv;
  /** secrets-file 形态落明文的依赖；缺省写入 JSON 文件 */
  writeSecretsFile?: WriteSecretsFile;
}

// ===========================================================================
// 模板渲染：把 valueTemplate 中的占位符展开为实际字符串
// ===========================================================================

/**
 * 渲染凭据值模板。
 *
 * 支持的占位符：
 * - {key}            → 明文密钥（仅 inline 形态应使用；env/secrets 形态的占位不含明文）
 * - {providerName}   → provider 名
 * - {env:VAR} / {VAR}→ env 形态下的环境变量引用占位（原样保留在结果里，用于配置文件）
 *
 * 对 env/secrets 形态，模板里通常是「{env:VAR}」或「${VAR}」这类引用写法，本函数只替换
 * {key} 与 {providerName}，其余引用占位原样保留，从而保证写入 tree 的值不含明文。
 *
 * @param template      值模板
 * @param apiKey        明文密钥（仅在包含 {key} 时才会被展开进结果）
 * @param providerName  provider 名
 * @returns 展开后的字符串
 */
function renderTemplate(template: string, apiKey: string, providerName: string): string {
  // 先替换 {key} 与 {providerName}；两者均做全局替换以兼容模板中出现多次的情形
  return template.split("{key}").join(apiKey).split("{providerName}").join(providerName);
}

// ===========================================================================
// 主入口：injectCredential
// ===========================================================================

/**
 * 数据驱动的凭据适配：把明文密钥按 CredentialMapping 声明写入目标 agent 的文档树。
 *
 * 本函数就地改写 tree（仅在凭据相关位置写入值/引用占位），并在 env/secrets-file 形态下
 * 经可注入依赖把明文落到各自的引用目标。ProviderConfig 不被修改。
 *
 * 不产生部分写入的保证：对 env/secrets-file，先完成声明完整性校验（缺 envVarName /
 * 缺 secretsFile 立即抛错，此时尚未执行任何写入），校验通过后才「写占位 + 落明文」。
 *
 * @param tree    可变文档树（凭据位置将被就地写入）
 * @param mapping 该 agent 的格式映射（读取 credential 声明）
 * @param config  供应商中立的 Provider 配置（提供 {providerName}，不被修改）
 * @param apiKey  解析出的明文密钥；空串表示本地/无鉴权，直接跳过
 * @param deps    可注入依赖（writeEnv / writeSecretsFile）；缺省使用生产默认实现
 * @throws RenderError 当 env 缺 envVarName、secrets-file 缺目标，或引用目标写入失败时
 */
export function injectCredential(
  tree: Record<string, Json>,
  mapping: FormatMapping,
  config: ProviderConfig,
  apiKey: string,
  deps: InjectCredentialDeps = {},
): void {
  // 本地/无鉴权场景：ProviderConfig 允许无 key，直接跳过凭据注入（不做任何写入）
  if (apiKey === "" ) {
    return;
  }

  const cred = mapping.credential;
  // 无 credential 声明：向后兼容——key 的明文映射此前已由 render 的 fieldPaths 处理，
  // 本引擎不再额外写入（避免与 fieldPaths 直接映射重复或冲突）。
  if (!cred) {
    return;
  }

  switch (cred.form) {
    case "inline": {
      // 明文（或带前缀/封装的简单情形）直接写入目标位置
      const value = renderTemplate(cred.valueTemplate, apiKey, config.name);
      setByPointer(tree, cred.targetPointer, value);
      return;
    }

    case "env": {
      injectEnvCredential(tree, cred, config, apiKey, deps);
      return;
    }

    case "secrets-file": {
      injectSecretsFileCredential(tree, cred, config, apiKey, deps);
      return;
    }

    default: {
      // 穷尽所有已知 form；新增形态需在此补充分支
      return assertNeverForm(cred.form);
    }
  }
}

/**
 * env 形态：先校验 envVarName，再「写引用占位 + 落明文」。
 *
 * - 缺 envVarName：抛 env-missing-var-name，且此时未做任何写入（不部分写入）。
 * - 占位：valueTemplate 渲染结果（{key} 不应出现在 env 模板里；即使出现也不写明文到 tree，
 *   因为我们对 env 形态在渲染占位时传入空 apiKey，确保 tree 中绝不含明文）。
 * - 明文：仅经 writeEnv 落到环境变量目标；writeEnv 失败包装为 credential-target-write-failed。
 */
function injectEnvCredential(
  tree: Record<string, Json>,
  cred: CredentialMapping,
  config: ProviderConfig,
  apiKey: string,
  deps: InjectCredentialDeps,
): void {
  // 先校验：缺少 envVarName 立即终止，尚未执行任何写入
  if (!cred.envVarName || cred.envVarName === "") {
    throw new RenderError(
      "env-missing-var-name",
      `凭据形态为 env，但未声明 envVarName（targetPointer=${cred.targetPointer}）`,
    );
  }

  // 渲染写入配置文件的引用占位：对 env 形态刻意传入空 apiKey，确保占位不含明文；
  // 模板中的 {env:VAR}/${VAR} 等引用写法与 {providerName} 会被保留/展开。
  const ref = renderTemplate(cred.valueTemplate, "", config.name);
  setByPointer(tree, cred.targetPointer, ref);

  // 明文落到环境变量目标；失败包装为结构化错误供上层回滚
  const writeEnv = deps.writeEnv ?? defaultWriteEnv;
  try {
    writeEnv(cred.envVarName, apiKey);
  } catch (err) {
    throw new RenderError(
      "credential-target-write-failed",
      `凭据引用目标写入失败（env 变量 ${cred.envVarName}）：${describeError(err)}`,
      err,
    );
  }
}

/**
 * secrets-file 形态：先校验 secretsFile（路径 + 条目），再「写引用占位 + 落明文」。
 *
 * - 缺路径或条目：抛 secrets-file-missing-target，且此时未做任何写入（不部分写入）。
 * - 占位：valueTemplate 渲染结果（同样对 secrets 形态传入空 apiKey，确保 tree 不含明文）。
 * - 明文：仅经 writeSecretsFile 落到独立 secrets 文件；失败包装为 credential-target-write-failed。
 *
 * 注：secretsFile.path 可能含平台变量（~、%APPDATA% 等）。按设计应由 PathResolver 解析，
 * 但 render 层不持有 PlatformContext；此处将「路径解析」交给可注入的 writeSecretsFile 依赖
 * （或调用方在构造 mapping 时传入已解析的绝对路径），保持本纯函数不依赖运行平台。
 */
function injectSecretsFileCredential(
  tree: Record<string, Json>,
  cred: CredentialMapping,
  config: ProviderConfig,
  apiKey: string,
  deps: InjectCredentialDeps,
): void {
  // 先校验：缺少 secretsFile 路径或条目立即终止，尚未执行任何写入
  const secretsFile = cred.secretsFile;
  if (!secretsFile || !secretsFile.path || secretsFile.path === "" || !secretsFile.entryKey || secretsFile.entryKey === "") {
    throw new RenderError(
      "secrets-file-missing-target",
      `凭据形态为 secrets-file，但未声明 secretsFile 的 path 或 entryKey（targetPointer=${cred.targetPointer}）`,
    );
  }

  // 渲染写入配置文件的引用占位：对 secrets 形态同样传入空 apiKey，确保占位不含明文
  const ref = renderTemplate(cred.valueTemplate, "", config.name);
  setByPointer(tree, cred.targetPointer, ref);

  // 明文落到独立 secrets 文件；失败包装为结构化错误供上层回滚
  const writeSecretsFile = deps.writeSecretsFile ?? defaultWriteSecretsFile;
  try {
    writeSecretsFile(secretsFile.path, secretsFile.entryKey, apiKey);
  } catch (err) {
    throw new RenderError(
      "credential-target-write-failed",
      `凭据引用目标写入失败（secrets 文件 ${secretsFile.path}#${secretsFile.entryKey}）：${describeError(err)}`,
      err,
    );
  }
}

/** 穷尽性校验：出现未知 CredentialForm 时在运行时明确报错 */
function assertNeverForm(form: never): never {
  throw new Error(`不支持的凭据形态（form）：${String(form)}`);
}

/** 把未知错误对象转为可读字符串，避免在消息中泄露意外结构 */
function describeError(err: unknown): string {
  if (err instanceof Error) {
    return err.message;
  }
  return String(err);
}

// ===========================================================================
// 默认（生产）实现：writeEnv / writeSecretsFile
// ===========================================================================

/**
 * 默认 writeEnv：把明文写入当前进程的 process.env。
 *
 * 作为最小可用的生产实现，供同进程内后续读取 / 由该 agent 子进程继承；
 * 若需要落到某 agent 的 .env 文件，可在适配器层注入对应的 writeEnv 实现替换本默认行为。
 */
export const defaultWriteEnv: WriteEnv = (varName, value) => {
  process.env[varName] = value;
};

/**
 * 默认 writeSecretsFile：把明文以 JSON 形态合并写入独立 secrets 文件的 entryKey 条目。
 *
 * - 若文件已存在且为合法 JSON 对象，则读入后仅更新/新增 entryKey，保留其它条目；
 * - 否则以 { [entryKey]: value } 新建；
 * - 写入采用同步 I/O（render 为同步纯逻辑路径），失败向上抛出由调用方包装处理。
 *
 * 该默认实现会真实写盘；测试应注入内存实现以避免触碰真实文件系统。
 */
export const defaultWriteSecretsFile: WriteSecretsFile = (path, entryKey, value) => {
  // 使用顶部静态引入的 node:fs（纯模块，无副作用），符合项目 ESM/TS 规范
  let current: Record<string, unknown> = {};
  if (fs.existsSync(path)) {
    try {
      const raw = fs.readFileSync(path, "utf8");
      const parsed = JSON.parse(raw) as unknown;
      if (parsed !== null && typeof parsed === "object" && !Array.isArray(parsed)) {
        current = parsed as Record<string, unknown>;
      }
    } catch {
      // 既有文件非合法 JSON 对象：以新对象覆盖（仅写入本条目），避免解析失败阻断凭据落地
      current = {};
    }
  }
  current[entryKey] = value;
  fs.writeFileSync(path, JSON.stringify(current, null, 2), "utf8");
};

// ===========================================================================
// 测试友好：内存版依赖与空 transform 注册表工厂
// ===========================================================================

/**
 * 创建内存版 writeEnv：把写入记录到返回的 store（Map）中，不触碰真实环境。
 * 供单测 / 属性测试注入，断言「明文是否经 writeEnv 落到了声明的 envVarName」。
 */
export function createInMemoryWriteEnv(): { writeEnv: WriteEnv; store: Map<string, string> } {
  const store = new Map<string, string>();
  const writeEnv: WriteEnv = (varName, value) => {
    store.set(varName, value);
  };
  return { writeEnv, store };
}

/**
 * 创建内存版 writeSecretsFile：把写入记录到返回的 store（path → (entryKey → value)）中，
 * 不触碰真实文件系统。供单测 / 属性测试注入断言。
 */
export function createInMemoryWriteSecretsFile(): {
  writeSecretsFile: WriteSecretsFile;
  store: Map<string, Map<string, string>>;
} {
  const store = new Map<string, Map<string, string>>();
  const writeSecretsFile: WriteSecretsFile = (path, entryKey, value) => {
    const entries = store.get(path) ?? new Map<string, string>();
    entries.set(entryKey, value);
    store.set(path, entries);
  };
  return { writeSecretsFile, store };
}

/**
 * 基于普通对象创建一个最简 TransformResolver。
 *
 * @param hooks 钩子名 → TransformHook 的映射表
 * @returns 一个按名解析钩子的解析器（解析不到返回 undefined）
 */
export function createTransformResolver(hooks: Record<string, TransformHook>): TransformResolver {
  return {
    resolve(name: string): TransformHook | undefined {
      return Object.prototype.hasOwnProperty.call(hooks, name) ? hooks[name] : undefined;
    },
  };
}
