import { useEffect, useRef, useState } from "react";
import type { ChatActions } from "../hooks";
import type { UiState } from "../state/reducer";
import {
  PROVIDER_KINDS,
  PROVIDERS,
  defaultBaseUrl,
  modelsForProvider,
  providerKey,
} from "../lib/providers";
import { Icon } from "./icons";

/**
 * Provider settings dialog, rendered at the app level (like the approval
 * modal) so every entry point can open it: the composer's switcher trigger
 * and the command palette's "Provider 设置" entry.
 *
 * The form edits the active profile (preset / model / base URL / protocol)
 * plus an optional API key. The key is write-only: applying stores it in the
 * OS keyring (via the core's secrets module) and it is never echoed back -
 * the dialog can only show whether a key is currently resolved. Presets with
 * a resolved key carry a dot in the picker.
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

  const [preset, setPreset] = useState(() =>
    providerKey(settings?.active.preset ?? state.provider),
  );
  const [selectedModel, setSelectedModel] = useState(settings?.active.model ?? state.model);
  const [baseUrl, setBaseUrl] = useState(settings?.active.base_url ?? "");
  const [kind, setKind] = useState(settings?.active.kind ?? "responses");
  const [apiKey, setApiKey] = useState("");
  const [showKey, setShowKey] = useState(false);
  const [saving, setSaving] = useState(false);

  // Load the settings view whenever the dialog opens.
  useEffect(() => {
    void actions.loadProviderSettings();
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
    setPreset(providerKey(settings.active.preset));
    setSelectedModel(settings.active.model);
    setBaseUrl(settings.active.base_url);
    setKind(settings.active.kind);
  }, [settings]);

  // Close on Escape; clicking the backdrop closes (modal-card stops it).
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [onClose]);

  const choosePreset = (key: string) => {
    setPreset(key);
    // Seed the form from the preset's saved profile when one exists, else
    // from the preset template (same semantics as the core-side merge).
    const savedProfile = saved.find((p) => p.preset === key);
    setBaseUrl(savedProfile?.base_url ?? defaultBaseUrl(key));
    setKind(savedProfile?.kind ?? "responses");
    const models = modelsForProvider(key);
    if (!models.includes(selectedModel)) {
      setSelectedModel(savedProfile?.model ?? models[0] ?? "");
    }
  };

  const apply = async () => {
    const model = selectedModel.trim();
    if (!model) return;
    setSaving(true);
    try {
      await actions.setProvider(preset, model, {
        baseUrl: baseUrl.trim(),
        kind,
        apiKey: apiKey.trim() || undefined,
      });
      setApiKey("");
      onClose();
    } finally {
      setSaving(false);
    }
  };

  const models = modelsForProvider(preset);
  const keyResolved = connected.includes(preset);

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
        <div className="provider-modal-body">
          <section className="provider-modal-section">
            <div className="provider-modal-label">Provider</div>
            <div className="provider-presets" role="listbox" aria-label="Provider">
              {PROVIDERS.map((p) => {
                const isConnected = connected.includes(p.key);
                const isSaved = saved.some((s) => s.preset === p.key);
                return (
                  <button
                    key={p.key}
                    type="button"
                    className={`provider-preset ${p.key === preset ? "active" : ""}`}
                    role="option"
                    aria-selected={p.key === preset}
                    onClick={() => choosePreset(p.key)}
                  >
                    <span className="provider-preset-name">
                      {p.label}
                      {isSaved ? <span className="provider-tag">已配置</span> : null}
                    </span>
                    {p.key === preset ? (
                      <Icon name="check" size={12} />
                    ) : isConnected ? (
                      <span className="provider-dot" title="密钥已就绪" />
                    ) : null}
                  </button>
                );
              })}
            </div>
          </section>
          <section className="provider-modal-section provider-form">
            <label className="provider-field">
              <span className="provider-modal-label">模型</span>
              {models.length > 0 ? (
                <select
                  className="provider-model-select"
                  value={models.includes(selectedModel) ? selectedModel : ""}
                  onChange={(e) => setSelectedModel(e.target.value)}
                  aria-label="模型"
                >
                  {models.includes(selectedModel) ? null : (
                    <option value="">{selectedModel || "（自定义模型）"}</option>
                  )}
                  {models.map((m) => (
                    <option key={m} value={m}>
                      {m}
                    </option>
                  ))}
                </select>
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
          <button type="button" className="ghost" onClick={onClose}>
            取消
          </button>
          <button
            type="button"
            className="primary"
            disabled={saving || !selectedModel.trim()}
            onClick={() => void apply()}
          >
            {saving ? "应用中…" : "应用"}
          </button>
        </div>
      </div>
    </div>
  );
}
