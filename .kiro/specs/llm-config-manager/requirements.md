# Requirements Document

## Introduction

本文档定义「LLM 配置管理器（llm-config-manager）」的需求。该功能是一个跨平台桌面应用，用于集中维护一份供应商中立的「配置真相」（Provider：名称、baseUrl、API Key 引用、模型列表、超时、代理），并将筛选后的模型与 API 配置一键分发到多个本地 AI Agent（首批 opencode、pi、workbuddy、codebuddy，架构可扩展）。

应用采用 TypeScript + Electron + React：主进程负责文件系统、操作系统凭据管理器访问与各 Agent 适配器执行；渲染进程仅负责 UI，所有敏感操作经 IPC 委托主进程完成。API Key 永不明文落盘，存入操作系统凭据管理器，配置中仅保存引用。系统开箱支持主流云平台与本地/自托管推理服务，支持基于 API 自动获取模型清单与可用性探测，分发采用字段级合并、原子写入、备份回滚，并产出分发报告。

本文档为设计优先（Design-First）工作流从已完成的 design.md 派生，需求编号用于与设计中的正确性属性（Property 1–14）建立可追溯映射。

## Glossary

- **System（本系统 / 本程序）**：LLM 配置管理器桌面应用整体。
- **Main_Process（主进程）**：Electron 主进程（Node 环境），负责文件系统、凭据管理器、适配器执行与模型发现探测等敏感底层操作。
- **Renderer_Process（渲染进程）**：Electron 渲染进程（React UI），仅负责界面与交互，不直接访问文件系统或密钥。
- **IPC_Bridge（IPC 桥接）**：预加载脚本通过 contextBridge 暴露给渲染进程的白名单 IPC 接口。
- **Provider_Config（Provider 配置）**：供应商中立的统一配置对象，含 id、name、baseUrl、apiKeyRef、models、超时、代理等中立字段，不含任何 agent 专属的 key 字段。
- **Secret_Store（密钥服务）**：封装对操作系统凭据管理器（Windows Credential Manager / macOS Keychain / Linux Secret Service）读写的主进程服务。
- **Config_Store（配置存储服务）**：持久化本程序自身 AppState（Provider 列表、Agent 启用状态等，不含明文密钥）的主进程服务。
- **Agent_Adapter（Agent 适配器）**：为单个 agent 封装探测安装、解析配置路径、渲染预览、字段级合并写入能力的组件，所有 agent 实现统一接口。
- **Adapter_Registry（适配器注册表）**：集中管理所有 Agent 适配器、支持注册与查询的组件。
- **Distributor（分发编排器）**：编排一次分发全流程（detect → 解析密钥 → render → 备份 → 原子写入 → 失败回滚）并汇总报告的组件。
- **Atomic_File_Writer（安全文件写入）**：提供时间戳备份、临时文件加原子 rename、失败回滚的文件写入组件。
- **Path_Resolver（跨平台路径解析）**：把含平台变量的路径模板解析为当前平台绝对路径的组件，处理 `~`、`%APPDATA%`、`$XDG_CONFIG_HOME` 等。
- **Model_Discovery（模型发现与探测服务）**：主进程组件，负责基于 API 自动获取模型清单与以最小代价真实调用探测模型可用性。
- **Format_Mapping（格式映射描述）**：声明如何把统一 Provider 配置字段映射到某 agent 配置文件具体位置的数据驱动描述。
- **Credential_Mapping（凭据注入声明）**：声明把供应商 key 适配成某 agent 要求的字段名、位置、引用形式（inline/env/secrets-file）与值模板的数据驱动描述。
- **Model_Listing_Config（模型列表端点配置）**：声明某 provider 模型列表端点路径、方法、鉴权注入与响应解析映射的数据驱动描述。
- **Model_Probe_Config（模型探测端点配置）**：声明某 provider 探测端点路径、方法、鉴权注入与请求体模板的数据驱动描述。
- **Auth_Injection（鉴权注入）**：声明把密钥注入请求的位置（header/query/none）与种类（bearer/header/query/none/sigv4）的描述。
- **Provider_Preset（内置预设）**：内置的声明式 `{ baseUrl 默认值, Auth_Injection, Model_Listing_Config, Model_Probe_Config }` 模板，用户新建 Provider 选平台即套用。
- **Managed_Paths（受管字段路径集合）**：某 agent 配置中由本程序管理、分发时允许改动的字段路径集合。
- **Masked_Diff（掩码差异）**：供 UI 预览的配置差异文本，明文密钥已掩码，env/secrets 引用形态显示引用占位。
- **Apply_Report（分发报告）**：一次分发对每个 agent 的成功/失败/跳过结果汇总，含备份路径、错误原因、跳过原因与汇总计数。
- **Model_Availability（模型可用性）**：取值 available / unavailable / unknown，表示模型最近一次探测的结论。
- **Local_Provider（本地 provider）**：baseUrl 指向 localhost/内网主机的自托管推理服务（Ollama、LM Studio、vLLM、llama.cpp server、LocalAI 等），通常无需鉴权。
- **pnpm**：本项目统一使用的包管理器。

## Requirements

### Requirement 1: 统一 Provider 配置管理（配置真相）

**User Story:** 作为开发者，我想在统一界面集中维护一份供应商中立的 Provider 配置，以便把它作为分发到各 agent 的唯一「配置真相」。

#### Acceptance Criteria

1. THE System SHALL 维护供应商中立的 Provider_Config，包含 id、name、baseUrl、apiKeyRef、models、可选 timeoutMs 与可选 proxy 字段。
2. THE Provider_Config SHALL 不包含任何特定 agent 专属的 key 字段，保持供应商中立且与 agent 无关。
3. WHEN 用户保存一个 Provider_Config，THE System SHALL 通过 Config_Store 将其持久化到应用自有数据目录，且持久化内容不含明文密钥。
4. IF Config_Store 持久化过程发生 I/O 失败，THEN THE System SHALL 保留内存中既有的 Provider_Config 状态不变，并返回指示持久化失败的错误标识。
5. WHEN 用户提交 Provider_Config 进行校验，THE System SHALL 校验 name 为长度 1 至 100 个字符的非空字符串、baseUrl 为可解析的 http 或 https URL、models 包含 1 至 50 个元素、timeoutMs（若提供）为正整数。
6. IF Provider_Config 的 baseUrl 非法或 name 为空或超长、或 models 为空或超过 50 项、或 timeoutMs 非正整数，THEN THE System SHALL 返回包含每个未通过项的校验失败结果且不执行分发。
7. WHERE Provider_Config 的 candidateModels 非空，THE System SHALL 要求 candidateModels 内各模型 id 唯一。

### Requirement 2: API Key 安全存储与密钥不泄露

**User Story:** 作为安全敏感用户，我想让 API Key 存入操作系统凭据管理器且全程掩码，以便泄露配置文件不等于泄露密钥。

#### Acceptance Criteria

1. WHEN 用户在界面提交 API Key，THE Renderer_Process SHALL 将明文经进程间通道交由 Main_Process，且 SHALL NOT 将该明文写入 Provider_Config、日志或本地缓存。
2. WHEN Main_Process 收到 API Key 明文，THE Main_Process SHALL 通过 Secret_Store 将密钥存入操作系统凭据管理器，并在 Provider_Config 中仅保存 apiKeyRef 引用。
3. IF Secret_Store 写入操作系统凭据管理器失败，THEN THE Main_Process SHALL 中止保存、不在 Provider_Config 中写入 apiKeyRef，并向 Renderer_Process 返回指示存储失败的错误标识。
4. THE Secret_Store SHALL 提供按 keyRef 保存密钥、按 keyRef 解析明文、按 keyRef 删除密钥，以及按 keyRef 返回掩码串共四项操作。
5. IF Secret_Store 按 keyRef 解析或删除时未找到对应密钥，THEN THE Secret_Store SHALL 返回指示 keyRef 不存在的错误标识，且 SHALL NOT 返回明文或空明文占位。
6. WHILE 向 Renderer_Process 展示密钥，THE System SHALL 仅返回掩码串，且在任何返回 Renderer_Process 的字段中 SHALL NOT 包含明文密钥。
7. WHEN Main_Process 为分发或探测解析明文密钥，THE System SHALL 仅在 Main_Process 内存中使用该明文完成单次调用后立即清除其引用，且 SHALL NOT 将明文回传 Renderer_Process。
8. WHEN Agent_Adapter 的 render 产出 Masked_Diff，THE System SHALL 确保 Masked_Diff 及任何回传 Renderer_Process 的数据中均不出现明文 apiKey。（Validates: Property 1）
9. WHEN maskSecret 函数处理长度大于等于 8 个字符的密钥，THE maskSecret 函数 SHALL 返回保留前 4 个字符与后 4 个字符、中段全部以掩码字符替代的掩码串，且输出 SHALL NOT 包含任一原始中段字符。
10. IF 待掩码密钥长度小于 8 个字符，THEN THE maskSecret 函数 SHALL 返回与原密钥等长且全部为掩码字符的掩码串，且输出 SHALL NOT 包含任一原始字符。

### Requirement 3: 进程隔离与 IPC 安全边界

**User Story:** 作为系统架构者，我想让一切敏感操作置于主进程并通过白名单 IPC 暴露，以便渲染进程无法直接触及文件系统与密钥。

#### Acceptance Criteria

1. THE System SHALL 关闭 nodeIntegration、开启 contextIsolation，且仅通过 contextBridge 暴露白名单 IPC_Bridge 接口。
2. THE System SHALL 在 Main_Process 执行全部文件系统读写、凭据管理器访问、适配器执行与模型发现探测操作。
3. WHEN Renderer_Process 需要执行敏感操作，THE Renderer_Process SHALL 经 IPC_Bridge 委托 Main_Process 完成，且不直接访问文件系统或密钥。
4. THE System SHALL 确保经 IPC_Bridge 回传 Renderer_Process 的所有数据均不含明文密钥。

### Requirement 4: 主流云平台与本地部署平台覆盖

**User Story:** 作为多平台用户，我想开箱即用地支持主流云平台与本地/自托管推理服务，以便无需手工配置底层拉取与探测逻辑即可使用。

#### Acceptance Criteria

1. THE System SHALL 内置一组 Provider_Preset，覆盖 OpenAI、Azure OpenAI、Anthropic、Google Gemini、AWS Bedrock，以及 OpenAI 兼容云平台（如 DeepSeek、xAI、Groq、OpenRouter 等）与国内云平台（如阿里云百炼、智谱、Moonshot、SiliconFlow 等）。
2. THE System SHALL 内置本地/自托管推理服务的 Provider_Preset，覆盖 Ollama、LM Studio、vLLM、llama.cpp server、LocalAI。
3. WHEN 用户新建 Provider 并选择某平台，THE System SHALL 将该平台 Provider_Preset 的 baseUrl 默认值、Auth_Injection、Model_Listing_Config 与 Model_Probe_Config 作为可编辑默认值套用，且不覆盖用户已手工填写的值。
4. WHERE Provider 标记为 Local_Provider 或其鉴权方式为无鉴权（auth.in 为 "none" 或 kind 为 "none"），THE System SHALL 允许 apiKeyRef 为空且不要求其在 Secret_Store 中可解析。（Validates: Property 12）
5. WHEN 用户新增一份声明式 Provider_Preset 并选择它新建 Provider，THE System SHALL 复用现有 Model_Discovery 拉取与探测引擎完成获取与探测，无需改动引擎代码。（Validates: Property 13）
6. WHERE 平台为 AWS Bedrock（Auth_Injection 的 kind 为 "sigv4"），THE System SHALL 由专门的代码级鉴权适配器处理 SigV4 签名，而其它平台仍由声明式 Auth_Injection 覆盖。
7. IF 所选平台对应的 Provider_Preset 缺失或声明非法（缺少必需的 baseUrl/Auth_Injection/Model_Listing_Config 字段），THEN THE System SHALL 拒绝套用并返回指示预设缺失或非法的错误标识，且不创建处于无效状态的 Provider。

### Requirement 5: 基于 API 自动获取模型清单

**User Story:** 作为开发者，我想自动从 provider 拉取当前可用的模型清单，以便无需手工录入模型 id。

#### Acceptance Criteria

1. WHEN 用户对声明了 Model_Listing_Config 的 Provider 请求获取模型清单，THE Model_Discovery SHALL 在 Main_Process 解析明文密钥、按声明向模型列表端点发起只读请求，并用响应解析映射归一化为模型清单。
2. WHEN 归一化模型清单，THE System SHALL 为每个模型设置 source 为 "fetched"、availability 为 "unknown"，并对模型 id 去重。
3. WHERE Provider 未声明 Model_Listing_Config，THE System SHALL 返回 supportsListing 为 false 且不发起任何远端请求，并提示 Renderer_Process 回退手动输入。（Validates: Property 9）
4. IF 模型列表端点返回 401 或 403，THEN THE System SHALL 返回 supportsListing 为 true、空模型清单且 warning 标注鉴权失败。
5. IF 模型列表端点不可达、返回非成功状态码或响应格式无法按解析映射定位到模型数组，THEN THE System SHALL 返回带 warning 的结果而不向 Renderer_Process 抛出未处理异常。
6. WHEN 向 Renderer_Process 回传获取结果，THE System SHALL 确保回传数据序列化后不含明文 apiKey。（Validates: Property 8）

### Requirement 6: 探测模型可用性

**User Story:** 作为开发者，我想用最小代价的真实调用探测每个模型的可用性，以便只分发真正可调用的模型。

#### Acceptance Criteria

1. WHEN 用户请求探测一组模型，THE Model_Discovery SHALL 按 Model_Probe_Config 对每个模型发起最小代价的真实调用，并返回 availability（available/unavailable/unknown）、延迟与错误原因。
2. THE Model_Discovery SHALL 使同时进行的探测请求数不超过 options.concurrency，且任一模型探测耗时不超过 options.timeoutMs。
3. WHEN 探测调用命中可用状态码集合，THE System SHALL 将该模型判定为 available 并记录 latencyMs。
4. IF 探测调用返回 401 或 403，THEN THE System SHALL 将该模型判定为 unavailable 并在 error 中标注鉴权失败。
5. IF 探测调用超过 timeoutMs，THEN THE System SHALL 将该模型判定为 unavailable 并将 error 记为超时。
6. IF 探测调用发生网络或解析等不可判定错误，THEN THE System SHALL 将该模型判定为 unknown 并记录错误原因。
7. WHEN 批量探测返回，THE System SHALL 使结果与输入 modelIds 一一对应，长度相等且可按原下标对齐。（Validates: Property 10）
8. WHEN 向 Renderer_Process 回传探测结果，THE System SHALL 确保回传数据序列化后不含明文 apiKey。（Validates: Property 8）

### Requirement 7: 发现与探测只读无副作用

**User Story:** 作为用户，我想确保获取模型清单与探测过程不改动任何配置，以便探测是安全且可反复进行的。

#### Acceptance Criteria

1. WHEN 执行 fetchModels 或 probeModels，THE System SHALL 不修改任何本地配置文件（各 agent 配置、AppState）。（Validates: Property 9）
2. WHEN 向 provider 远端发起发现或探测请求，THE System SHALL 仅发起只读或最小代价查询（GET 模型列表、max_tokens 极小的探测调用），不触发写入类操作。（Validates: Property 9）
3. WHERE Provider 为无鉴权的 Local_Provider（isLocal 为 true 或 auth.in 为 "none"），THE Model_Discovery SHALL 不调用 Secret_Store 解析密钥、不因 apiKeyRef 为空而失败，且发出的请求不含任何鉴权头或查询参数。（Validates: Property 12）

### Requirement 8: 可扩展的 Agent 适配器与一键分发

**User Story:** 作为开发者，我想勾选启用的 agent 并一键把筛选后的模型与 API 配置分发到各 agent，以便快速同步配置到所有工具。

#### Acceptance Criteria

1. THE System SHALL 通过 Adapter_Registry 管理所有 Agent_Adapter，首批包含 opencode、pi、workbuddy、codebuddy。
2. WHEN 新增一个实现 Agent_Adapter 接口的 agent 并在 Adapter_Registry 注册，THE System SHALL 使该新增不改变其它已注册 agent 的分发行为。（Validates: Property 5）
3. WHEN 用户勾选启用的 agent 并触发分发，THE Distributor SHALL 对每个启用的 agent 依次执行探测安装、解析密钥、渲染合并、备份、原子写入，并在失败时回滚。
4. WHEN 用户在分发前请求预览，THE System SHALL 对每个启用的 agent 生成合并结果与 Masked_Diff 且不写入磁盘。
5. IF 某 agent 探测结果为未安装，THEN THE System SHALL 将该 agent 标记为 skipped、记录跳过原因且不写任何文件。
6. WHERE Provider_Config 的 modelSelection 为 "available-only"，THE System SHALL 使分发时写入各 agent 的模型集合为 candidateModels 中 availability 为 "available" 的模型集合的子集。（Validates: Property 7）
7. WHERE candidateModels 非空，THE System SHALL 使分发集合 models 中每个 id 均存在于 candidateModels 的 id 集合中。（Validates: Property 11）

### Requirement 9: 凭据适配收敛于适配器

**User Story:** 作为架构者，我想让各 agent 对供应商 key 的差异在适配器分发时内部转换，以便统一真相不被任何 agent 的 key 写法污染。

#### Acceptance Criteria

1. THE System SHALL 使各 agent 对供应商 key 的字段名、位置、引用形式与格式差异由该 agent 的 Agent_Adapter 在 render 阶段转换，而不在 Provider_Config 中保留任何 agent 专属 key 字段。（Validates: Property 14）
2. WHEN 适配器 render 转换凭据，THE System SHALL 优先采用数据驱动的 Credential_Mapping 声明；IF 凭据需要无法用 Credential_Mapping 声明表达的特殊封装（base64、签名、连接串等），THEN THE System SHALL 采用 transform 钩子完成转换；IF transform 钩子执行失败，THEN THE System SHALL 终止本次 render、不产生部分写入的合并内容，并返回错误指示 transform 钩子失败。
3. WHERE Credential_Mapping 的 form 为 "inline"，THE System SHALL 在目标指针处写入按值模板渲染的明文。
4. WHERE Credential_Mapping 的 form 为 "env"，THE System SHALL 在目标指针处写入环境变量引用占位，并将明文写入 envVarName 对应的环境变量或该 agent 的 .env，使配置文件本身不含明文；IF envVarName 为空或未声明，THEN THE System SHALL 终止本次 render 并返回错误指示 env 形态缺少 envVarName。
5. WHERE Credential_Mapping 的 form 为 "secrets-file"，THE System SHALL 在目标指针处写入对独立 secrets 文件的引用占位，并将明文写入 secretsFile 指定的路径与条目，使配置文件本身不含明文；IF secretsFile 路径或条目未声明，THEN THE System SHALL 终止本次 render 并返回错误指示 secrets-file 形态缺少目标路径或条目。
6. WHERE 某 agent 同时支持引用形态与明文写入，THE System SHALL 优先采用引用形态而非写入明文配置文件。
7. WHEN 适配器 render 完成凭据转换，THE System SHALL 使供应商 key 以该 agent 要求的字段名、位置与引用形式出现在合并内容中，且 Masked_Diff 与任何回传 Renderer_Process 的数据均不含明文 key。（Validates: Property 14）

### Requirement 10: 字段级合并、原子写入与备份回滚

**User Story:** 作为用户，我想分发时只改 provider 相关受管字段并安全写入，以便保留我既有的非 API 设置且写入失败不损坏文件。

#### Acceptance Criteria

1. WHEN 适配器 render 合并配置，THE System SHALL 仅设置 Managed_Paths 指定的字段为来自 Provider_Config 的值，并原样保留所有非受管字段（主题、快捷键、MCP 等）。（Validates: Property 2）
2. WHEN 写入某 agent 配置文件，THE Atomic_File_Writer SHALL 先创建带时间戳的备份，再写入临时文件并通过原子 rename 覆盖目标。
3. IF 某 agent 写入过程失败，THEN THE System SHALL 将该 agent 配置文件回滚为分发前状态，使其内容保持旧内容或保持不存在，不留半写文件。（Validates: Property 3）
4. IF 既有配置文件内容无法按其格式解析，THEN THE System SHALL 将该 agent 标记为 failed、提示格式异常且不覆盖原文件。
5. IF Secret_Store 无法解析 apiKeyRef 对应的明文密钥（非无鉴权场景），THEN THE System SHALL 在进入写盘阶段前使分发校验失败并提示重新录入密钥。
6. WHEN setByPointer 写入目标指针，THE System SHALL 创建沿途缺失的中间对象并保持不属于该路径的兄弟节点不变。

### Requirement 11: 分发报告与故障隔离

**User Story:** 作为用户，我想在分发后看到每个 agent 的结果汇总，以便了解成功、失败与跳过情况并对失败项单独重试。

#### Acceptance Criteria

1. WHEN 一次分发完成，THE System SHALL 返回 Apply_Report，其 entries 恰好覆盖请求中的每个 agentId 一次，且 summary 各计数之和等于 entries 长度。（Validates: Property 4）
2. WHEN 某 agent 分发成功，THE System SHALL 在其结果中记录状态 success，并在原文件存在时记录有效 backupPath。
3. WHEN 某 agent 分发失败或被跳过，THE System SHALL 在其结果中记录状态 failed 或 skipped，并记录错误原因或跳过原因。
4. IF 多个 agent 中部分写入失败，THEN THE System SHALL 使各 agent 相互隔离，成功者保留、失败者回滚，且单个 agent 失败不影响其它 agent 继续处理。
5. IF 某 agent 的凭据引用目标（环境变量、.env 或独立 secrets 文件）写入失败，THEN THE System SHALL 将该 agent 标记为 failed 并回滚其局部改动，且不影响其它 agent。

### Requirement 12: 跨平台路径解析

**User Story:** 作为跨平台用户，我想让程序在 Windows、macOS、Linux 上正确定位各 agent 的配置文件，以便无需手工指定路径。

#### Acceptance Criteria

1. WHERE 运行平台为 win32、darwin 或 linux，THE Path_Resolver SHALL 返回该平台约定的配置根目录。（Validates: Property 6）
2. WHEN 解析含平台变量的路径模板，THE Path_Resolver SHALL 正确展开 `~`、`%APPDATA%`、`$XDG_CONFIG_HOME` 等变量并归一化为绝对路径。（Validates: Property 6）
3. WHEN 适配器解析其配置文件路径，THE System SHALL 将写入目标限定在解析出的预期配置目录内，并对解析结果做规范化与归属校验以避免路径穿越。

### Requirement 13: 本地部署的特有处理

**User Story:** 作为本地部署用户，我想让程序识别本地服务未启动等本地场景，以便获得贴切的错误提示而非误导性的密钥提示。

#### Acceptance Criteria

1. WHERE Provider 为 Local_Provider，THE System SHALL 允许 baseUrl 指向 localhost、127.0.0.1 或自定义内网主机与端口。
2. IF 对 Local_Provider 发起发现或探测请求时发生连接被拒绝、主机不可达或端口未监听错误，THEN THE System SHALL 将其识别为连接错误而非鉴权失败，并给出提示本地服务可能未运行的可读错误信息。
3. WHEN 识别到本地连接错误，THE System SHALL 在探测结果中将该模型判定为 unavailable 或在获取结果中返回带 warning 的空清单，且不提示鉴权失败或密钥无效。

### Requirement 14: 技术栈与工程约束

**User Story:** 作为项目维护者，我想明确技术栈与工程工具约束，以便团队在一致的技术基线上开发与协作。

#### Acceptance Criteria

1. THE System SHALL 使用 TypeScript、Electron 与 React 实现，Main_Process 负责文件系统、密钥与适配器执行，Renderer_Process 仅负责 UI，二者经 IPC 通信。
2. THE System SHALL 使用 pnpm 作为唯一包管理器，用于依赖安装、脚本运行与 workspace 管理。
3. THE System SHALL 使用 Vitest 作为测试运行器，并使用 fast-check 进行基于属性的测试。
4. THE System SHALL 使属性测试每个属性至少运行 100 次迭代，且每个属性测试引用其对应的设计属性编号。
