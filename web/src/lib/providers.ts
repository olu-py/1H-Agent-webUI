/**
 * Provider presets + their selectable models for the Web UI switcher.
 *
 * This mirrors the core `ProviderPreset` registry (`config.rs`:
 * `ProviderPreset::ALL`, `key_id()`, `label()`, `selectable_models()`) and
 * `config/config.example.toml`. The frontend only ever sends the preset
 * `key` and a model string to `POST /api/v2/config/provider` — preset
 * parsing, key lookup and model validation stay in the core, which also
 * rejects unknown presets. `custom` has no preset model list, so its model
 * must be typed manually (same as the core picker).
 */
export interface ProviderDef {
  /** Preset key understood by the core (`ProviderPreset::parse`). */
  key: string;
  /** Display label. */
  label: string;
  /** Selectable models offered by the picker; `custom` is empty. */
  models: string[];
  /** Default base URL (`ProviderPreset::defaults`); shown as the placeholder
   * when the form switches to this preset. */
  defaultBaseUrl: string;
}

/** Presets in core order (`ProviderPreset::ALL`). */
export const PROVIDERS: ProviderDef[] = [
  {
    key: "openai",
    label: "OpenAI",
    defaultBaseUrl: "https://api.openai.com/v1",
    models: [
      "gpt-5-mini",
      "gpt-5",
      "gpt-5.6-sol",
      "gpt-5.6-terra",
      "gpt-5.6-luna",
      "o1",
      "o3",
      "o4-mini",
      "gpt-4o",
      "gpt-4.1",
      "o1-mini",
      "o1-preview",
    ],
  },
  {
    key: "deepseek",
    label: "DeepSeek",
    defaultBaseUrl: "https://api.deepseek.com",
    models: ["deepseek-v4-flash", "deepseek-v4-pro", "deepseek-chat", "deepseek-reasoner"],
  },
  {
    key: "qwen",
    label: "Qwen / Bailian",
    defaultBaseUrl: "https://{WorkspaceId}.cn-beijing.maas.aliyuncs.com/compatible-mode/v1",
    models: [
      "qwen3.8-max",
      "qwen3.7-max",
      "qwen-plus",
      "qwen-max",
      "qwen-turbo",
      "qwen-long",
    ],
  },
  {
    key: "volcano",
    label: "Volcano Ark",
    defaultBaseUrl: "https://ark.cn-beijing.volces.com/api/v3",
    models: ["doubao-seed-2-1-pro-260628", "deepseek-v4-flash", "glm-5.2"],
  },
  {
    key: "custom",
    label: "Custom compatible",
    defaultBaseUrl: "https://api.example.com/v1",
    models: [],
  },
];

/** Display label for a preset key (tolerant of unknown keys). */
export function providerLabel(key: string): string {
  return PROVIDERS.find((p) => p.key === key)?.label ?? key;
}

/** Selectable models for a preset key; `custom` and unknown keys return []. */
export function modelsForProvider(key: string): string[] {
  return PROVIDERS.find((p) => p.key === key)?.models ?? [];
}

/** Default base URL for a preset key (mirrors `ProviderPreset::defaults`). */
export function defaultBaseUrl(key: string): string {
  return PROVIDERS.find((p) => p.key === key)?.defaultBaseUrl ?? "";
}

/** ProviderKind wire tags accepted by the set-provider endpoint. */
export const PROVIDER_KINDS = [
  { key: "responses", label: "Responses" },
  { key: "chat_completions", label: "Chat Completions" },
] as const;

/**
 * Normalizes a provider string coming back from the server to a registry key.
 *
 * The v2 snapshot reports the preset *label* ("DeepSeek") while
 * `POST /api/v2/config/provider` (and this registry) speak the preset *key*
 * ("deepseek"). Matching by key alone therefore leaves the switcher with no
 * active preset and an empty model list. This resolves keys directly and
 * labels case-insensitively; anything else (custom/unknown) passes through.
 */
export function providerKey(value: string): string {
  const trimmed = value.trim();
  if (PROVIDERS.some((p) => p.key === trimmed)) return trimmed;
  const lower = trimmed.toLowerCase();
  return PROVIDERS.find((p) => p.label.toLowerCase() === lower)?.key ?? trimmed;
}
