// Agent 适配器抽象基类（AgentAdapter / BaseAdapter）
//
// 本模块定义所有 Agent 适配器统一实现的 AgentAdapter 接口（参照 design.md 组件 2），
// 并提供一个数据驱动的抽象基类 BaseAdapter，把「探测安装 / 解析配置路径 / 渲染合并 /
// 原子写入」四类通用流程集中实现一次，供 opencode、pi、workbuddy、codebuddy 等具体
// 适配器复用。具体适配器只需向基类声明「每 agent 的差异」——即 id、displayName、
// 配置文件路径模板与 FormatMapping——通用流程无需逐个重写（对应需求 8.1 / 8.2 / 9.1）。
//
// 设计要点：
//   1. 数据驱动：字段/凭据映射全部由注入的 FormatMapping 描述，key 的 agent 差异一律在
//      render 阶段经 injectCredential 转换，绝不污染供应商中立的 ProviderConfig（需求 9.1）。
//   2. 通用流程复用任务 3 的纯函数：
//      - configPath 复用 pathResolver.resolve 展开平台变量并归一化为绝对路径；
//      - render 直接复用 core/render 的 render（内部已含 setByPointer 合并 + injectCredential 凭据注入）；
//      - detect 用 configPath 解析路径并判断文件是否存在（文件存在性检查经可注入的 fs，便于测试）；
//      - apply 用 AtomicFileWriter 完成「备份 → 原子写入 → 失败回滚」。
//   3. 扩展隔离（需求 8.2 / Property 5）：基类实例彼此独立、不共享可变状态，新增一个适配器
//      不会改变其它已注册适配器的行为。
//
// 本模块不触达真实密钥；明文 apiKey 仅由调用方（Distributor）在内存中传入 render。

import type {
  ApplyEntry,
  DetectResult,
  FormatMapping,
  PlatformContext,
  ProviderConfig,
  RenderResult,
} from "@shared/types";
import { resolve as resolvePath } from "../core/pathResolver";
import { render as renderConfig, type RenderDeps } from "../core/render";
import type { AtomicFileWriter } from "../services/atomicFileWriter";

/**
 * Agent 适配器统一接口：每个受支持的 agent 实现一份（参照 design.md 组件 2）。
 *
 * 四类能力——detect（探测安装与配置文件状态）、configPath（解析当前平台配置文件绝对路径）、
 * render（字段级合并 + 凭据适配，不写盘）、apply（经 AtomicFileWriter 落盘）——构成一次
 * 分发对单个 agent 的全部交互面。密钥适配是 render 的固有职责：各 agent 对 key 的字段名/
 * 位置/引用形式差异在 render 内转换，不污染供应商中立的 ProviderConfig。
 */
export interface AgentAdapter {
  /** agent 唯一标识，如 "opencode" / "pi" / "workbuddy" / "codebuddy" */
  readonly id: string;
  /** 展示名称，用于 UI */
  readonly displayName: string;

  /**
   * 探测该 agent 是否安装、配置文件在哪、文件是否已存在。
   * @param platform 当前运行平台信息（注入而非全局读取，便于测试）
   */
  detect(platform: PlatformContext): Promise<DetectResult>;

  /**
   * 返回该 agent 在当前平台的配置文件绝对路径
   * （内部经 PathResolver 展开 ~、%APPDATA%、$XDG_CONFIG_HOME 等）。
   */
  configPath(platform: PlatformContext): string;

  /**
   * 渲染：把统一 ProviderConfig 映射为该 agent 的配置内容，与既有文件做字段级合并，
   * 但不写入磁盘。key 的 agent 差异在此经 FormatMapping.credential 转换。
   * @param config          供应商中立的 Provider 配置（仅含中立 apiKeyRef）
   * @param apiKey          解析出的明文密钥（仅内存传递；本地/无鉴权可为空串）
   * @param existingContent 既有配置文件原始文本（不存在则为 null）
   */
  render(config: ProviderConfig, apiKey: string, existingContent: string | null): RenderResult;

  /**
   * 应用：把 render 产出的内容经 AtomicFileWriter 写入磁盘（含备份与失败回滚）。
   * 通常由 Distributor 调用而非适配器自行写。
   */
  apply(
    configPath: string,
    renderResult: RenderResult,
    writer: AtomicFileWriter,
  ): Promise<ApplyEntry>;
}

/**
 * 每个 agent 的声明：构造基类所需的全部差异化输入。
 *
 * 具体适配器（9.2 实现）各提供一份本结构即可获得完整的 detect/configPath/render/apply 行为，
 * 无需重写通用流程。
 */
export interface AdapterDeclaration {
  /** agent 唯一标识 */
  id: string;
  /** 展示名称（UI 用） */
  displayName: string;
  /**
   * 配置文件路径模板（可含平台变量 ~、%APPDATA%、$XDG_CONFIG_HOME、${VAR} 等）。
   * 由基类经 PathResolver.resolve 按当前平台展开为绝对路径。
   *
   * 既可是单一字符串（三平台通用，适用于在所有平台都落在 home 下同一相对位置的 agent，
   * 如 opencode 的 ~/.config/opencode、pi 的 ~/.pi/agent、codebuddy 的 ~/.codebuddy），
   * 也可是按平台拆分的映射（适用于真正遵循各平台配置目录约定、三平台位置不同的 agent）。
   */
  configPathTemplate: PlatformPathTemplate;
  /** 该 agent 的格式映射（format / fieldPaths / managedPaths / credential / transform） */
  mapping: FormatMapping;
  /**
   * CLI 安装探测命令：声明用于判断该 agent 是否安装、并读取版本号的命令行。
   *
   * 典型形如 `{ command: "opencode", args: ["--version"] }`：命令成功退出（exit 0）即视为
   * 「已安装」，并从其 stdout/stderr 文本中解析出版本号。声明为可选——未声明时退回到
   * 「配置文件是否存在」的旧探测方式（仅作兜底，不推荐长期依赖）。
   *
   * 之所以用命令探测取代「看配置文件是否存在」：agent 装好后未必已经生成配置文件，
   * 「有没有装」与「有没有写过配置」是两件事，用 CLI 判定安装更准确（需求见本次变更）。
   */
  detectCommand?: DetectCommand;
  /**
   * 文件探测（用于「桌面应用」类 agent，如 WorkBuddy——它是 Electron 应用而非 CLI，
   * 没有 `xxx --version` 命令，无法用 detectCommand 探测）。
   *
   * 声明一个随安装落盘的标志文件（如安装目录下的 install-manifest.json / 可执行文件）：
   * 该文件存在即判定「已安装」，并可从该文件内容中抽取应用版本号。
   *
   * 当同时声明了 detectCommand 时，优先走命令探测；两者都未声明时退回「配置文件存在」兜底。
   */
  detectFile?: DetectFile;
}

/**
 * 配置文件路径模板：可为三平台通用的单一字符串，或按平台分别声明的映射。
 *
 * - 字符串形态：三平台使用同一模板（经 PathResolver 展开 ~ 与平台变量）。多数 CLI agent
 *   （opencode / pi / codebuddy 等）在所有平台都把配置放在 home 下的固定目录，用此形态即可。
 * - 映射形态：当某 agent 在 win/mac/linux 的配置目录确实不同（例如遵循 mac 的
 *   ~/Library/Application Support 约定）时，按平台分别给出模板。
 */
export type PlatformPathTemplate =
  | string
  | {
      /** Windows 下的路径模板 */
      win32: string;
      /** macOS 下的路径模板 */
      darwin: string;
      /** Linux 下的路径模板 */
      linux: string;
    };

/**
 * CLI 安装探测命令声明。
 *
 * 由基类 detect 执行：以 command + args 调起 agent 的 CLI（通常是版本子命令），
 * 命令成功退出即判定已安装，并从输出里用 versionPattern 抽取版本号。
 */
export interface DetectCommand {
  /** 可执行文件名或命令（如 "opencode"、"pi"、"codebuddy"）；由 PATH 解析定位 */
  command: string;
  /** 命令参数（如 ["--version"]）；缺省为空数组 */
  args?: string[];
  /**
   * 从命令输出（stdout + stderr 合并文本）中抽取版本号的正则；需含一个捕获组。
   * 缺省使用通用语义化版本匹配（如 1.2.3 / 0.3.12-beta.1）。
   */
  versionPattern?: RegExp;
}

/**
 * 文件探测声明：以某个「随安装存在」的文件判定安装，并从中读取版本。
 *
 * 面向桌面应用类 agent（无 CLI 版本命令）：路径按平台声明（安装目录三平台不同），
 * 文件存在即「已安装」；版本可从 JSON 字段或正则抽取。
 */
export interface DetectFile {
  /**
   * 标志文件路径模板（按平台声明或三平台通用）。可含 ~、%LOCALAPPDATA%、${VAR} 等变量，
   * 由 PathResolver 按当前平台展开为绝对路径。文件存在即判定该 agent 已安装。
   */
  pathTemplate: PlatformPathTemplate;
  /**
   * 版本抽取方式（可选）：
   * - { jsonField: "appVersion" }：把文件按 JSON 解析并取该顶层字段作为版本号；
   * - { pattern: /.../ }：对文件文本用正则抽取（需含一个捕获组）。
   * 省略时表示「仅判定安装、不读版本」。
   */
  version?: { jsonField: string } | { pattern: RegExp };
}

/**
 * 文件存在性检查的可注入依赖。
 *
 * detect 需要判断配置文件是否已存在。为便于测试（不触碰真实文件系统），把这一步抽象为
 * 可注入接口：生产默认实现基于 node fs/promises 的 access；测试可注入内存版。
 */
export interface FileExistsChecker {
  /**
   * 判断给定绝对路径的文件是否存在。
   * @param absolutePath 已解析的配置文件绝对路径
   * @returns 存在返回 true，否则 false
   */
  (absolutePath: string): Promise<boolean>;
}

/**
 * 命令执行结果：供 detect 判定安装与解析版本。
 */
export interface CommandResult {
  /** 命令是否成功执行并以 0 退出（找不到可执行文件/非零退出均为 false） */
  ok: boolean;
  /** 合并后的命令输出文本（stdout + stderr），供版本号解析 */
  output: string;
}

/**
 * CLI 命令执行器的可注入依赖。
 *
 * detect 需要调起 agent 的 CLI 判定安装与版本。为便于测试（不实际 spawn 子进程），
 * 把这一步抽象为可注入接口：生产默认实现基于 node child_process；测试可注入内存桩。
 */
export interface CommandRunner {
  /**
   * 执行一条命令并返回结果。
   * @param command 可执行文件名/命令
   * @param args    参数列表
   * @returns 执行结果（是否成功 + 合并输出）；绝不抛错，失败以 ok=false 表达
   */
  (command: string, args: string[]): Promise<CommandResult>;
}

/**
 * 文本文件读取器的可注入依赖（供 detectFile 读取标志文件内容以抽取版本）。
 *
 * 读取失败（文件不存在/无权限等）一律返回 null，不抛错，便于上层以「读不到即无版本」处理。
 */
export interface FileReader {
  /**
   * 读取给定绝对路径的文本内容。
   * @param absolutePath 已解析的文件绝对路径
   * @returns 文件文本；读取失败返回 null
   */
  (absolutePath: string): Promise<string | null>;
}

/**
 * 基类可注入依赖集合（全部可选，保持与生产默认实现向后兼容）。
 */
export interface BaseAdapterDeps {
  /** 文件存在性检查；缺省基于 node fs/promises 的 access */
  fileExists?: FileExistsChecker;
  /** CLI 命令执行器；缺省基于 node child_process 的 execFile */
  runCommand?: CommandRunner;
  /** 文本文件读取器（用于 detectFile 读版本）；缺省基于 node fs/promises 的 readFile */
  readFile?: FileReader;
  /**
   * render 的可注入依赖（凭据 env/secrets-file 落地与 transform 钩子解析器）；
   * 透传给 core/render 的 render。
   */
  renderDeps?: RenderDeps;
}

/**
 * 默认文件存在性检查：基于 node fs/promises 的 access 判断文件是否可访问。
 *
 * 延迟到调用时再引入 node:fs/promises，避免在不需要探测的路径上产生依赖。
 */
const defaultFileExists: FileExistsChecker = async (absolutePath: string): Promise<boolean> => {
  const { access } = await import("node:fs/promises");
  try {
    await access(absolutePath);
    return true;
  } catch {
    // access 抛错即表示不可访问（最常见为不存在）；视为文件不存在
    return false;
  }
};

/**
 * 通用语义化版本匹配：从命令输出中抽取形如 1.2.3 / 0.3.12-beta.1 的版本号。
 * 作为 DetectCommand.versionPattern 的缺省值。
 */
const DEFAULT_VERSION_PATTERN = /(\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?)/;

/**
 * 默认 CLI 命令执行器：基于 node child_process 的 execFile 调起命令。
 *
 * - 以 shell=false 直接执行可执行文件，避免 shell 注入；参数以数组传入由系统转义。
 * - 命令不存在（ENOENT）、非零退出、超时等一律归为 ok=false（不抛错），上层据此判「未安装」。
 * - 设置较短超时，避免个别 CLI 阻塞探测流程；同时合并 stdout/stderr 供版本号解析
 *   （部分 CLI 把版本打到 stderr）。
 *
 * Windows 兼容：agent 常以 .cmd/.ps1 批处理分发（如 npm 全局 bin），execFile 默认不经 shell
 * 无法直接执行 .cmd，故在 win32 下用 shell 执行以覆盖这类情形。
 */
const defaultRunCommand: CommandRunner = async (
  command: string,
  args: string[],
): Promise<CommandResult> => {
  const { execFile } = await import("node:child_process");
  const { promisify } = await import("node:util");
  const run = promisify(execFile);
  try {
    const { stdout, stderr } = await run(command, args, {
      // 给 agent CLI 留出较宽裕的启动时间但不无限等待：部分 CLI 的版本命令启动较慢
      // （实测 codebuddy --version 可达十余秒），超时过紧会把已安装的 agent 误判为未安装。
      timeout: 20000,
      // Windows 下 agent 多为 .cmd 包装脚本，需经 shell 才能解析 PATHEXT 并执行
      shell: process.platform === "win32",
      windowsHide: true,
      // 版本输出通常很小；限制缓冲以防异常 CLI 刷屏
      maxBuffer: 1024 * 1024,
    });
    return { ok: true, output: `${stdout ?? ""}\n${stderr ?? ""}` };
  } catch (error) {
    // 命令不存在/非零退出/超时等：视为未安装或不可用。
    // 某些 CLI 对 --version 仍以非零码退出但已打印版本，这里仍回收其输出以便尽力解析。
    const err = error as { stdout?: string; stderr?: string };
    const output = `${err.stdout ?? ""}\n${err.stderr ?? ""}`.trim();
    return { ok: false, output };
  }
};

/**
 * 默认文本文件读取器：基于 node fs/promises 的 readFile（utf-8）。
 * 读取失败（不存在/无权限等）返回 null，不抛错。
 */
const defaultReadFile: FileReader = async (absolutePath: string): Promise<string | null> => {
  const { readFile } = await import("node:fs/promises");
  try {
    return await readFile(absolutePath, "utf-8");
  } catch {
    return null;
  }
};

/**
 * 数据驱动的 Agent 适配器抽象基类。
 *
 * 读取一份 AdapterDeclaration（每 agent 的差异），实现统一的 detect/configPath/render/apply。
 * 具体适配器通过继承本基类并传入各自声明即可，无需重写通用流程（对应需求 8.1 / 8.2 / 9.1）。
 *
 * 为保证扩展隔离（Property 5）：基类不持有任何跨实例的可变全局状态，每个适配器实例的行为
 * 只取决于自身声明与调用入参，新增/修改某个适配器不影响其它适配器。
 */
export abstract class BaseAdapter implements AgentAdapter {
  /** agent 唯一标识 */
  readonly id: string;
  /** 展示名称 */
  readonly displayName: string;

  /** 该 agent 的差异化声明（配置路径模板与格式映射等） */
  protected readonly declaration: AdapterDeclaration;
  /** 可注入依赖（文件存在性检查、render 依赖） */
  protected readonly deps: BaseAdapterDeps;

  /**
   * @param declaration 每 agent 的声明（id/displayName/配置路径模板/FormatMapping）
   * @param deps        可注入依赖；缺省使用生产默认实现
   */
  constructor(declaration: AdapterDeclaration, deps: BaseAdapterDeps = {}) {
    this.declaration = declaration;
    this.deps = deps;
    this.id = declaration.id;
    this.displayName = declaration.displayName;
  }

  /**
   * 返回该 agent 在当前平台的配置文件绝对路径。
   *
   * 复用 PathResolver.resolve 展开路径模板中的平台变量（~、%APPDATA%、$XDG_CONFIG_HOME 等）
   * 并归一化为绝对路径（对应需求 12.1 / 12.2）。
   *
   * @param platform 当前运行平台上下文
   * @returns 解析后的配置文件绝对路径
   */
  configPath(platform: PlatformContext): string {
    const template = this.declaration.configPathTemplate;
    // 按平台选中模板：字符串形态三平台通用；映射形态取当前平台对应项
    const selected = typeof template === "string" ? template : template[platform.os];
    return resolvePath(selected, platform);
  }

  /**
   * 探测该 agent 的安装与配置文件状态。
   *
   * 安装判定（本次变更的核心）：优先调用声明的 detectCommand（agent 的 CLI 版本命令）判断
   * 是否安装——命令成功退出即「已安装」，并从输出解析版本号。这样「装了但还没写过配置文件」
   * 的 agent 也能被正确识别为已安装，而不再依赖配置文件是否存在。
   *
   * 桌面应用判定：未声明 detectCommand 但声明了 detectFile 时（如 WorkBuddy 这类 Electron
   * 应用无 CLI 版本命令），以「安装标志文件是否存在」判定安装，并从该文件内容抽取版本。
   *
   * 兼容兜底：detectCommand 与 detectFile 都未声明时，退回旧逻辑「配置文件存在 ⇒ 已安装」。
   *
   * 无论安装判定走哪条路径，都会独立解析配置文件绝对路径并判断其是否存在（fileExists），
   * 供上层区分「已安装·已有配置」与「已安装·将创建配置」。
   *
   * @param platform 当前运行平台上下文
   * @returns DetectResult：installed / configPath / fileExists / version
   */
  async detect(platform: PlatformContext): Promise<DetectResult> {
    const configPath = this.configPath(platform);
    const fileExistsFn = this.deps.fileExists ?? defaultFileExists;
    const fileExists = await fileExistsFn(configPath);

    // 声明了 CLI 探测命令：以命令结果判定安装与版本（优先，适用于 CLI 类 agent）
    const detectCommand = this.declaration.detectCommand;
    if (detectCommand) {
      const runCommand = this.deps.runCommand ?? defaultRunCommand;
      const result = await runCommand(detectCommand.command, detectCommand.args ?? []);
      if (result.ok) {
        return {
          installed: true,
          configPath,
          fileExists,
          version: extractVersion(result.output, detectCommand.versionPattern),
        };
      }
      // 命令失败（找不到可执行文件/非零退出）：判为未安装，忽略配置文件存在与否
      return { installed: false, configPath, fileExists };
    }

    // 声明了文件探测：以安装标志文件是否存在判定安装（适用于桌面应用类 agent）
    const detectFile = this.declaration.detectFile;
    if (detectFile) {
      const markerPath = resolvePath(
        typeof detectFile.pathTemplate === "string"
          ? detectFile.pathTemplate
          : detectFile.pathTemplate[platform.os],
        platform,
      );
      const readFileFn = this.deps.readFile ?? defaultReadFile;
      const content = await readFileFn(markerPath);
      if (content === null) {
        // 标志文件读不到：视为未安装
        return { installed: false, configPath, fileExists };
      }
      return {
        installed: true,
        configPath,
        fileExists,
        version: extractFileVersion(content, detectFile.version),
      };
    }

    // 未声明命令：兜底回到「配置文件存在 ⇒ 已安装」
    return { installed: fileExists, configPath, fileExists };
  }

  /**
   * 渲染：把中立 ProviderConfig 与既有配置做字段级合并，并完成凭据适配，不写盘。
   *
   * 直接复用 core/render 的 render：内部按 FormatMapping 的 managedPaths 写入受管字段、
   * 保留非受管字段，并经 injectCredential 按 credential 声明把 key 适配成该 agent 要求的
   * 字段名/位置/引用形式（key 差异不污染 ProviderConfig，对应需求 9.1）。可注入的 renderDeps
   * 透传凭据落地（writeEnv/writeSecretsFile）与 transform 钩子解析器。
   *
   * @param config          供应商中立的 Provider 配置
   * @param apiKey          明文密钥（本地/无鉴权可为空串）
   * @param existingContent 既有配置文件文本（不存在传 null）
   * @returns RenderResult：mergedContent + maskedDiff（不含明文）
   */
  render(config: ProviderConfig, apiKey: string, existingContent: string | null): RenderResult {
    return renderConfig(
      config,
      apiKey,
      existingContent,
      this.declaration.mapping,
      this.deps.renderDeps ?? {},
    );
  }

  /**
   * 应用：把 render 产出的 mergedContent 经 AtomicFileWriter 安全写入磁盘。
   *
   * 流程（对应需求 10.2 / 10.3）：
   *   1. backup：写入前对目标文件创建带时间戳的备份（文件不存在返回 null）；
   *   2. atomicWrite：临时文件 + 原子 rename 覆盖目标；
   *   3. 失败回滚：若写入抛错，有备份则 restore 回旧内容，无备份（分发前不存在文件）则删除
   *      新写入的半成品文件，使目标恢复「不存在」状态，不留半写文件。
   *
   * 返回的 ApplyEntry 仅记录本 agent 的结果；基类不吞错也不越权判定 skipped（未安装的跳过
   * 由上层 Distributor 在 detect 后决定）。
   *
   * @param configPath   目标配置文件绝对路径（通常来自 detect/configPath）
   * @param renderResult render 产出的合并内容
   * @param writer       安全文件写入器（含备份/原子写/回滚）
   * @returns ApplyEntry：status=success 并带 backupPath；失败则 status=failed 并带错误信息
   */
  async apply(
    configPath: string,
    renderResult: RenderResult,
    writer: AtomicFileWriter,
  ): Promise<ApplyEntry> {
    // 1. 先备份：文件不存在返回 null，记录「分发前无文件」以便失败时按「删除」回滚
    const backupPath = await writer.backup(configPath);

    try {
      // 2. 原子写入合并后的完整内容
      await writer.atomicWrite(configPath, renderResult.mergedContent);
      return {
        agentId: this.id,
        status: "success",
        // 有备份（原文件存在）时记录备份路径，供回溯/手动回滚
        backupPath: backupPath ?? undefined,
      };
    } catch (error) {
      // 3. 写入失败：回滚该 agent 的局部改动，保证不留半写文件（需求 10.3）
      await this.rollback(configPath, backupPath);
      return {
        agentId: this.id,
        status: "failed",
        message: describeError(error),
      };
    }
  }

  /**
   * 写入失败时的回滚：有备份则从备份恢复旧内容；无备份（分发前不存在）则删除新写入文件。
   *
   * 回滚本身的失败不应掩盖原始写入错误，故对回滚中的异常做静默处理（尽力而为）。
   *
   * @param configPath 目标配置文件绝对路径
   * @param backupPath backup 返回的备份路径；null 表示分发前目标文件不存在
   */
  private async rollback(configPath: string, backupPath: string | null): Promise<void> {
    try {
      if (backupPath !== null) {
        // 原文件存在过：用备份覆盖回旧内容
        const { atomicFileWriter } = await import("../services/atomicFileWriter");
        await atomicFileWriter.restore(backupPath, configPath);
      } else {
        // 原文件不存在：删除可能已产生的半成品文件，使目标恢复「不存在」状态
        const { unlink } = await import("node:fs/promises");
        await unlink(configPath).catch(() => {
          // 文件不存在或无法删除时静默忽略：目标已是「不存在」即达成回滚目标
        });
      }
    } catch {
      // 回滚失败不覆盖原始错误；上层已据 ApplyEntry.status=failed 感知本次失败
    }
  }
}

/**
 * 把未知错误对象转为可读字符串，避免在消息中泄露意外结构或明文。
 *
 * @param error 捕获到的异常
 * @returns 可读的错误描述
 */
function describeError(error: unknown): string {
  if (error instanceof Error) {
    return error.message;
  }
  return String(error);
}

/**
 * 从 CLI 输出文本中抽取版本号。
 *
 * 用给定（或默认的语义化版本）正则在输出里匹配第一个版本号；匹配不到返回 undefined，
 * 调用方据此表示「已安装但未能读出版本」。
 *
 * @param output  命令合并输出（stdout + stderr）
 * @param pattern 版本抽取正则（需含一个捕获组）；缺省用通用语义化版本匹配
 * @returns 解析出的版本号；无法解析时 undefined
 */
function extractVersion(output: string, pattern?: RegExp): string | undefined {
  const match = output.match(pattern ?? DEFAULT_VERSION_PATTERN);
  return match?.[1]?.trim() || undefined;
}

/**
 * 从标志文件内容中抽取版本号（供 detectFile 使用）。
 *
 * - 未声明抽取方式：返回 undefined（仅判定安装，不读版本）。
 * - jsonField：把内容按 JSON 解析并取该顶层字段（如 WorkBuddy install-manifest.json 的
 *   appVersion）；解析失败或字段非字符串时返回 undefined。
 * - pattern：对文件文本用正则抽取第一个捕获组。
 *
 * @param content 标志文件文本内容
 * @param spec    版本抽取方式声明
 * @returns 解析出的版本号；无法解析时 undefined
 */
function extractFileVersion(
  content: string,
  spec?: { jsonField: string } | { pattern: RegExp },
): string | undefined {
  if (!spec) {
    return undefined;
  }
  if ("jsonField" in spec) {
    try {
      const parsed = JSON.parse(content) as Record<string, unknown>;
      const value = parsed[spec.jsonField];
      return typeof value === "string" && value.trim() ? value.trim() : undefined;
    } catch {
      // JSON 解析失败：读不出版本，返回 undefined（不影响已判定的安装状态）
      return undefined;
    }
  }
  return extractVersion(content, spec.pattern);
}
