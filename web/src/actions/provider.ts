import type { ProviderModelsDto, ProviderSetOptions } from "../types";
import type { Transport } from "../transport/transport";
import type { Store } from "../state/store";
import { errorMessage } from "./shared";

export function createProviderActions(
  transport: Transport,
  store: Store,
  refreshSnapshot: () => Promise<void>,
) {
  const setProvider = async (
    preset: string,
    model: string,
    options?: ProviderSetOptions,
  ): Promise<void> => {
    try {
      await transport.setProvider(preset, model, options);
      // The old provider's model cache must not flash as the new provider's
      // list while the next switcher open reloads the authoritative cache.
      store.dispatch({ type: "providerModelsCleared" });
      await refreshSnapshot();
      // Refresh the settings view too: `connected` may have changed (a newly
      // stored key) and the dialog reads from this slice - including the id
      // the core minted for a just-created custom provider. A failure here
      // must not look like a failed apply: the edit itself succeeded.
      try {
        const settings = await transport.providerSettings();
        store.dispatch({ type: "providerSettings", settings });
      } catch {
        // best-effort: the next dialog open refetches
      }
    } catch (error) {
      store.dispatch({ type: "error", message: errorMessage(error) });
    }
  };

  const removeProvider = async (id: string): Promise<void> => {
    try {
      await transport.removeProvider(id);
      store.dispatch({ type: "providerModelsCleared" });
      // Refresh both views: the active provider may have fallen back to
      // another profile, and the deleted row must disappear from the list.
      await refreshSnapshot();
      try {
        const settings = await transport.providerSettings();
        store.dispatch({ type: "providerSettings", settings });
      } catch {
        // best-effort: the next dialog open refetches
      }
    } catch (error) {
      store.dispatch({ type: "error", message: errorMessage(error) });
    }
  };

  const loadProviderSettings = async (): Promise<void> => {
    try {
      const settings = await transport.providerSettings();
      store.dispatch({ type: "providerSettings", settings });
    } catch (error) {
      store.dispatch({ type: "error", message: errorMessage(error) });
    }
  };

  const loadProviderModels = async (
    refresh = false,
  ): Promise<ProviderModelsDto | null> => {
    try {
      const models = await transport.providerModels(refresh);
      store.dispatch({ type: "providerModels", models });
      return models;
    } catch {
      // Best effort by design: the picker falls back to the previously
      // cached list and the static preset lists. A failing gateway must not
      // block the settings dialog. Returns null so focused callers (the
      // fetch-window button) can surface "not reported" without a store error.
      return null;
    }
  };
  return { setProvider, removeProvider, loadProviderSettings, loadProviderModels };
}
