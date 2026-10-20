/** Persisted width of the centered reading column. The drag handles live in
 * the gutters on both sides of the column; the width is shared by messages,
 * composer and status bar so their center line never drifts. */
export const READING_WIDTH_KEY = "1h-reading-width";
export const MIN_READING_WIDTH = 36 * 16;
export const MAX_READING_WIDTH = 64 * 16;
export const DEFAULT_READING_WIDTH = 48 * 16;

export function clampReadingWidth(width: number): number {
  return Math.max(MIN_READING_WIDTH, Math.min(MAX_READING_WIDTH, Math.round(width)));
}

export function readReadingWidth(): number {
  try {
    const stored = Number(localStorage.getItem(READING_WIDTH_KEY));
    return Number.isFinite(stored) && stored > 0 ? clampReadingWidth(stored) : DEFAULT_READING_WIDTH;
  } catch {
    return DEFAULT_READING_WIDTH;
  }
}

export function saveReadingWidth(width: number): void {
  try {
    localStorage.setItem(READING_WIDTH_KEY, String(clampReadingWidth(width)));
  } catch {
    // non-persistent session is fine
  }
}
