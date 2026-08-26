import { providerKey, providerLabel } from "../lib/providers";
import { Icon } from "./icons";

/**
 * Provider / model switcher trigger pinned to the composer's bottom-right.
 *
 * A compact button showing the current provider·model; clicking opens the
 * app-level `ProviderSettingsModal` (via `onOpen`, owned by `App` so the
 * command palette's "Provider 设置" entry reaches the same dialog). The
 * snapshot's provider may arrive as the preset label; `providerKey`
 * normalizes it so the trigger always shows the registry label.
 */
export function ProviderSwitcher({
  provider,
  model,
  onOpen,
}: {
  provider: string;
  model: string;
  onOpen: () => void;
}) {
  const label = providerLabel(providerKey(provider));

  return (
    <div className="provider-switcher">
      <button
        type="button"
        className="provider-btn"
        onClick={onOpen}
        aria-haspopup="dialog"
        title={`切换 Provider 与模型（当前 ${label} · ${model || "未设置"}）`}
      >
        <Icon name="sparkles" size={12} />
        <span className="provider-btn-text">
          {label} · {model || "未设置"}
        </span>
        <Icon name="chevronDown" size={12} />
      </button>
    </div>
  );
}
