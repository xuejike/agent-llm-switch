// Add Provider 弹窗：平台预设选择（云/本地分组）+ 基础字段录入
//
// 职责（本任务 12.3）：
// - 新建 Provider 流程：按「云平台 / 本地平台」分组展示内置预设，选择某平台后套用其默认值
//   （不覆盖用户已手填的值）；本地预设自动置为无鉴权（isLocal=true，auth.in="none"）。
// - 选平台后把预设的 baseUrl 默认值填入表单；用户可继续编辑 name / baseUrl / API Key。
// - 确认后组装一个供应商中立的 ProviderConfig（仅含中立 apiKeyRef，不含明文密钥），
//   经 onCreate 上抛给 App 持久化（App 侧调用 ipcClient.saveAppState）。
//
// 一律使用 antd 现成组件、不自行手写：
// - 弹窗用 antd `Modal`；云/本地分组切换用 `Segmented`；预设用 `Tag.CheckableTag`（可选中标签）；
// - 表单用 `Form` + `Input` / `Input.Password`（API Key 掩码，明文不进入持久状态）；
// - 图标统一取自 `@ant-design/icons`；全局消息用 antd `App.useApp()` 的 message。
//
// 布局参照 ui.pen 的「Add Provider 弹窗」画布（标题 + 预设分组 Chips + BASICS 表单 + 底部动作）。
//
// 安全约束：API Key 明文仅用于提交时经 ipcClient.saveSecret 交主进程存入 OS 凭据库，
// 不写入任何持久化的 React 状态/AppState；本组件只向上抛出中立配置（含 apiKeyRef 引用）。
//
// 预设数据来源：src/renderer/presets/providerPresets.ts（主进程 providerPresets.ts 的渲染侧等价只读镜像）。

import { useCallback, useMemo, useState } from 'react';
import {
  App as AntApp,
  Form,
  Input,
  Modal,
  Segmented,
  Space,
  Tag,
  Typography,
} from 'antd';
import { CloudOutlined, DesktopOutlined, KeyOutlined } from '@ant-design/icons';
import type { ProviderConfig } from '@shared/types';
import { ipcClient } from '../ipc/client';
import { useTranslation, type TKey, type TVars } from '../i18n';
import {
  CLOUD_PRESETS,
  LOCAL_PRESETS,
  applyPreset,
  getPreset,
  type PresetGroup,
  type ProviderPreset,
} from '../presets/providerPresets';

const { Text } = Typography;
const { CheckableTag } = Tag;

/** AddProviderModal 组件属性 */
export interface AddProviderModalProps {
  /** 是否可见（由 App 控制开合） */
  open: boolean;
  /** 已存在的 Provider id 集合（用于生成不冲突的新 id） */
  existingIds: string[];
  /** 关闭弹窗（取消或创建成功后由 App 收起） */
  onClose: () => void;
  /**
   * 创建新 Provider 回调：返回组装好的中立 ProviderConfig（含 apiKeyRef，不含明文）。
   * API Key 明文的落库由本组件在创建前经 ipcClient.saveSecret 完成，此处只上抛引用。
   */
  onCreate: (provider: ProviderConfig) => void;
}

/** 基础表单字段（仅本弹窗内填写的可编辑基础项） */
interface BasicsFormValues {
  /** Provider 名称（展示名/标识） */
  name: string;
  /** API 基础地址（选预设后预填默认值，可编辑） */
  baseUrl: string;
  /** API Key 明文（可选；本地无鉴权可留空）——仅提交时用后即弃 */
  apiKey?: string;
}

/**
 * 由名称生成 kebab-case 的 apiKeyRef 片段（仅保留字母数字与连字符，避免凭据键异常字符）。
 * 为空时回退为 "provider"，保证引用键始终非空。
 */
function slugify(name: string): string {
  const slug = name
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/(^-+)|(-+$)/g, '');
  return slug.length > 0 ? slug : 'provider';
}

/**
 * 生成一个在 existingIds 中不冲突的唯一 id。
 * 优先使用 crypto.randomUUID（渲染进程可用）；不可用时回退为时间戳 + 随机串。
 */
function genUniqueId(existingIds: string[]): string {
  const existing = new Set(existingIds);
  for (let i = 0; i < 1000; i += 1) {
    const candidate =
      typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function'
        ? crypto.randomUUID()
        : `p-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
    if (!existing.has(candidate)) {
      return candidate;
    }
  }
  // 极端兜底：拼接时间戳保证唯一
  return `p-${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`;
}

/**
 * Add Provider 弹窗组件。
 * 内部维护「当前分组 / 选中预设 / 提交中」三类本地 UI 状态与一个受控表单；
 * 不持有 AppState、不直接写盘（创建结果经 onCreate 上抛给 App）。
 */
export function AddProviderModal({
  open,
  existingIds,
  onClose,
  onCreate,
}: AddProviderModalProps): React.JSX.Element {
  const { message } = AntApp.useApp();
  const { t } = useTranslation();
  const [form] = Form.useForm<BasicsFormValues>();

  // 当前分组（云/本地）：驱动下方 Chips 展示哪一组预设
  const [group, setGroup] = useState<PresetGroup>('cloud');
  // 当前选中的预设 id（为空表示尚未选择平台）
  const [selectedPresetId, setSelectedPresetId] = useState<string>();
  // 提交中态：禁用重复提交并展示 OK 按钮 loading
  const [submitting, setSubmitting] = useState<boolean>(false);

  // 当前分组对应的预设列表（云/本地）
  const presets = useMemo<readonly ProviderPreset[]>(
    () => (group === 'cloud' ? CLOUD_PRESETS : LOCAL_PRESETS),
    [group],
  );

  // 当前选中的预设对象（供展示其 baseUrl/鉴权等信息）
  const selectedPreset = useMemo<ProviderPreset | undefined>(
    () => (selectedPresetId ? getPreset(selectedPresetId) : undefined),
    [selectedPresetId],
  );

  // 重置弹窗内全部本地状态与表单（关闭/取消/创建成功后调用）
  const resetState = useCallback(() => {
    form.resetFields();
    setGroup('cloud');
    setSelectedPresetId(undefined);
    setSubmitting(false);
  }, [form]);

  // 切换云/本地分组：仅切换展示，不清空已选平台（选项切到另一组时由 Chips 自然不高亮）
  const handleGroupChange = useCallback((value: string | number) => {
    setGroup(value as PresetGroup);
  }, []);

  /**
   * 选中某平台预设：套用默认值到表单，但不覆盖用户已手填的值。
   * - name：若用户尚未填写，用预设展示名作为默认值预填；已填则保留。
   * - baseUrl：仅当用户尚未填写时，用预设 baseUrl 预填；已填则保留。
   * 本地预设天然 isLocal=true、auth.in="none"，提交时据此放宽校验。
   */
  const handleSelectPreset = useCallback(
    (preset: ProviderPreset, checked: boolean) => {
      // 取消选中：清空当前预设选择（保留用户已填字段）
      if (!checked) {
        setSelectedPresetId(undefined);
        return;
      }
      setSelectedPresetId(preset.id);

      // 读取用户当前已填值，作为「不覆盖」的依据
      const current = form.getFieldsValue();
      const userBaseUrl = (current.baseUrl ?? '').trim();
      const userName = (current.name ?? '').trim();

      // 经 applyPreset 计算默认值（仅填补用户未提供的字段，不覆盖已填值）
      const result = applyPreset(preset, {
        baseUrl: userBaseUrl.length > 0 ? userBaseUrl : undefined,
      });
      if (!result.ok) {
        message.error(t('addProvider.applyPresetFailed', { errors: result.errors.join('; ') }));
        return;
      }

      // 把计算出的默认值回填表单（name 用预设展示名作默认，baseUrl 用 applyPreset 结果）
      form.setFieldsValue({
        name: userName.length > 0 ? userName : preset.displayName,
        baseUrl: result.config.baseUrl ?? userBaseUrl,
      });
    },
    [form, message, t],
  );

  // 取消：重置并关闭
  const handleCancel = useCallback(() => {
    resetState();
    onClose();
  }, [resetState, onClose]);

  /**
   * 确认创建：
   * 1) 必须已选平台预设（否则无从套用默认端点声明）。
   * 2) 校验基础字段（name/baseUrl 非空）。
   * 3) 本地（无鉴权）预设允许 API Key 留空；云平台预设若填了 Key 则落库，未填也放行（可稍后补）。
   * 4) 经 applyPreset 以用户手填值为准套用默认值，组装中立 ProviderConfig 上抛。
   */
  const handleOk = useCallback(async () => {
    if (!selectedPreset) {
      message.warning(t('addProvider.presetRequired'));
      return;
    }

    let values: BasicsFormValues;
    try {
      values = await form.validateFields();
    } catch {
      // 表单校验未通过：antd 已在各 Form.Item 下展示错误，无需额外处理
      return;
    }

    setSubmitting(true);
    try {
      const name = values.name.trim();
      const baseUrl = values.baseUrl.trim();
      const apiKey = (values.apiKey ?? '').trim();

      // 生成唯一 id 与中立的凭据引用键（apiKeyRef 指向 OS 凭据库条目）
      const id = genUniqueId(existingIds);
      const apiKeyRef = apiKey.length > 0 ? `${slugify(name)}-${id.slice(0, 8)}` : '';

      // 若填写了 API Key：先经主进程存入凭据库，再上抛仅含引用的配置（明文用后即弃）
      if (apiKey.length > 0) {
        await ipcClient.saveSecret(apiKeyRef, apiKey);
      }

      // 以用户手填值为准套用预设默认值（不覆盖手填值），组装中立 ProviderConfig
      const applied = applyPreset(selectedPreset, { baseUrl });
      if (!applied.ok) {
        message.error(t('addProvider.applyPresetFailed', { errors: applied.errors.join('; ') }));
        setSubmitting(false);
        return;
      }

      const provider: ProviderConfig = {
        id,
        name,
        baseUrl: applied.config.baseUrl ?? baseUrl,
        apiKeyRef,
        models: [],
        // 本地预设天然无鉴权（isLocal=true）；云平台 isLocal=false
        isLocal: applied.config.isLocal ?? selectedPreset.isLocal ?? false,
        // 数据驱动的端点声明来自预设（供后续 12.4 模型发现/探测使用）
        modelListing: applied.config.modelListing,
        modelProbe: applied.config.modelProbe,
      };

      onCreate(provider);
      message.success(t('addProvider.created', { name }));
      resetState();
      onClose();
    } catch (err) {
      message.error(t('addProvider.createFailed', { detail: toErrorMessage(err) }));
      setSubmitting(false);
    }
  }, [selectedPreset, form, existingIds, onCreate, onClose, resetState, message, t]);

  return (
    <Modal
      title={t('addProvider.title')}
      open={open}
      onOk={handleOk}
      onCancel={handleCancel}
      okText={t('addProvider.save')}
      cancelText={t('addProvider.cancel')}
      confirmLoading={submitting}
      okButtonProps={{ icon: <KeyOutlined /> }}
      width={600}
      destroyOnClose
      maskClosable={false}
    >
      <Space direction="vertical" size={16} style={{ width: '100%', paddingTop: 8 }}>
        {/* 副标题：说明选平台会自动套用端点声明（便于后续自动拉取/探测） */}
        <Text type="secondary" style={{ fontSize: 12 }}>
          {t('addProvider.subtitle')}
        </Text>

        {/* 云 / 本地 分组切换：antd Segmented（图标取自 @ant-design/icons） */}
        <Segmented<string>
          value={group}
          onChange={handleGroupChange}
          options={[
            { label: t('addProvider.groupCloud'), value: 'cloud', icon: <CloudOutlined /> },
            { label: t('addProvider.groupLocal'), value: 'local', icon: <DesktopOutlined /> },
          ]}
          block
        />

        {/* 预设 Chips：当前分组下的全部内置预设，用可选中标签（CheckableTag）呈现 */}
        <div>
          <Text type="secondary" style={{ fontSize: 11, letterSpacing: 1 }}>
            {group === 'cloud' ? t('addProvider.groupLabelCloud') : t('addProvider.groupLabelLocal')}
          </Text>
          <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8, marginTop: 8 }}>
            {presets.map((preset) => (
              <CheckableTag
                key={preset.id}
                checked={preset.id === selectedPresetId}
                onChange={(checked) => handleSelectPreset(preset, checked)}
                style={{
                  padding: '4px 12px',
                  fontSize: 13,
                  border: '1px solid #d9d9d9',
                  userSelect: 'none',
                }}
              >
                {preset.displayName}
              </CheckableTag>
            ))}
          </div>
        </div>

        {/* 选中预设后的提示：展示该预设的鉴权形态（本地为无鉴权） */}
        {selectedPreset ? (
          <Text type="secondary" style={{ fontSize: 12 }}>
            {selectedPreset.isLocal
              ? t('addProvider.hintLocal')
              : t('addProvider.hintCloud', { auth: describeAuth(selectedPreset, t) })}
          </Text>
        ) : null}

        {/* BASICS 表单：name / baseUrl / API Key（API Key 明文不进入持久状态） */}
        <Form<BasicsFormValues> form={form} layout="vertical" requiredMark={false}>
          <Form.Item
            label={t('addProvider.name')}
            name="name"
            rules={[
              { required: true, message: t('addProvider.nameRequired') },
              { whitespace: true, message: t('addProvider.nameWhitespace') },
              { max: 100, message: t('addProvider.nameTooLong') },
            ]}
          >
            <Input placeholder={t('addProvider.namePlaceholder')} allowClear />
          </Form.Item>

          <Form.Item
            label={t('addProvider.baseUrl')}
            name="baseUrl"
            rules={[
              { required: true, message: t('addProvider.baseUrlRequired') },
              {
                // 必须是合法的 http/https URL（本地场景允许 localhost/自定义主机端口）
                validator: (_rule, value: string) => {
                  if (!value || value.trim().length === 0) {
                    return Promise.resolve();
                  }
                  try {
                    const url = new URL(value.trim());
                    if (url.protocol === 'http:' || url.protocol === 'https:') {
                      return Promise.resolve();
                    }
                    return Promise.reject(new Error(t('addProvider.baseUrlProtocol')));
                  } catch {
                    return Promise.reject(new Error(t('addProvider.baseUrlInvalid')));
                  }
                },
              },
            ]}
          >
            <Input placeholder={t('addProvider.baseUrlPlaceholder')} allowClear />
          </Form.Item>

          <Form.Item
            label={t('addProvider.apiKey')}
            name="apiKey"
            // 本地无鉴权预设可留空；云平台可稍后在 API 配置表单（12.2）补填
            extra={
              selectedPreset?.isLocal
                ? t('addProvider.apiKeyExtraLocal')
                : t('addProvider.apiKeyExtraCloud')
            }
          >
            <Input.Password placeholder={t('addProvider.apiKeyPlaceholder')} autoComplete="off" />
          </Form.Item>
        </Form>
      </Space>
    </Modal>
  );
}

/**
 * 描述某预设的鉴权形态（用于提示文案），经 t 本地化。
 * @param preset 预设
 * @param t 翻译函数（由组件注入，确保随语言切换）
 */
function describeAuth(preset: ProviderPreset, t: (key: TKey, vars?: TVars) => string): string {
  const { auth } = preset;
  if (auth.in === 'none' || auth.kind === 'none') {
    return t('addProvider.authNone');
  }
  if (auth.kind === 'sigv4') {
    return t('addProvider.authSigv4');
  }
  if (auth.kind === 'bearer') {
    // 技术串原样展示（不翻译 header 名/格式），但经 key 占位统一
    return t('addProvider.authBearer', { key: '{key}' });
  }
  if (auth.in === 'query') {
    return t('addProvider.authQuery', { name: auth.name ?? 'key', key: '{key}' });
  }
  return t('addProvider.authHeader', { name: auth.name ?? 'Authorization', key: '{key}' });
}

/** 把未知错误安全地转为可展示的字符串 */
function toErrorMessage(err: unknown): string {
  if (err instanceof Error) {
    return err.message;
  }
  return String(err);
}
