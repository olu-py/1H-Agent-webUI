import { useEffect, useMemo, useRef, useState } from "react";
import type { ChatActions } from "../hooks";
import type { UiState } from "../state/reducer";
import type { ProviderModelDto } from "../types";
import {
  BUILTIN_PROVIDERS,
  PROVIDER_KINDS,
  defaultBaseUrl,
  modelsForProvider,
  profileLabel,
  providerKey,
  providerLabel,
} from "../lib/providers";
import { Icon } from "./icons";

/** Compact token count for option labels ("128k", "1m"). */
function compactTokens(tokens: number): string {
  if (tokens >= 1_000_000) return `${Math.floor(tokens / 1_000_000)}m`;
  if (tokens >= 1_000) return `${Math.floor(tokens / 1_000)}k`;
  return String(tokens);
}

/** Option label: the model id plus its discovered context window, when the
 * provider's `GET /models` (or models.dev) reported one. */
function modelLabel(model: ProviderModelDto): string {
  const window = model.context_window_tokens;
  return window != null ? `${model.id} · ${compactTokens(Number(window))}` : model.id;
}

/** Option tooltip: full metadata when present. */
function modelTitle(model: ProviderModelDto): string {
  const parts = [model.id];
  if (model.context_window_tokens != null) {
    parts.push(`窗口 ${Number(model.context_window_tokens).toLocaleString()} tokens`);
  }
  if (model.max_output_tokens != null) {
    parts.push(`最大输出 ${Number(model.max_output_tokens).toLocaleString()} tokens`);
  }
  return parts.join(" · ");
}

/**
 * Provider settings dialog, rendered at the app level (like the approval
 * modal) so every entry point can open it: the composer's switcher trigger
 * and the command palette's "Provider 设置" entry.
 *
 * The form edits one provider profile addressed by its stable id: the four
 * built-ins (one row each), then every saved custom provider (unbounded), plus
 * an "add custom provider" row. A custom provider carries a required unique
 * display name; built-ins show the preset label. The form edits model / base
 * URL / protocol plus an optional API key; the key is write-only (stored in
 * the OS keyring by the core and never echoed back), so the dialog can only
 * show whether one is currently resolved.
 */
export function ProviderSettingsModal({
  state,
  actions,
  onClose,
}: {
  state: UiState;
  actions: ChatActions;
  onClose: () => void;
}) {
  const settings = state.providerSettings;
  const saved = settings?.saved ?? [];
  const connected = settings?.connected ?? [];

  // One row per profile. Built-ins are addressed by preset key (their
  // canonical id); custom rows carry the generated `custom-<uuid>` id.
  const builtinRows = BUILTIN_PROVIDERS.map((p) => ({
    id: p.key,
    preset: p.key,
    name: "",
  }));
  const customRows = saved
    .filter((profile) => providerKey(profile.preset) === "custom")
    .map((profile) => ({
      id: profile.id,
      preset: "custom" as const,
      name: profile.name,
    }));
  const rows = useMemo(
    () => [...builtinRows, ...customRows],
    // eslint is not configured; the row lists are cheap and derived each render.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [settings],
  );

  // `providerId === ""` means "creating a new custom provider"; an existing
  // id selects that profile. The initial selection is the active provider.
  const [providerId, setProviderId] = useState(
    () => settings?.active.id ?? state.providerId ?? "",
  );
  const [name, setName] = useState(() => settings?.active.name ?? "");
  const [preset, setPreset] = useState(() =>
    providerKey(settings?.active.preset ?? state.provider),
  );
  const [creating, setCreating] = useState(false);
  const [selectedModel, setSelectedModel] = useState(settings?.active.model ?? state.model);
  const [baseUrl, setBaseUrl] = useState(settings?.active.base_url ?? "");
  const [kind, setKind] = useState(settings?.active.kind ?? "responses");
  const [apiKey, setApiKey] = useState("");
  const [showKey, setShowKey] = useState(false);
  const [saving, setSaving] = useState(false);
  const [confirmingDelete, setConfirmingDelete] = useState(false);
  const [loadingModels, setLoadingModels] = useState(false);
  const [windowTokens, setWindowTokens] = useState("");
  const [fetchingWindow, setFetchingWindow] = useState(false);
  const [windowNote, setWindowNote] = useState<string | null>(null);

  // Load the settings view whenever the dialog opens.
  useEffect(() => {
    void actions.loadProviderSettings();
    // Model list: instant cache read; the refresh button refetches from the
    // provider endpoint / models.dev.
    void actions.loadProviderModels();
    // `actions` is a stable object created once in main.tsx.
    // eslint isn't configured in this project; the empty dependency list is
    // intentional: fetch exactly once per mount.
  }, []);

  // Re-seed the form whenever a freshly fetched settings object arrives
  // (initially stale store data, then the response of the load above; after
  // a successful apply the dialog closes, so edits are never clobbered).
  const seededRef = useRef(settings);
  useEffect(() => {
    if (!settings || seededRef.current === settings) return;
    seededRef.current = settings;
    // A freshly fetched settings view re-seeds the form onto the active
    // profile - never while the user is mid-create, so a rename in progress is
    // not clobbered.
    if (creating) return;
    setProviderId(settings.active.id ?? settings.active.preset);
    setName(settings.active.name ?? "");
    setPreset(providerKey(settings.active.preset));
    setSelectedModel(settings.active.model);
    setBaseUrl(settings.active.base_url);
    setKind(settings.active.kind);
  }, [settings, creating]);

  // Close on Escape; clicking the backdrop closes (modal-card stops it).
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [onClose]);

  // Seed the form from a profile (or a preset template) and select that row.
  const selectRow = (row: { id: string; preset: string; name: string }) => {
    setCreating(false);
    setConfirmingDelete(false);
    setProviderId(row.id);
    setPreset(providerKey(row.preset));
    setName(row.name);
    const savedProfile = saved.find((p) => p.id === row.id);
    setBaseUrl(savedProfile?.base_url ?? defaultBaseUrl(row.preset));
    setKind(savedProfile?.kind ?? (row.preset === "custom" ? "chat_completions" : "responses"));
    setWindowTokens("");
    setWindowNote(null);
    const models = modelsForProvider(row.preset);
    if (!models.includes(selectedModel)) {
      setSelectedModel(savedProfile?.model ?? models[0] ?? "");
    }
  };

  // Start a brand-new custom provider (unbounded: each apply mints a new id).
  const startCreate = () => {
    setCreating(true);
    setConfirmingDelete(false);
    setProviderId("");
    setPreset("custom");
    setName("");
    setSelectedModel("");
    setBaseUrl(defaultBaseUrl("custom"));
    setKind("chat_completions");
    setWindowTokens("");
    setWindowNote(null);
  };

  const deleteSelected = async () => {
    if (creating || !providerId) return;
    await actions.removeProvider(providerId);
    setConfirmingDelete(false);
    onClose();
  };

  const trimmedName = name.trim();
  // A new custom provider must be named; the core enforces the same rule and
  // returns a localized `bad_request` if a client bypasses the disabled button.
  const nameRequired = creating || providerKey(preset) === "custom";
  const nameValid = !nameRequired || trimmedName.length > 0;
  const canApply = !saving && selectedModel.trim().length > 0 && nameValid;

  const apply = async () => {
    const model = selectedModel.trim();
    if (!model || !nameValid) return;
    setSaving(true);
    try {
      const window = windowTokens ? Number(windowTokens) : undefined;
      await actions.setProvider(preset, model, {
        // Empty id + `custom` is the core's create signal.
        id: providerId || undefined,
        name: nameRequired ? trimmedName : undefined,
        baseUrl: baseUrl.trim(),
        kind,
        // Send only when the user filled it: an explicit window for models
        // the metadata chain cannot resolve (the core clamps the bounds).
        contextWindowTokens:
          window != null && Number.isFinite(window) && window > 0 ? window : undefined,
        apiKey: apiKey.trim() || undefined,
      });
      setApiKey("");
      onClose();
    } finally {
      setSaving(false);
    }
  };

  const refreshModels = async () => {
    setLoadingModels(true);
    try {
      await actions.loadProviderModels(true);
    } finally {
      setLoadingModels(false);
    }
  };

  // "获取" next to the window input: force-refreshes the metadata (provider
  // /models + models.dev), then fills the input from the refreshed entry for
  // the selected model. Only the active profile can be queried — the core
  // fetches for the active provider's base URL.
  const fetchWindow = async () => {
    setFetchingWindow(true);
    setWindowNote(null);
    try {
      const dto = await actions.loadProviderModels(true);
      const model = dto?.models.find((m) => m.id === selectedModel.trim());
      if (model?.context_window_tokens != null) {
        setWindowTokens(String(model.context_window_tokens));
        setWindowNote("已获取；保留则作为显式值优先生效，清空则交给自动解析。");
      } else {
        setWindowNote(
          dto
            ? "接口与社区库均未报告该模型窗口，请手填。"
            : "刷新失败：网关不可达或密钥未配置。",
        );
      }
    } finally {
      setFetchingWindow(false);
    }
  };

  // The fetched model list belongs to the *active* profile's base URL (the
  // core fetches `GET {base_url}/models for the active provider), so it only
  // applies while the form edits that same profile — preset and base URL both
  // matching. Otherwise the static preset list is the whole offer.
  const fetchedApplies =
    settings != null &&
    settings.active.id === providerId &&
    settings.active.base_url === baseUrl.trim();
  const fetchedModels = fetchedApplies ? (state.providerModels?.models ?? []) : [];
  const staticModels = modelsForProvider(preset).filter(
    (id) => !fetchedModels.some((m) => m.id === id),
  );
  const models: ProviderModelDto[] = [
    ...fetchedModels,
    ...staticModels.map((id) => ({
      id,
      context_window_tokens: null,
      max_output_tokens: null,
    })),
  ];
  // The explicit-window input is offered only when nothing resolves the
  // window for the selected model: no fetched metadata and no static preset
  // entry (the built-in registry covers those). Known models never need it,
  // and an unnecessary explicit window would override discovery.
  const selected = selectedModel.trim();
  const selectedWindowKnown =
    fetchedModels.some((m) => m.id === selected && m.context_window_tokens != null) ||
    modelsForProvider(preset).includes(selected);
  const keyResolved = providerId !== "" && connected.includes(providerId);

  return (
    <div className="modal-backdrop" onMouseDown={onClose}>
      <div
        className="modal-card provider-modal"
        role="dialog"
        aria-label="Provider 设置"
        onMouseDown={(e) => e.stopPropagation()}
      >
        <h3>
          <Icon name="sparkles" size={16} />
          Provider 设置
        </h3>
        {confirmingDelete ? (
          <div className="provider-confirm" role="alertdialog" aria-label="确认删除供应商">
            <p>
              确定删除供应商「{name || profileLabel({ name, preset })}」？密钥会保留在系统钥匙串中。
            </p>
            <div className="provider-confirm-actions">
              <button type="button" className="ghost" onClick={() => setConfirmingDelete(false)}>
                取消
              </button>
              <button type="button" className="primary danger" onClick={() => void deleteSelected()}>
                删除
              </button>
            </div>
          </div>
        ) : null}
        <div className="provider-modal-body">
          <section className="provider-modal-section">
            <div className="provider-modal-label">Provider</div>
            <div className="provider-presets" role="listbox" aria-label="Provider">
              {rows.map((row) => {
                const isConnected = connected.includes(row.id);
                const isSaved = saved.some((s) => s.id === row.id);
                const isCustom = providerKey(row.preset) === "custom";
                const label = isCustom
                  ? row.name || "（未命名）"
                  : providerLabel(providerKey(row.preset));
                const active = !creating && row.id === providerId;
                return (
                  <button
                    key={row.id}
                    type="button"
                    className={`provider-preset ${active ? "active" : ""}`}
                    role="option"
                    aria-selected={active}
                    onClick={() => selectRow(row)}
                  >
                    <span className="provider-preset-name">
                      {label}
                      {isSaved ? <span className="provider-tag">已配置</span> : null}
                    </span>
                    {active ? (
                      <Icon name="check" size={12} />
                    ) : isConnected ? (
                      <span className="provider-dot" title="密钥已就绪" />
                    ) : null}
                  </button>
                );
              })}
              <button
                type="button"
                className={`provider-preset provider-add ${creating ? "active" : ""}`}
                role="option"
                aria-selected={creating}
                onClick={startCreate}
              >
                <span className="provider-preset-name">＋ 添加自定义供应商</span>
                {creating ? <Icon name="check" size={12} /> : null}
              </button>
            </div>
          </section>
          <section className="provider-modal-section provider-form">
            {nameRequired ? (
              <label className="provider-field">
                <span className="provider-modal-label">
                  名称
                  <span className={`provider-key-status ${nameValid ? "ok" : ""}`}>
                    {nameValid ? "必填" : "必填：不能为空"}
                  </span>
                </span>
                <input
                  className="provider-name-input"
                  value={name}
                  onChange={(e) => setName(e.target.value)}
                  placeholder="例如：公司网关"
                  maxLength={64}
                  spellCheck={false}
                  aria-label="供应商名称"
                  aria-invalid={!nameValid}
                />
              </label>
            ) : null}
            <label className="provider-field">
              <span className="provider-modal-label">模型</span>
              {models.length > 0 ? (
                <span className="provider-key-row">
                  <select
                    className="provider-model-select"
                    value={models.some((m) => m.id === selectedModel) ? selectedModel : ""}
                    onChange={(e) => setSelectedModel(e.target.value)}
                    aria-label="模型"
                  >
                    {models.some((m) => m.id === selectedModel) ? null : (
                      <option value="">{selectedModel || "（自定义模型）"}</option>
                    )}
                    {models.map((m) => (
                      <option key={m.id} value={m.id} title={modelTitle(m)}>
                        {modelLabel(m)}
                      </option>
                    ))}
                  </select>
                  {fetchedApplies ? (
                    <button
                      type="button"
                      className="ghost provider-key-toggle"
                      disabled={loadingModels}
                      onClick={() => void refreshModels()}
                      title="从 Provider 接口与 models.dev 刷新模型列表"
                      aria-label="刷新模型列表"
                    >
                      <Icon name="refresh" size={12} />
                    </button>
                  ) : null}
                </span>
              ) : (
                <input
                  className="provider-model-input"
                  value={selectedModel}
                  onChange={(e) => setSelectedModel(e.target.value)}
                  placeholder="输入模型名（custom）"
                  aria-label="自定义模型名"
                />
              )}
            </label>
            {!selectedWindowKnown || windowTokens !== "" ? (
              <label className="provider-field">
                <span className="provider-modal-label">上下文窗口</span>
                <span className="provider-key-row">
                  <input
                    className="provider-model-input"
                    inputMode="numeric"
                    value={windowTokens}
                    onChange={(e) => {
                      setWindowTokens(e.target.value.replace(/[^0-9]/g, ""));
                      setWindowNote(null);
                    }}
                    placeholder="该模型窗口未知；填写显式 tokens（如 128000），留空保持自动"
                    aria-label="显式上下文窗口 tokens"
                  />
                  {fetchedApplies ? (
                    <button
                      type="button"
                      className="ghost provider-key-toggle"
                      disabled={fetchingWindow}
                      onClick={() => void fetchWindow()}
                      title="从 Provider 接口与 models.dev 获取该模型的窗口"
                      aria-label="获取上下文窗口"
                    >
                      <Icon name="refresh" size={12} />
                    </button>
                  ) : null}
                </span>
                <p className="provider-key-hint">
                  {windowNote ??
                    "接口与内置注册表均未报告该模型的窗口；显式值优先生效（4096–10000000）。"}
                </p>
              </label>
            ) : null}
            <label className="provider-field">
              <span className="provider-modal-label">Base URL</span>
              <input
                className="provider-url-input"
                value={baseUrl}
                onChange={(e) => setBaseUrl(e.target.value)}
                placeholder={defaultBaseUrl(preset) || "https://…"}
                spellCheck={false}
                aria-label="Base URL"
              />
            </label>
            <label className="provider-field">
              <span className="provider-modal-label">协议</span>
              <select
                className="provider-kind-select"
                value={kind}
                onChange={(e) => setKind(e.target.value)}
                aria-label="协议"
              >
                {PROVIDER_KINDS.map((k) => (
                  <option key={k.key} value={k.key}>
                    {k.label}
                  </option>
                ))}
              </select>
            </label>
            <label className="provider-field">
              <span className="provider-modal-label">
                API Key
                <span className={`provider-key-status ${keyResolved ? "ok" : ""}`}>
                  {keyResolved ? "已配置" : "未配置"}
                </span>
              </span>
              <span className="provider-key-row">
                <input
                  className="provider-key-input"
                  type={showKey ? "text" : "password"}
                  value={apiKey}
                  onChange={(e) => setApiKey(e.target.value)}
                  placeholder={keyResolved ? "留空保持现有密钥" : "输入 API Key"}
                  spellCheck={false}
                  autoComplete="off"
                  aria-label="API Key"
                />
                <button
                  type="button"
                  className="ghost provider-key-toggle"
                  onClick={() => setShowKey((v) => !v)}
                  title={showKey ? "隐藏" : "显示"}
                  aria-label={showKey ? "隐藏密钥" : "显示密钥"}
                >
                  <Icon name={showKey ? "x" : "search"} size={12} />
                </button>
              </span>
            </label>
            <p className="provider-key-hint">
              密钥仅写入系统钥匙串（或环境变量），不会出现在配置文件、日志或任何响应中。
            </p>
          </section>
        </div>
        {state.lastError ? <p className="provider-form-error">{state.lastError}</p> : null}
        <div className="provider-modal-actions">
          {!creating && providerId ? (
            <button
              type="button"
              className="ghost provider-delete"
              disabled={saving}
              onClick={() => setConfirmingDelete(true)}
            >
              <Icon name="x" size={12} /> 删除
            </button>
          ) : (
            <span />
          )}
          <button type="button" className="ghost" onClick={onClose}>
            取消
          </button>
          <button
            type="button"
            className="primary"
            disabled={!canApply}
            title={nameValid ? undefined : "请输入供应商名称"}
            onClick={() => void apply()}
          >
            {saving ? "应用中…" : "应用"}
          </button>
        </div>
      </div>
    </div>
  );
}
