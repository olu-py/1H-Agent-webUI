import type { ProviderModelDto, ProviderSettingsDto } from "../types";

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

/**
 * Presets the settings dialog offers as one-off built-in rows (`custom` is
 * excluded: it is multi-instance and reached via the "add custom provider"
 * row instead).
 */
export const BUILTIN_PROVIDERS: ProviderDef[] = PROVIDERS.filter(
  (p) => p.key !== "custom",
);

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
 * Normalizes a provider string coming back from the server to a preset key.
 *
 * The template family always arrives as the preset key (`ProviderProfileDto.preset`
 * or `preset` in a request), but a couple of legacy paths can hand us the
 * human label ("DeepSeek") instead. This resolves keys directly and labels
 * case-insensitively; anything else (a `custom-<uuid>` id or an unknown value)
 * passes through unchanged, so it is safe to call on either a key or an id.
 */
export function providerKey(value: string): string {
  const trimmed = value.trim();
  if (PROVIDERS.some((p) => p.key === trimmed)) return trimmed;
  const lower = trimmed.toLowerCase();
  return PROVIDERS.find((p) => p.label.toLowerCase() === lower)?.key ?? trimmed;
}

/**
 * Display label for one saved/active provider profile.
 *
 * Named custom providers show their user-assigned name; built-ins (and legacy
 * unnamed profiles, whose core `display_label()` falls back to the preset
 * label) show the preset label. `id` is the stable identity, `preset` only the
 * template family.
 */
export function profileLabel(profile: { name?: string; preset: string }): string {
  const name = (profile.name ?? "").trim();
  return name || providerLabel(providerKey(profile.preset));
}


/** A selectable model in the grouped provider/model dropdown. */
export interface ProviderModelOption {
  id: string;
  context_window_tokens?: number | null;
  max_output_tokens?: number | null;
}

/** One provider heading plus its selectable models. */
export interface ProviderModelGroup {
  /** Stable provider id (built-in preset key or generated `custom-<uuid>`). */
  key: string;
  /** Display name: the custom provider's `name`, else the preset label. */
  label: string;
  /** Template family key (`openai` / `custom` / ...). */
  preset: string;
  models: ProviderModelOption[];
}

/**
 * Builds connected provider groups for the inline switcher.
 *
 * Since the provider id became the identity, `connected` and the snapshot's
 * `provider_id` are ids — several custom providers can share the `custom`
 * template, so groups are keyed by id (never by preset) and labelled with the
 * saved `name`. `connected` is authoritative; before settings has loaded the
 * active provider becomes a single-group fallback. The active provider's
 * dynamic model cache is merged only into its own group; other connected
 * providers use their static registry lists plus their saved model.
 */
export function buildProviderModelGroups({
  settings,
  providerId,
  model,
  providerModels,
}: {
  settings: ProviderSettingsDto | null;
  /** Active provider id (from `AppSnapshotV2.provider_id`). */
  providerId: string;
  model: string;
  providerModels: ProviderModelDto[] | null;
}): ProviderModelGroup[] {
  const activeId = providerId.trim();
  const connected = settings
    ? [...new Set(settings.connected.map((id) => id.trim()).filter(Boolean))]
    : activeId
      ? [activeId]
      : [];

  const savedById = new Map((settings?.saved ?? []).map((profile) => [profile.id, profile]));
  const presetOf = (id: string): string =>
    savedById.get(id)?.preset ??
    // The active profile may not be in `saved` yet during the first load.
    (id === activeId ? settings?.active.preset ?? id : id);
  const labelOf = (id: string): string => {
    const profile = savedById.get(id) ?? (id === activeId ? settings?.active : undefined);
    return profile ? profileLabel(profile) : providerLabel(providerKey(presetOf(id)));
  };

  // Preserve core registry order for built-ins, then append custom/unknown
  // provider ids in the order the core reported them.
  const ordered = [
    ...PROVIDERS.map((p) => p.key),
    ...connected.filter((id) => !PROVIDERS.some((p) => p.key === id)),
  ];
  const ids = ordered.filter((id) => connected.includes(id));

  return ids.map((id) => {
    const byId = new Map<string, ProviderModelOption>();
    const add = (modelId: string) => {
      if (modelId && !byId.has(modelId)) byId.set(modelId, { id: modelId });
    };

    const preset = providerKey(presetOf(id));
    for (const modelId of modelsForProvider(preset)) add(modelId);
    if (id === activeId) {
      for (const dto of providerModels ?? []) {
        byId.set(dto.id, {
          id: dto.id,
          context_window_tokens: dto.context_window_tokens,
          max_output_tokens: dto.max_output_tokens,
        });
      }
      if (model) add(model);
    }
    const savedModel = savedById.get(id)?.model;
    if (savedModel) add(savedModel);

    return { key: id, label: labelOf(id), preset, models: [...byId.values()] };
  });
}
