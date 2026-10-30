// API 配置表单（主界面中栏 · 填充 ProviderDetail 的「API 配置」插槽，对应任务 12.2）
//
// 职责：
// - 编辑当前 Provider 的供应商中立字段：name / baseUrl / timeoutMs / proxy。
// - API Key 走「写入即交主进程」的安全路径：用户在 Input.Password 输入明文后，点击「保存密钥」
//   即经 ipcClient.saveSecret 交主进程存入凭据管理器；UI 侧仅展示 ipcClient.getMaskedSecret
//   返回的掩码串。明文绝不写入 React 状态 / 缓存 / 日志（与 Property 1、Requirement 2 一致）。
// - 校验：用 antd Form 的 rules + Form.Item 校验态逐项承接并展示校验错误；校验规则与主进程
//   src/main/core/validate.ts 等价（name 1-100、baseUrl 合法 http/https、timeoutMs 正整数），
//   避免重复造轮子——此处用 antd rules 表达同一套语义。
//
// 一律使用 antd 现成组件：Form + Input / Input.Password（API Key 掩码）/ InputNumber（timeout）/
// Switch（本地标记）。布局参照 ui.pen 主界面中栏表单（配置卡）。
//
// 安全约束（重申）：
// - API Key 的 Input.Password 不绑定到 Form 字段、不进入 React 状态；输入值仅在「保存密钥」
//   点击的同一事件内从 DOM 读取并立即交主进程，随后清空输入框。
// - 表单回传给上层的仅为中立字段（不含明文密钥）。

import { useCallback, useEffect, useRef, useState } from 'react';
import {
  App as AntApp,
  Button,
  Card,
  Form,
  Input,
  InputNumber,
  Space,
  Switch,
  Tooltip,
  Typography,
} from 'antd';
import type { InputRef } from 'antd';
import { KeyOutlined, SaveOutlined } from '@ant-design/icons';
import type { ProviderConfig } from '@shared/types';
import { ipcClient } from '../ipc/client';
import { useTranslation } from '../i18n';

const { Text } = Typography;

/** name 允许的最大长度（与主进程 validate.ts 一致） */
const NAME_MAX_LENGTH = 100;

/** 表单内可编辑的中立字段集合（不含任何明文密钥，也不含模型清单——模型由 12.4 负责） */
interface ProviderFormValues {
  /** Provider 名称：1-100 非空 */
  name: string;
  /** API 基础地址：合法 http/https */
  baseUrl: string;
  /** 请求超时（毫秒），可选——正整数 */
  timeoutMs?: number;
  /** 代理地址，可选 */
  proxyUrl?: string;
  /** 是否本地/自托管 provider（为 true 时通常无需 API Key，校验放宽） */
  isLocal?: boolean;
}

/** ProviderForm 组件属性 */
export interface ProviderFormProps {
  /** 当前编辑的 Provider（配置真相，不含明文密钥） */
  provider: ProviderConfig;
  /**
   * 中立字段变更回调：表单把合并后的 ProviderConfig（仅更新中立字段）回传给上层持久化。
   * 注意：回传对象绝不含明文密钥，apiKeyRef 等引用保持不变（由本组件独立维护）。
   */
  onChange?: (next: ProviderConfig) => void;
}

/**
 * 从 ProviderConfig 提取表单初始值（只取中立可编辑字段）。
 */
function toFormValues(provider: ProviderConfig): ProviderFormValues {
  return {
    name: provider.name,
    baseUrl: provider.baseUrl,
    timeoutMs: provider.timeoutMs,
    proxyUrl: provider.proxy?.url,
    isLocal: provider.isLocal,
  };
}

/**
 * 校验字符串是否为合法 http/https URL（与 validate.ts 的 isValidHttpUrl 等价）。
 */
function isValidHttpUrl(value: string): boolean {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return false;
  }
  return url.protocol === 'http:' || url.protocol === 'https:';
}

/**
 * API 配置表单组件。
 *
 * 受控于上层传入的 provider：切换选中 Provider 时用 provider 重置表单与掩码展示。
 */
export function ProviderForm({ provider, onChange }: ProviderFormProps): React.JSX.Element {
  // 全局消息（在 ConfigProvider 作用域内生效）
  const { message } = AntApp.useApp();
  const { t } = useTranslation();
  const [form] = Form.useForm<ProviderFormValues>();

  // 当前 API Key 的掩码串（来自主进程 getMaskedSecret）；null 表示尚未设置密钥。
  // 注意：这里存的永远是「掩码串」，绝不是明文。
  const [maskedSecret, setMaskedSecret] = useState<string | null>(null);
  // 「保存密钥」按钮的 loading 态
  const [savingSecret, setSavingSecret] = useState<boolean>(false);
  // API Key 输入框引用：用于在保存后清空、以及从 DOM 即时读取明文（明文不进 state）
  const apiKeyInputRef = useRef<InputRef>(null);

  // provider 的 apiKeyRef：密钥引用（指向 OS 凭据管理器条目），不是明文
  const apiKeyRef = provider.apiKeyRef;

  // 切换 Provider 时：重置表单值为新 provider 的中立字段
  useEffect(() => {
    form.setFieldsValue(toFormValues(provider));
  }, [form, provider]);

  // 加载 / 刷新当前 apiKeyRef 的掩码串（仅展示掩码，绝不取明文）
  const refreshMasked = useCallback(async () => {
    // 无 apiKeyRef（如本地无鉴权、或尚未分配引用）时，不请求掩码
    if (!apiKeyRef) {
      setMaskedSecret(null);
      return;
    }
    try {
      const masked = await ipcClient.getMaskedSecret(apiKeyRef);
      setMaskedSecret(masked);
    } catch (err) {
      // 掩码获取失败不阻断表单；仅提示
      message.error(t('providerForm.maskReadFailed', { detail: toErrorMessage(err) }));
      setMaskedSecret(null);
    }
  }, [apiKeyRef, message, t]);

  // Provider 或其 apiKeyRef 变化时，刷新掩码展示
  useEffect(() => {
    void refreshMasked();
  }, [refreshMasked]);

  // 中立字段变更：把表单当前值合并回 ProviderConfig 并回传上层持久化。
  // 注意：apiKeyRef / id / models / candidateModels 等非本表单字段原样保留，不被覆盖。
  const emitChange = useCallback(() => {
    if (!onChange) {
      return;
    }
    const values = form.getFieldsValue();
    const trimmedProxy = values.proxyUrl?.trim();
    const next: ProviderConfig = {
      ...provider,
      name: values.name?.trim() ?? '',
      baseUrl: values.baseUrl?.trim() ?? '',
      // timeoutMs 为空时移除该字段（可选）
      timeoutMs: values.timeoutMs ?? undefined,
      isLocal: values.isLocal ?? false,
      // proxy 为空时移除整个 proxy 字段，否则写入 url（保留既有 authRef）
      proxy: trimmedProxy
        ? { url: trimmedProxy, authRef: provider.proxy?.authRef }
        : undefined,
    };
    onChange(next);
  }, [form, onChange, provider]);

  // 保存 API Key：明文仅在本回调内从 DOM 读取一次，立即交主进程后清空输入框，绝不进 state。
  const handleSaveSecret = useCallback(async () => {
    // 从输入框 DOM 即时读取明文（不绑定到 Form 字段、不写入任何 React 状态）
    const plaintext = apiKeyInputRef.current?.input?.value ?? '';
    if (!plaintext) {
      message.warning(t('providerForm.secretInputRequired'));
      return;
    }
    if (!apiKeyRef) {
      // 正常情况下新建 Provider 时应已分配 apiKeyRef；此处兜底提示
      message.error(t('providerForm.secretRefMissing'));
      return;
    }
    setSavingSecret(true);
    try {
      // 立即交主进程存入凭据管理器；明文到此为止，不回流 UI
      await ipcClient.saveSecret(apiKeyRef, plaintext);
      // 清空输入框，杜绝明文在 DOM 中滞留（该控件未绑定 Form 字段，直接清空 DOM 值）
      if (apiKeyInputRef.current?.input) {
        apiKeyInputRef.current.input.value = '';
      }
      message.success(t('providerForm.secretSaved'));
      // 刷新掩码展示（从主进程取掩码串，仍不含明文）
      await refreshMasked();
    } catch (err) {
      message.error(t('providerForm.secretSaveFailed', { detail: toErrorMessage(err) }));
    } finally {
      setSavingSecret(false);
    }
  }, [apiKeyRef, message, refreshMasked, t]);

  return (
    <Card size="small" title={t('providerForm.cardTitle')} style={{ width: '100%' }}>
      <Form<ProviderFormValues>
        form={form}
        layout="vertical"
        initialValues={toFormValues(provider)}
        // 每次字段变更都把中立字段回传上层（明文密钥不在表单字段内，故不会外泄）
        onValuesChange={emitChange}
        requiredMark="optional"
      >
        {/* 名称：1-100 非空（与 validate.ts 的 name 规则等价） */}
        <Form.Item
          label={t('providerForm.name')}
          name="name"
          rules={[
            { required: true, whitespace: true, message: t('providerForm.nameRequired') },
            { max: NAME_MAX_LENGTH, message: t('providerForm.nameTooLong', { max: NAME_MAX_LENGTH }) },
          ]}
        >
          <Input placeholder={t('providerForm.namePlaceholder')} allowClear />
        </Form.Item>

        {/* baseUrl：合法 http/https（与 validate.ts 的 isValidHttpUrl 等价，用自定义校验器表达） */}
        <Form.Item
          label={t('providerForm.baseUrl')}
          name="baseUrl"
          rules={[
            { required: true, whitespace: true, message: t('providerForm.baseUrlRequired') },
            {
              validator: (_rule, value: string) => {
                // 空值交由 required 规则处理，避免重复报错
                if (!value) {
                  return Promise.resolve();
                }
                return isValidHttpUrl(value)
                  ? Promise.resolve()
                  : Promise.reject(new Error(t('providerForm.baseUrlInvalid')));
              },
            },
          ]}
        >
          <Input placeholder={t('providerForm.baseUrlPlaceholder')} allowClear />
        </Form.Item>

        {/* API Key（掩码输入）：完全脱离 Form 字段体系（无 name 绑定），
            明文不作为受控值进入 React 状态，也不参与 onValuesChange 回传。 */}
        <Form.Item
          label={
            <Space size={6}>
              <span>{t('providerForm.apiKey')}</span>
              {/* 展示当前掩码串（绝不含明文）；无密钥时提示未设置 */}
              {maskedSecret ? (
                <Text type="secondary" style={{ fontSize: 12 }}>
                  {t('providerForm.apiKeyCurrent')}<Text code>{maskedSecret}</Text>
                </Text>
              ) : (
                <Text type="secondary" style={{ fontSize: 12 }}>
                  {provider.isLocal ? t('providerForm.apiKeyLocalEmpty') : t('providerForm.apiKeyUnset')}
                </Text>
              )}
            </Space>
          }
          tooltip={t('providerForm.apiKeyTooltip')}
          extra={
            <Text type="secondary" style={{ fontSize: 12 }}>
              {t('providerForm.apiKeyExtra')}
            </Text>
          }
        >
          <Space.Compact style={{ width: '100%' }}>
            <Input.Password
              ref={apiKeyInputRef}
              prefix={<KeyOutlined />}
              placeholder={provider.isLocal ? t('providerForm.apiKeyPlaceholderLocal') : t('providerForm.apiKeyPlaceholderCloud')}
              autoComplete="off"
              // 不设置 value/onChange 受控绑定：明文不进入 React 状态
            />
            <Tooltip title={t('providerForm.saveSecretTooltip')}>
              <Button
                type="primary"
                icon={<SaveOutlined />}
                loading={savingSecret}
                onClick={() => {
                  void handleSaveSecret();
                }}
              >
                {t('providerForm.saveSecret')}
              </Button>
            </Tooltip>
          </Space.Compact>
        </Form.Item>

        {/* 超时（毫秒）：可选，正整数（与 validate.ts 的 timeoutMs 规则等价） */}
        <Form.Item
          label={t('providerForm.timeout')}
          name="timeoutMs"
          rules={[
            {
              validator: (_rule, value: number | undefined) => {
                // 未填写时允许为空（可选字段）
                if (value === undefined || value === null) {
                  return Promise.resolve();
                }
                return Number.isInteger(value) && value > 0
                  ? Promise.resolve()
                  : Promise.reject(new Error(t('providerForm.timeoutInvalid')));
              },
            },
          ]}
        >
          <InputNumber
            min={1}
            step={1000}
            precision={0}
            placeholder={t('providerForm.timeoutPlaceholder')}
            style={{ width: '100%' }}
          />
        </Form.Item>

        {/* 代理地址：可选 */}
        <Form.Item
          label={t('providerForm.proxy')}
          name="proxyUrl"
          rules={[
            {
              validator: (_rule, value: string) => {
                if (!value || !value.trim()) {
                  return Promise.resolve();
                }
                return isValidHttpUrl(value.trim())
                  ? Promise.resolve()
                  : Promise.reject(new Error(t('providerForm.proxyInvalid')));
              },
            },
          ]}
        >
          <Input placeholder={t('providerForm.proxyPlaceholder')} allowClear />
        </Form.Item>

        {/* 本地标记：为 true 时校验放宽（API Key 允许为空） */}
        <Form.Item
          label={t('providerForm.isLocal')}
          name="isLocal"
          valuePropName="checked"
          tooltip={t('providerForm.isLocalTooltip')}
        >
          <Switch checkedChildren={t('providerForm.switchYes')} unCheckedChildren={t('providerForm.switchNo')} />
        </Form.Item>
      </Form>
    </Card>
  );
}

/** 把未知错误安全地转为可展示的字符串 */
function toErrorMessage(err: unknown): string {
  if (err instanceof Error) {
    return err.message;
  }
  return String(err);
}
