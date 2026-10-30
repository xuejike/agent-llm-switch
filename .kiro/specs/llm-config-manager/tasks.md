# Implementation Plan: LLM 配置管理器（llm-config-manager）

## Overview

本实现计划把设计文档转化为一系列可增量交付、测试驱动的编码任务。整体顺序为：先搭建 pnpm + Electron + React + TypeScript + Vite 工程骨架与安全的进程隔离，再自底向上落地核心类型与纯函数（配套 fast-check 属性测试），随后构建主进程服务（SecretStore、ConfigStore、AtomicFileWriter、ModelDiscovery、适配器与分发编排器），接着打通 IPC 白名单边界与 React UI，最后以端到端集成测试与打包分发收口。每个任务都建立在前序任务之上，不留孤立代码。

技术栈约定（全程遵循）：
- 包管理器统一使用 **pnpm**（初始化、安装依赖、运行脚本、workspace 管理），不使用 npm/yarn。
- TypeScript + Electron + React，Vite 构建渲染进程；主进程/渲染进程分离，敏感操作全部在主进程；IPC 经 preload 的 contextBridge 白名单暴露。
- 测试：Vitest（测试运行器）+ fast-check（基于属性的测试），每个属性测试至少运行 100 次迭代并引用对应 Property 编号。
- HTTP 发送抽象为可注入的 `httpSend`，SecretStore 提供可注入的内存实现，测试绝不访问真实外网与真实 OS 凭据库。

## Tasks

- [x] 1. 工程脚手架与安全进程隔离（pnpm + Electron + React + TS + Vite）
  - [x] 1.1 用 pnpm 初始化 monorepo 工程骨架
    - 执行 `pnpm init` 生成根 `package.json`；创建 `pnpm-workspace.yaml` 声明 `packages/*`（或 `src/main`、`src/renderer`、`src/shared` 分层）以分离主进程、渲染进程与共享类型
    - 创建目录结构：`src/main`（主进程）、`src/renderer`（React UI）、`src/preload`（预加载脚本）、`src/shared`（跨进程共享的 TS 类型）
    - 用 `pnpm add -D` 安装开发依赖：`typescript`、`electron`、`vite`、`@vitejs/plugin-react`、`electron-builder`、`vitest`、`fast-check`、`eslint` 与相应 React/TS 插件；用 `pnpm add` 安装运行依赖 `react`、`react-dom`、`antd`、`@ant-design/icons`
    - 配置根 `tsconfig.json`（strict 模式）与各子项目 `tsconfig`，`package.json` 的 scripts 全部用 pnpm 运行（`pnpm dev`、`pnpm build`、`pnpm test`、`pnpm lint`）
    - _Requirements: 14.1, 14.2, 14.3_

  - [x] 1.2 配置安全的 Electron 主进程与 BrowserWindow
    - 在 `src/main` 实现主进程入口，创建 `BrowserWindow` 时设置 `nodeIntegration: false`、`contextIsolation: true`、`sandbox: true`，并指定 preload 脚本
    - 搭建最小可启动的 Electron 外壳，加载 Vite 构建的渲染页面（开发态连 Vite dev server，生产态加载打包产物）
    - _Requirements: 3.1, 3.2, 14.1_

  - [x] 1.3 配置 Vite 渲染进程与最小 React 应用
    - 配置 `vite.config.ts` 使用 React 插件，输出到主进程可加载的目录
    - 实现最小 React 根组件（`App.tsx`）验证渲染进程可启动
    - 在应用根部用 antd 的 `ConfigProvider` + `theme`（design token：`colorPrimary` `'#1677ff'`、`borderRadius` `6`）包裹，建立全局 antd 主题；最小 React 根组件用一个 antd 组件（如 `Button`）验证 antd 正常工作
    - _Requirements: 14.1_

  - [x] 1.4 配置 Vitest + fast-check 与 lint
    - 配置 `vitest.config.ts`，约定测试文件位置与 node/jsdom 环境分区（主进程逻辑用 node，渲染组件用 jsdom）
    - 建立 fast-check 公共约定：导出共享的 `fc.assert` 运行配置，统一设置 `numRuns >= 100`，供所有属性测试引用
    - 配置 ESLint 规则并接入 `pnpm lint`
    - _Requirements: 14.3, 14.4_

- [x] 2. 核心数据模型与共享类型（src/shared）
  - [x] 2.1 定义全部核心 TypeScript 类型
    - 在 `src/shared/types.ts` 定义 `ProviderConfig`、`ProxyConfig`、`ModelInfo`、`ModelProbeResult`、`ModelAvailability`、`ModelSource`、`AgentState`、`PlatformContext`、`DetectResult`、`RenderResult`、`ApplyEntry`、`ApplyReport`、`PreviewResult`、`AppState`
    - 定义数据驱动声明类型：`ConfigFormat`、`FormatMapping`、`CredentialMapping`、`CredentialForm`、`AuthInjection`、`ModelListingConfig`、`ModelListingResponseMapping`、`ModelProbeConfig`、`ProbeOptions`、`FetchModelsResult`
    - 定义 IPC 契约接口 `IpcApi`
    - 确保 `ProviderConfig` 不含任何 agent 专属 key 字段（仅中立 `apiKeyRef`）
    - _Requirements: 1.1, 1.2, 9.1_

- [x] 3. 纯函数核心与属性测试（src/main/core，优先可单测）
  - [x] 3.1 实现 maskSecret 掩码函数
    - 在 `src/main/core/mask.ts` 实现 `maskSecret`：长度 >= 8 保留前 4 后 4、中段全部掩码；长度 < 8 返回等长全掩码串
    - _Requirements: 2.9, 2.10_

  - [x] 3.2 为 maskSecret 编写单元测试与属性测试
    - 单元测试覆盖空串、短串（<8）、长串（>=8）边界
    - **Property 1: 密钥不泄露**（基础部分）——随机 apiKey，断言掩码输出不含原始中段字符
    - **Validates: Requirements 2.9, 2.10 / Property 1**
    - _Requirements: 2.9, 2.10_

  - [x] 3.3 实现 validate 配置校验函数
    - 在 `src/main/core/validate.ts` 实现 `validate(config)`：校验 name（1-100 非空）、baseUrl（合法 http/https）、models（1-50 项）、timeoutMs（正整数），返回逐项错误
    - 实现放宽规则：`isLocal=true` 或 `auth.in="none"`/`kind="none"` 时 `apiKeyRef` 允许为空且不要求可解析
    - 校验 `candidateModels` 非空时 id 唯一
    - _Requirements: 1.5, 1.6, 1.7, 4.4_

  - [x] 3.4 为 validate 编写单元测试
    - 覆盖非法 baseUrl、空/超长 name、空/超限 models、非正 timeoutMs、本地无鉴权放宽、candidateModels id 重复等分支
    - _Requirements: 1.5, 1.6, 1.7, 4.4_

  - [x] 3.5 实现 setByPointer / getByPointer 指针读写
    - 在 `src/main/core/pointer.ts` 实现 `setByPointer(tree, pointer, value)`：创建沿途缺失中间对象，保持兄弟节点不变；实现 `getByPointer` 用于读取数组指针
    - _Requirements: 10.6_

  - [x] 3.6 为 setByPointer 编写单元测试与属性测试
    - 单元测试覆盖深层创建、兄弟保留、数组定位
    - **Property 2（支撑）: 兄弟节点保持不变**——随机树与随机指针/值，断言 set 后不属于该路径的兄弟节点不变
    - **Validates: Requirements 10.6 / Property 2**
    - _Requirements: 10.6_

  - [x] 3.7 实现 PathResolver 跨平台路径解析
    - 在 `src/main/core/pathResolver.ts` 实现 `resolve(template, platform)` 与 `configHome(platform)`：展开 `~`、`%APPDATA%`、`$XDG_CONFIG_HOME` 等，按 win32/darwin/linux 返回约定配置根目录，归一化为绝对路径并做归属校验以防路径穿越
    - _Requirements: 12.1, 12.2, 12.3_

  - [x] 3.8 为 PathResolver 编写属性测试
    - **Property 6: 路径解析正确**——对 win32/darwin/linux 三平台的模拟 `PlatformContext`，断言 resolve/configHome 产出该平台约定的绝对路径且变量正确展开
    - **Validates: Requirements 12.1, 12.2 / Property 6**
    - _Requirements: 12.1, 12.2_

  - [x] 3.9 实现字段级合并 render 引擎
    - 在 `src/main/core/render.ts` 实现数据驱动的 `render(config, apiKey, existingContent, mapping)`：解析既有内容为树（按 format），仅对 `managedPaths` 写入中立字段值，保留非受管字段，序列化并生成掩码 diff（`maskedDiff` 不含明文）
    - 依赖 setByPointer 与 maskSecret；暂留 `injectCredential` 调用点待 3.11 接入
    - _Requirements: 10.1, 2.8_

  - [x] 3.10 为 render 编写单元测试与属性测试
    - 单元测试：给定含非 API 字段（主题、快捷键、MCP）的既有配置，断言非 managed 字段完整保留
    - **Property 2: 字段级合并保真**——随机既有配置树 + 随机 ProviderConfig，断言 render 后非 managedPaths 字段值不变
    - **Property 1: 密钥不泄露**——随机 apiKey，断言 maskedDiff 不含明文
    - **Validates: Requirements 10.1, 2.8 / Property 1, Property 2**
    - _Requirements: 10.1, 2.8_

  - [x] 3.11 实现 injectCredential 凭据适配引擎
    - 在 `src/main/core/injectCredential.ts` 实现数据驱动的 `injectCredential(tree, mapping, config, apiKey)`：按 `CredentialMapping.form` 分派——inline 写明文模板；env 写引用占位并经可注入的 `writeEnv` 落明文；secrets-file 写引用占位并经可注入的 `writeSecretsFile` 落明文
    - 处理边界：apiKey 空则跳过；env 缺 envVarName / secrets-file 缺 secretsFile 则终止并返回对应错误；无 credential 声明时向后兼容（沿用 fieldPaths 明文映射）
    - 将本引擎接入 3.9 的 render 流程，并实现 `transform` 钩子兜底（失败时终止 render、不产生部分写入、返回 transform 失败错误）
    - _Requirements: 9.1, 9.2, 9.3, 9.4, 9.5, 9.6, 9.7, 10.1_

  - [x] 3.12 为 injectCredential/render 编写凭据属性测试
    - **Property 14: key 适配收敛于适配器且转换后不泄露明文**——随机生成 inline/env/secrets-file × 不同 targetPointer/valueTemplate 的 CredentialMapping 与随机 apiKey，断言：(a) key 以声明的字段名/位置/引用形式出现在 mergedContent；(b) env/secrets 形态下 mergedContent 与 maskedDiff 均不含明文（只含引用占位）；(c) 回传对象序列化不含明文；(d) ProviderConfig 无 agent 专属 key 字段
    - **Validates: Requirements 9.1, 9.3, 9.4, 9.5, 9.7 / Property 14**
    - _Requirements: 9.1, 9.3, 9.4, 9.5, 9.7_

  - [x] 3.13 实现 injectAuth 鉴权注入分派
    - 在 `src/main/core/injectAuth.ts` 实现 `injectAuth(req, auth, apiKey)`：按 `auth.in`/`auth.kind` 分派——none 跳过注入；header/query/bearer 按模板注入 `{key}` 并附 extraHeaders；sigv4 委托专用签名适配器（接口占位，实现见任务 8）
    - _Requirements: 4.6, 7.3, 6.1_

  - [x] 3.14 为 injectAuth 编写单元测试
    - 覆盖 bearer header 注入、自定义 header（x-api-key）、query（?key=）、none 不注入任何鉴权头/查询、extraHeaders 附加
    - _Requirements: 4.6, 7.3_

- [x] 4. 检查点 - 确保纯函数核心测试全部通过
  - 运行 `pnpm test`，确保任务 1-3 的全部测试通过；如有疑问询问用户

- [x] 5. 主进程服务层（密钥、配置存储、原子写入）
  - [x] 5.1 实现 SecretStore 密钥服务
    - 在 `src/main/services/secretStore.ts` 实现 `SecretStore` 接口：`saveSecret`/`resolveSecret`/`deleteSecret`/`getMasked`，底层封装 Electron `safeStorage`（或可评估的 keytar）；提供可注入的内存实现供测试
    - 实现错误语义：写入失败返回存储失败错误；解析/删除未找到 keyRef 返回"不存在"错误而非空明文；`getMasked` 调用 maskSecret 且从不回传明文
    - _Requirements: 2.2, 2.3, 2.4, 2.5_

  - [x] 5.2 为 SecretStore 编写单元测试
    - 用内存实现覆盖保存/解析/删除/掩码、写入失败、keyRef 不存在、掩码不含明文
    - _Requirements: 2.3, 2.4, 2.5_

  - [x] 5.3 实现 ConfigStore 配置存储服务
    - 在 `src/main/services/configStore.ts` 实现 `loadAppState`/`saveAppState`：持久化 `AppState` 到应用自有数据目录，持久化内容不含明文密钥
    - 实现 I/O 失败时保留内存既有状态不变并返回持久化失败错误标识
    - _Requirements: 1.3, 1.4_

  - [x] 5.4 为 ConfigStore 编写单元测试
    - 覆盖 load/save 往返、持久化内容无明文、I/O 失败时状态不变并返回错误
    - _Requirements: 1.3, 1.4_

  - [x] 5.5 实现 AtomicFileWriter 安全文件写入
    - 在 `src/main/services/atomicFileWriter.ts` 实现 `backup`（带时间戳备份，文件不存在返回 null）、`atomicWrite`（临时文件 + 原子 rename）、`restore`（从备份回滚）
    - _Requirements: 10.2, 10.3_

  - [x] 5.6 为 AtomicFileWriter 编写单元测试与属性测试
    - 单元测试：备份文件名含时间戳；rename 失败触发回滚
    - **Property 3: 写入原子性/无损**——注入随机位置的写入失败，断言目标文件最终等于初始状态（旧内容或不存在），无半写文件
    - **Validates: Requirements 10.2, 10.3 / Property 3**
    - _Requirements: 10.2, 10.3_

- [x] 6. ModelDiscovery 模型发现与探测服务
  - [x] 6.1 实现可注入的 httpSend 抽象
    - 在 `src/main/services/http.ts` 封装基于 Node `fetch`/`undici` 的 `httpSend(req, { timeout })`，支持超时与代理注入；定义接口以便测试注入 mock，CI 禁止真实外网
    - _Requirements: 6.2, 7.2_

  - [x] 6.2 实现 fetchModels 模型拉取（数据驱动归一化）
    - 在 `src/main/services/modelDiscovery.ts` 实现 `fetchModels(provider)`：无 modelListing 返回 `supportsListing:false` 且不发请求；否则经 SecretStore 解析明文、injectAuth 注入、httpSend 只读 GET、用 responseMapping 归一化为 `ModelInfo[]`（source="fetched"、availability="unknown"、id 去重）
    - 错误处理：401/403 返回 supportsListing:true + 空清单 + 鉴权失败 warning；不可达/非成功状态/格式非预期返回带 warning 的结果而不抛出；无鉴权本地 provider 不解析密钥
    - _Requirements: 5.1, 5.2, 5.3, 5.4, 5.5, 5.6, 7.1, 7.2, 7.3, 13.2, 13.3_

  - [x] 6.3 实现 probeModel / probeModels 可用性探测（并发受限、单模型超时）
    - 在同模块实现 `probeModel`（最小代价真实调用判定 available/unavailable/unknown + 延迟 + statusCode + error）与 `probeModels`（并发上限工作池、预置槽位保证一一对应）
    - 判定规则：命中 availableStatuses → available + latencyMs；401/403 → unavailable + 鉴权失败；超时 → unavailable + "超时"；网络/解析异常 → unknown；本地连接被拒绝识别为连接错误而非鉴权失败
    - _Requirements: 6.1, 6.2, 6.3, 6.4, 6.5, 6.6, 6.7, 6.8, 7.1, 7.2, 7.3, 13.2, 13.3_

  - [x] 6.4 为 fetchModels 编写单元测试
    - 用 mock httpSend：无 modelListing 零调用；OpenAI 风格（/data[].id）与另一风格（/models[].name）归一化正确、去重；500/非 JSON/数组指针落空返回 warning 空清单不抛异常；401/403 warning 标注鉴权失败
    - _Requirements: 5.1, 5.2, 5.4, 5.5_

  - [x] 6.5 为 probeModels 编写单元测试与属性测试
    - 单元测试：2xx→available 含 latencyMs；401/403→unavailable 含状态码；超时→unavailable+"超时"；网络异常→unknown；用可计数 mock 断言并发不超过 concurrency；本地 ECONNREFUSED 识别为连接错误不提示鉴权
    - **Property 10: 探测结果与输入一一对应**——随机 modelIds 与随机 mock 响应，断言结果与输入按下标一一对应、长度相等
    - **Validates: Requirements 6.7 / Property 10**
    - _Requirements: 6.1, 6.3, 6.4, 6.5, 6.6, 6.7, 13.2_

  - [x] 6.6 为发现与探测编写密钥不泄露与只读属性测试
    - **Property 8: 发现与探测过程不泄露明文密钥**——随机 apiKey + 随机模型集合，mock HTTP，断言 fetchModels/probeModels 回传对象序列化后均不含明文
    - **Property 9: 探测只读、无配置副作用**——临时目录放置各 agent 配置与 AppState 快照，随机执行 fetch/probe（mock 远端），断言本地文件内容前后不变且 mock 仅收到只读/探测请求
    - **Property 12: 无鉴权本地 provider 不读取也不要求密钥**——随机 auth.in="none" 的本地 provider，断言不调用 SecretStore、不因 apiKeyRef 为空失败、请求不含鉴权头/查询
    - **Validates: Requirements 5.6, 6.8, 7.1, 7.2, 7.3, 4.4 / Property 8, 9, 12**
    - _Requirements: 5.6, 6.8, 7.1, 7.2, 7.3, 4.4_

- [x] 7. 检查点 - 确保服务层与发现探测测试通过
  - 运行 `pnpm test`，确保任务 5-6 的全部测试通过；如有疑问询问用户

- [x] 8. Provider 预设与 SigV4 特例适配器
  - [x] 8.1 实现内置 Provider 预设声明集
    - 在 `src/main/presets/providerPresets.ts` 声明主流云平台预设（OpenAI、Azure OpenAI、Anthropic、Google Gemini、AWS Bedrock，及 OpenAI 兼容组 DeepSeek/xAI/Groq/OpenRouter 等与国内平台阿里云百炼/智谱/Moonshot/SiliconFlow 等）与本地平台预设（Ollama、LM Studio、vLLM、llama.cpp server、LocalAI），每份含 `{ baseUrl 默认值, AuthInjection, ModelListingConfig, ModelProbeConfig }`
    - 实现"套用预设"逻辑：新建 Provider 选平台时套用默认值但不覆盖用户已手填值；预设缺失或非法（缺 baseUrl/AuthInjection/ModelListingConfig）时拒绝套用并返回错误，不创建无效 Provider
    - _Requirements: 4.1, 4.2, 4.3, 4.7, 13.1_

  - [x] 8.2 实现 AWS SigV4 代码级签名适配器
    - 在 `src/main/presets/sigv4Adapter.ts` 实现 SigV4 签名适配器，供 injectAuth 在 `kind="sigv4"` 时委托，复用 ModelListingConfig/ModelProbeConfig 的请求构造
    - _Requirements: 4.6_

  - [x] 8.3 为预设与数据驱动引擎编写属性测试
    - **Property 13: 预设数据驱动，不影响核心引擎**——对任意两份预设 p1/p2 用同一通用引擎按各自声明执行 fetch/probe，断言新增 p2 不改变 p1 的拉取/探测行为（sigv4 特例在专用适配器内不影响其它预设）
    - **Validates: Requirements 4.5 / Property 13**
    - _Requirements: 4.5, 4.1, 4.2_

  - [x] 8.4 为套用预设编写单元测试
    - 覆盖套用默认值、不覆盖用户手填值、预设非法时拒绝并报错、本地预设 auth.in="none"
    - _Requirements: 4.3, 4.4, 4.7_

- [x] 9. Agent 适配器抽象、注册表与四个适配器
  - [x] 9.1 实现 AgentAdapter 抽象基类与 AdapterRegistry
    - 在 `src/main/adapters/base.ts` 实现读取 `FormatMapping` 的适配器基类（通用 detect/configPath/render/apply 流程，render 复用任务 3 的 render+injectCredential）；在 `src/main/adapters/registry.ts` 实现 `AdapterRegistry`（register/get/list）
    - _Requirements: 8.1, 8.2, 9.1_

  - [x] 9.2 实现四个 Agent 适配器与各自 FormatMapping/CredentialMapping
    - 在 `src/main/adapters/` 实现 opencode、pi、workbuddy、codebuddy 四个适配器：各自声明 `FormatMapping`（format、fieldPaths、managedPaths）与 `CredentialMapping`（字段名/位置/引用形式），key 适配全部在 render 内经 injectCredential 转换，不污染 ProviderConfig
    - 在启动注册点集中 `registry.register(...)` 四个适配器
    - _Requirements: 8.1, 9.1, 9.6, 9.7_

  - [x] 9.3 为适配器与注册表编写属性测试
    - **Property 5: 扩展不变**——注册一个新增适配器后，断言其它已注册 agent 的分发行为不变（隔离性）
    - **Property 2: 字段级合并保真**（适配器维度）——对各适配器 mapping 随机既有配置，断言非 managedPaths 字段保留
    - **Property 14: key 适配收敛于适配器**（适配器维度）——断言各 agent key 以其 CredentialMapping 声明的形态出现且不泄露明文
    - **Validates: Requirements 8.2, 10.1, 9.7 / Property 2, 5, 14**
    - _Requirements: 8.2, 10.1, 9.7_

  - [x] 9.4 为各适配器编写单元测试
    - 每个适配器：detect 解析配置路径、render 合并保留非受管字段、不同 CredentialMapping 形态下 key 正确落位、既有文件格式损坏时报 failed 不覆盖
    - _Requirements: 8.1, 9.3, 9.4, 9.5, 10.4_

- [x] 10. Distributor 分发编排器
  - [x] 10.1 实现 Distributor 的 preview 与 distribute
    - 在 `src/main/services/distributor.ts` 实现 `preview`（对启用 agent 生成合并结果与 maskedDiff 不写盘）与 `distribute`（对每个 agent 依次 detect→解析密钥→render→backup→atomicWrite，失败回滚，隔离故障，汇总 ApplyReport）
    - 实现规则：未安装→skipped 不写文件；既有文件无法解析→failed 不覆盖；密钥无法解析（非无鉴权）→进入写盘前校验失败；凭据引用目标写入失败→该 agent failed 并回滚、不影响其它 agent
    - 实现模型筛选：`modelSelection="available-only"` 时写入集合为 candidateModels 中 available 的子集；candidateModels 非空时 models 为其 id 子集
    - _Requirements: 8.3, 8.4, 8.5, 8.6, 8.7, 10.3, 10.4, 10.5, 11.1, 11.2, 11.3, 11.4, 11.5_

  - [x] 10.2 为 Distributor 编写报告完备与模型筛选属性测试
    - **Property 4: 报告完备**——随机 agentIds，断言 entries 恰覆盖每个 agentId 一次且 summary 各计数之和等于 entries 长度
    - **Property 7: 仅分发可用模型**——随机带各种 availability 的 candidateModels，在 available-only 模式下断言分发集合为 available 子集
    - **Property 11: 候选到分发的包含关系**——candidateModels 非空时断言 config.models 每个 id 存在于候选 id 集合
    - **Validates: Requirements 11.1, 8.6, 8.7 / Property 4, 7, 11**
    - _Requirements: 11.1, 8.6, 8.7_

  - [x] 10.3 为 Distributor 编写故障隔离单元测试
    - 覆盖未安装 skipped、部分失败隔离（成功者保留失败者回滚）、密钥解析失败前置校验、既有文件损坏 failed、凭据引用目标写入失败 failed 并回滚
    - _Requirements: 8.5, 10.4, 10.5, 11.4, 11.5_

- [x] 11. IPC 层：主进程 handlers + preload 白名单 + 渲染进程客户端
  - [x] 11.1 实现主进程 IPC handlers
    - 在 `src/main/ipc/handlers.ts` 注册 `ipcMain.handle` 处理 `IpcApi` 全部方法（loadAppState/saveAppState/saveSecret/getMaskedSecret/detectAgents/preview/distribute/listAgents/fetchModels/probeModels），编排 ConfigStore/SecretStore/ModelDiscovery/Distributor/AdapterRegistry
    - 确保所有回传渲染进程的数据均不含明文密钥（明文仅主进程内存用后即弃）
    - _Requirements: 3.2, 3.4, 2.6, 2.7_

  - [x] 11.2 实现 preload contextBridge 白名单桥接
    - 在 `src/preload/index.ts` 经 `contextBridge.exposeInMainWorld` 仅暴露 `IpcApi` 白名单方法；渲染进程无直接文件系统/Node 能力
    - _Requirements: 3.1, 3.3, 3.4_

  - [x] 11.3 实现渲染进程 IPC 客户端封装
    - 在 `src/renderer/ipc/client.ts` 封装对 `window.ipcApi` 的类型安全调用，供 UI 组件使用
    - _Requirements: 3.3_

  - [x] 11.4 为 IPC 边界编写密钥不泄露测试
    - 断言经 IPC 回传渲染进程的 maskedDiff、getMaskedSecret、fetchModels/probeModels 结果序列化后均不含明文密钥
    - **Validates: Requirements 2.6, 3.4 / Property 1, Property 8**
    - _Requirements: 2.6, 3.4_

- [x] 12. React UI 组件
  - 本组所有 UI 组件一律使用 antd（antd v5）现成组件、不自行手写等价组件；图标统一使用 `@ant-design/icons`，全局消息统一使用 antd 的 `message`/`notification`
  - 布局与交互参照 pencil 设计稿 `ui.pen`（主界面 / Preview Diff 弹窗 / 分发报告弹窗 / Add Provider 弹窗 四个画布）
  - [x] 12.1 实现 Provider 列表与详情视图
    - 在 `src/renderer/components/` 实现 Provider 列表与详情组件，经 IPC 客户端加载/保存 AppState
    - 一律使用 antd 现成组件、不自行手写：整体三栏用 antd `Layout`（`Sider`/`Content`/`Header`）；Provider 列表用 `Menu` 或 `List` + `Badge`/`Tag` 状态点
    - 布局参照 `ui.pen` 主界面画布的左栏（Provider 列表）与中栏（详情）
    - _Requirements: 1.1, 1.3_

  - [x] 12.2 实现 API 配置表单（密钥掩码输入）
    - 实现 Provider 编辑表单：name/baseUrl/timeout/proxy 字段；API Key 输入后经 `saveSecret` 交主进程，界面仅展示 `getMaskedSecret` 掩码串，明文不写入 React 状态/缓存
    - 一律使用 antd 现成组件、不自行手写：表单用 antd `Form` + `Input`/`Input.Password`（API Key 掩码，明文不进入 React 状态）/`InputNumber`（timeout）/`Select`
    - 接入校验：用 `Form` 的 rules + `Form.Item` 校验态承接 validate() 逐项错误并逐项展示
    - 布局参照 `ui.pen` 主界面画布的中栏表单
    - _Requirements: 1.5, 1.6, 2.1, 2.6_

  - [x] 12.3 实现 Add Provider 平台预设选择（云/本地分组）
    - 实现新建 Provider 流程：按云平台/本地平台分组展示内置预设，选择后套用默认值（不覆盖用户手填），本地预设自动置无鉴权
    - 一律使用 antd 现成组件、不自行手写：用 antd `Modal`/`Drawer` + `Segmented`/`Tabs` + `Tag`（云/本地分组），图标用 `@ant-design/icons`
    - 布局参照 `ui.pen` 的 Add Provider 弹窗画布
    - _Requirements: 4.1, 4.2, 4.3_

  - [x] 12.4 实现模型发现、探测与筛选视图
    - 实现"获取模型清单"（调用 fetchModels，supportsListing=false 时回退手动输入）、"探测可用性"（调用 probeModels 展示 availability/延迟/错误）、模型筛选（available-only / all）
    - 一律使用 antd 现成组件、不自行手写：模型表格用 antd `Table`（`rowSelection` 勾选、`Tag` 语义色显示 available/unavailable/unknown、延迟列）；动作用 `Button`（含 loading 态）；筛选用 `Segmented`/`Radio.Group`；加载态用 `Spin`/`Button loading`
    - 布局参照 `ui.pen` 主界面画布的模型卡与表格
    - _Requirements: 5.1, 5.3, 6.1, 8.6_

  - [x] 12.5 实现分发预览 Diff 与分发报告视图
    - 实现调用 preview 展示 maskedDiff（密钥掩码/引用占位），调用 distribute 展示 ApplyReport（成功/失败/跳过/备份路径/原因）
    - 一律使用 antd 现成组件、不自行手写：预览/报告用 antd `Modal`/`Drawer`；Diff 用等宽文本容器（`Typography.Text code` / `<pre>`）展示 maskedDiff；报告的成功/失败/跳过用 `Statistic`/`Tag` + `List` + `Result`/`Alert`
    - 布局参照 `ui.pen` 的 Preview Diff 弹窗画布与分发报告弹窗画布
    - _Requirements: 8.3, 8.4, 11.1, 11.2, 11.3_

- [x] 13. 端到端集成测试
  - [x] 13.1 编写分发端到端集成测试
    - 用临时目录模拟各 agent 配置文件、内存 SecretStore、mock Provider API，端到端跑 `distribute`，校验文件内容、备份生成、报告正确、备份回滚
    - _Requirements: 8.3, 10.2, 10.3, 11.1_

  - [x] 13.2 编写"获取→探测→筛选→分发"端到端集成测试
    - mock Provider API 返回固定模型清单与探测响应，走 `fetchModels → probeModels → 筛选 available → distribute`，校验最终写入各 agent 的模型集合与筛选策略一致
    - _Requirements: 5.1, 6.1, 8.6, 8.7_

- [x] 14. 打包分发配置
  - [x] 14.1 配置 electron-builder 多平台打包
    - 配置 `electron-builder` 产出 Windows/macOS/Linux 安装包，打包脚本经 pnpm 运行（如 `pnpm build && pnpm dist`），接入主进程/渲染进程构建产物
    - _Requirements: 14.1, 14.2_

- [x] 15. 最终检查点 - 确保全部测试通过
  - 运行 `pnpm test` 与 `pnpm lint`，确保全部测试与检查通过；如有疑问询问用户

## Notes

- 标记 `*` 的子任务为测试相关（单元测试、属性测试、集成测试），可在追求 MVP 时跳过；核心实现任务不标 `*`。
- 每个任务都引用具体需求子项（`_Requirements: X.Y_`）以保证可追溯；属性测试任务额外标注所验证的 Property 编号。
- 检查点任务用于增量验证：在关键阶段确保已完成部分测试通过。
- 属性测试使用 fast-check，每个属性至少运行 100 次迭代，并显式引用设计中的 Property 编号（覆盖 Property 1-14）。
- 包管理器全程统一使用 pnpm；HTTP 发送与 SecretStore 均提供可注入实现，测试不访问真实外网与真实 OS 凭据库。
- 渲染进程 UI 一律使用 antd（antd v5）现成组件、不自写组件；视觉用 antd 默认主题（`ConfigProvider`/`theme`，主色 `#1677ff`、圆角 `6`）；布局与交互参照 pencil 设计稿 `ui.pen`。
- 全部 14 条需求与 14 个设计属性均由上述任务覆盖。

## Task Dependency Graph

```json
{
  "waves": [
    { "id": 0, "tasks": ["1.1"] },
    { "id": 1, "tasks": ["1.2", "1.3", "1.4"] },
    { "id": 2, "tasks": ["2.1"] },
    { "id": 3, "tasks": ["3.1", "3.3", "3.5", "3.7", "3.13"] },
    { "id": 4, "tasks": ["3.2", "3.4", "3.6", "3.8", "3.14", "6.1"] },
    { "id": 5, "tasks": ["3.9", "5.1", "5.3", "5.5", "8.1", "8.2"] },
    { "id": 6, "tasks": ["3.10", "3.11", "5.2", "5.4", "5.6", "8.3", "8.4"] },
    { "id": 7, "tasks": ["3.12", "6.2", "6.3", "9.1"] },
    { "id": 8, "tasks": ["6.4", "6.5", "6.6", "9.2"] },
    { "id": 9, "tasks": ["9.3", "9.4", "10.1"] },
    { "id": 10, "tasks": ["10.2", "10.3", "11.1"] },
    { "id": 11, "tasks": ["11.2", "11.3"] },
    { "id": 12, "tasks": ["11.4", "12.1", "12.2", "12.3", "12.4", "12.5"] },
    { "id": 13, "tasks": ["13.1", "13.2", "14.1"] }
  ]
}
```
