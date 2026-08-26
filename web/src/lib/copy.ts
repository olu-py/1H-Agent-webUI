/** Clipboard helpers with a legacy fallback (no runtime dependencies). */

/** Copies text to the clipboard; falls back to a hidden textarea when the
 * async Clipboard API is unavailable or blocked. Returns success. */
export async function copyText(text: string): Promise<boolean> {
  try {
    if (navigator.clipboard?.writeText) {
      await navigator.clipboard.writeText(text);
      return true;
    }
  } catch {
    // fall through to the execCommand fallback (e.g. non-secure context)
  }
  try {
    const ta = document.createElement("textarea");
    ta.value = text;
    ta.setAttribute("readonly", "");
    ta.style.position = "fixed";
    ta.style.opacity = "0";
    document.body.appendChild(ta);
    ta.select();
    const ok = document.execCommand("copy");
    ta.remove();
    return ok;
  } catch {
    return false;
  }
}

/** Transient "已复制" feedback on a button element. */
export function flashCopied(button: HTMLElement, ok: boolean): void {
  const previous = button.textContent;
  if (!ok) {
    button.textContent = "失败";
    button.classList.add("failed");
  } else {
    button.textContent = "已复制";
    button.classList.add("copied");
  }
  window.setTimeout(() => {
    button.textContent = previous;
    button.classList.remove("copied", "failed");
  }, 1200);
}
