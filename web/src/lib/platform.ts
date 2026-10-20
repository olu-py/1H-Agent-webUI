/** Platform-aware label for the primary shortcut modifier. The WebUI runs on
 * macOS, Windows and Linux; showing both "Ctrl" and "⌘" in one hint is noise
 * on every platform. */
export function isMacPlatform(): boolean {
  if (typeof navigator === "undefined") return false;
  const nav = navigator as Navigator & { userAgentData?: { platform?: string } };
  const platform = nav.userAgentData?.platform || nav.platform || nav.userAgent;
  return /mac|iphone|ipad|ipod/i.test(platform);
}

/** The modifier key label to render in a keyboard hint. */
export function primaryModifier(): string {
  return isMacPlatform() ? "⌘" : "Ctrl";
}
