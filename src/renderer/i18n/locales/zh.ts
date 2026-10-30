// 简体中文文案资源（i18n 权威基线）
//
// 约定：
// - key 按「功能域.具体项」分组（common / header / providerList / providerForm /
//   addProvider / modelDiscovery / agentPanel / preview / report / status 等）。
// - 动态文案用 {name} 形式的占位符，由 t(key, vars) 在运行时插值。
// - 本文件的键集合是「完整集合」，英文资源 en.ts 必须与之键对齐（见 i18n/index 的类型约束）。

export const zh = {
  common: {
    cancel: '取消',
    save: '保存',
    done: '完成',
    retry: '重试',
    // 通用「操作失败：{detail}」后缀句式复用
    loadConfigFailed: '加载配置失败：{detail}',
    saveConfigFailed: '保存配置失败：{detail}',
    unknownError: '未知错误',
  },

  language: {
    // 语言切换控件
    label: '语言',
    zh: '简体中文',
    en: 'English',
  },

  header: {
    title: 'LLM 配置管理器',
    subtitle: 'source of truth',
    preview: '预览',
    distribute: '一键分发',
    loadingConfig: '加载配置中…',
  },

  app: {
    selectProviderFirst: '请先在左栏选择一个 Provider',
    enableAgentFirst: '请在右栏勾选至少一个启用的目标 agent',
  },

  providerList: {
    sectionTitle: 'PROVIDERS',
    addProviderAria: '新增 Provider',
    empty: '暂无 Provider，点击右上角「+」新增',
    localBadge: '本地',
  },

  providerStatus: {
    localUnverified: '本地 · 未验证',
    configured: '已配置',
  },

  providerDetail: {
    emptyHint: '从左栏选择一个 Provider，或点击「+」新增',
    subtitle: 'Provider configuration · source of truth',
    testConnection: '测试连接',
    // 测试连接相关 toast
    testOkNoListing: '连接成功（该 Provider 不支持自动获取模型清单）',
    testReachableWithWarning: '连接可达，但存在问题：{warning}',
    testOkWithModels: '连接成功，获取到 {count} 个候选模型',
    testFailed: '连接失败：{detail}',
    modelsSlotTitle: '模型',
    modelsSlotDesc: '模型发现、探测与筛选（获取清单 / 探测可用性 / 筛选）需要可写上下文',
    distSlotTitle: '分发预览 / 报告',
    distSlotDesc: '分发预览 Diff 与分发报告将在后续任务填充（preview 掩码差异 / distribute 报告）',
  },

  providerForm: {
    cardTitle: 'API 配置',
    name: '名称',
    nameRequired: '名称不能为空',
    nameTooLong: '名称长度不能超过 {max} 个字符',
    namePlaceholder: '如 openai / anthropic / 自定义网关',
    baseUrl: 'Base URL',
    baseUrlRequired: 'baseUrl 不能为空',
    baseUrlInvalid: 'baseUrl 必须是合法的 http 或 https 地址',
    baseUrlPlaceholder: '如 https://api.openai.com/v1',
    apiKey: 'API Key',
    apiKeyCurrent: '当前：',
    apiKeyLocalEmpty: '本地无鉴权 · 可留空',
    apiKeyUnset: '尚未设置',
    apiKeyTooltip: '明文仅用于保存到系统凭据管理器，不会写入配置文件或界面状态',
    apiKeyExtra: '输入后点击「保存密钥」即交主进程存入系统凭据管理器；界面只展示掩码串。',
    apiKeyPlaceholderLocal: '本地无鉴权可留空',
    apiKeyPlaceholderCloud: '粘贴 API Key 后点击保存',
    saveSecretTooltip: '将输入的明文安全保存到系统凭据管理器',
    saveSecret: '保存密钥',
    timeout: '超时（毫秒）',
    timeoutInvalid: '超时时间必须为正整数（毫秒）',
    timeoutPlaceholder: '如 30000',
    proxy: '代理地址',
    proxyInvalid: '代理地址必须是合法的 http 或 https 地址',
    proxyPlaceholder: '如 http://127.0.0.1:7890（可选）',
    isLocal: '本地 / 自托管',
    isLocalTooltip: '本地推理服务（Ollama / LM Studio 等）通常无需 API Key，开启后放宽密钥校验',
    switchYes: '是',
    switchNo: '否',
    // toast
    maskReadFailed: '读取密钥掩码失败：{detail}',
    secretInputRequired: '请先输入 API Key',
    secretRefMissing: '当前 Provider 缺少密钥引用（apiKeyRef），无法保存密钥',
    secretSaved: 'API Key 已安全保存到系统凭据管理器',
    secretSaveFailed: '保存 API Key 失败：{detail}',
  },

  addProvider: {
    title: '新增 Provider',
    save: '保存 Provider',
    cancel: '取消',
    subtitle: '选择平台后将套用其默认端点声明（baseUrl / 鉴权 / 模型列表 / 探测），便于后续自动获取与探测模型。',
    groupCloud: '云平台',
    groupLocal: '本地平台',
    groupLabelCloud: 'CLOUD / 云平台',
    groupLabelLocal: 'LOCAL / 本地平台',
    hintLocal: '本地平台：无需 API Key（无鉴权），可直接保存。',
    hintCloud: '云平台：鉴权方式为 {auth}。',
    name: '名称',
    nameRequired: '请填写 Provider 名称',
    nameWhitespace: '名称不能为纯空白',
    nameTooLong: '名称长度不超过 100 字符',
    namePlaceholder: 'openai',
    baseUrl: 'Base URL',
    baseUrlRequired: '请填写 Base URL',
    baseUrlProtocol: 'Base URL 必须以 http:// 或 https:// 开头',
    baseUrlInvalid: 'Base URL 不是合法的 URL',
    baseUrlPlaceholder: 'https://api.openai.com',
    apiKey: 'API Key',
    apiKeyExtraLocal: '本地平台无需 API Key，可留空。',
    apiKeyExtraCloud: '粘贴密钥后仅交主进程存入 OS 凭据库，明文不会保存在界面状态中（可稍后补填）。',
    apiKeyPlaceholder: '粘贴密钥 — 存入系统凭据库',
    // toast
    presetRequired: '请先选择一个平台预设（云平台或本地平台）',
    applyPresetFailed: '套用预设失败：{errors}',
    created: '已新增 Provider：{name}',
    createFailed: '新增 Provider 失败：{detail}',
    // 鉴权形态描述（describeAuth）
    authNone: '无鉴权',
    authSigv4: 'AWS SigV4 签名',
    authBearer: 'Authorization: Bearer {key}',
    authQuery: '查询参数 {name}={key}',
    authHeader: '请求头 {name}: {key}',
  },

  modelDiscovery: {
    cardTitle: '模型',
    filterAll: '全部',
    filterAvailableOnly: '仅可用',
    fetchList: '获取清单',
    probe: '探测可用性',
    manualHint: '该 Provider 不支持自动获取，请手动输入模型 id（回车分隔）：',
    manualPlaceholder: '输入模型 id，如 gpt-4o-mini，回车添加',
    empty: '暂无候选模型，点击「获取清单」自动获取，或在不支持时手动输入',
    colId: '模型 id',
    colSource: '来源',
    colAvailability: '可用性',
    colLatency: '延迟',
    sourceFetched: '自动',
    sourceManual: '手动',
    selectedSummary: '已选 {count} 个模型用于分发',
    selectedSuffixAvailableOnly: '（仅分发探测为可用的模型）',
    selectedSuffixAll: '（分发全部已选模型）',
    availabilityAvailable: '可用',
    availabilityUnavailable: '不可用',
    availabilityUnknown: '未知',
    // toast
    notSupported: '该 Provider 不支持自动获取模型清单，请手动输入模型 id',
    fetched: '获取到 {count} 个候选模型',
    fetchFailed: '获取模型清单失败：{detail}',
    probeEmpty: '暂无候选模型可探测，请先获取或手动输入模型 id',
    probeDone: '探测完成：{available}/{total} 个模型可用',
    probeFailed: '探测可用性失败：{detail}',
  },

  agentPanel: {
    sectionTitle: 'TARGET AGENTS',
    enabledCount: '已启用 {enabled}/{total}',
    loading: '加载 agent…',
    empty: '未发现可管理的 agent',
    configPathUnknown: '配置路径未知',
    // getAgentStatusView
    statusUnknown: '状态未知',
    statusNotInstalled: '未安装 · 分发时跳过',
    statusInstalledHasConfig: '已安装{version} · 已有配置',
    statusInstalledWillCreate: '已安装{version} · 将创建配置',
    // toast
    detectFailed: '探测 agent 状态失败：{detail}',
    listFailed: '加载 agent 列表失败：{detail}',
  },

  preview: {
    title: '分发预览 Diff',
    subtitle: '写入前审阅变更 · API Key 已掩码',
    cancel: '取消',
    confirm: '确认并分发',
    noTargetTitle: '未选择目标 agent',
    noTargetDesc: '请在右栏勾选至少一个启用的 agent，再进行预览与分发。',
    generating: '生成预览中…',
    empty: '没有可预览的变更',
    installed: '已安装',
    notInstalled: '未安装 · 分发时跳过',
    // toast
    genFailed: '生成预览失败：{detail}',
  },

  report: {
    title: '分发报告',
    retryFailed: '重试失败（{count}）',
    done: '完成',
    distributing: '分发中…',
    fatalTitle: '分发未能执行',
    resultTitle: '分发完成',
    resultTitlePartial: '分发完成（部分失败）',
    statSuccess: '成功',
    statFailed: '失败',
    statSkipped: '跳过',
    emptyEntries: '无分发条目',
    noReport: '暂无分发报告',
    backup: '备份：{path}',
    statusSuccess: '成功',
    statusFailed: '失败',
    statusSkipped: '跳过',
    // toast
    distributeFailed: '分发失败：{detail}',
  },
} as const;

export type Messages = typeof zh;
