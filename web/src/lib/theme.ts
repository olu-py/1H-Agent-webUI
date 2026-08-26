/** Theme handling: a tri-state preference (auto/light/dark) resolved to a
 * concrete `data-theme` attribute on `<html>`, remembered in localStorage.
 * The pre-JS bootstrap in index.html applies the same resolution to avoid a
 * flash of the wrong theme. */

export type ThemePreference = "auto" | "light" | "dark";

export const THEME_STORAGE_KEY = "1h-theme";

export const THEME_CYCLE: ThemePreference[] = ["auto", "light", "dark"];

export function getThemePreference(): ThemePreference {
  try {
    const stored = localStorage.getItem(THEME_STORAGE_KEY);
    if (stored === "light" || stored === "dark" || stored === "auto") return stored;
  } catch {
    // localStorage unavailable (e.g. blocked); default to auto
  }
  return "auto";
}

/** Resolves a preference to the concrete theme currently in effect. */
export function resolveTheme(pref: ThemePreference): "light" | "dark" {
  if (pref !== "auto") return pref;
  if (typeof window !== "undefined" && window.matchMedia) {
    return window.matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light";
  }
  return "light";
}

/** Applies the preference: sets `data-theme` on `<html>` and persists it. */
export function applyTheme(pref: ThemePreference): void {
  document.documentElement.dataset.theme = resolveTheme(pref);
  try {
    localStorage.setItem(THEME_STORAGE_KEY, pref);
  } catch {
    // non-persistent session is fine
  }
}

/** Next preference when cycling the header button. */
export function nextTheme(pref: ThemePreference): ThemePreference {
  return THEME_CYCLE[(THEME_CYCLE.indexOf(pref) + 1) % THEME_CYCLE.length];
}
