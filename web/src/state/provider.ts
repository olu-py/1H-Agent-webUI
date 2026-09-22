import type { ProviderModelsDto, ProviderSettingsDto } from "../types";
import type { UiState } from "./reducer";

export type ProviderAction =
  | { type: "providerSettings"; settings: ProviderSettingsDto }
  | { type: "providerModels"; models: ProviderModelsDto }
  | { type: "providerModelsCleared" };

export function reduceProvider(state: UiState, action: ProviderAction): UiState {
  switch (action.type) {
    case "providerSettings":
      return { ...state, providerSettings: action.settings };
    case "providerModels":
      return { ...state, providerModels: action.models };
    case "providerModelsCleared":
      return { ...state, providerModels: null };
  }
}
