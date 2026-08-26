import { describe, expect, it } from "vitest";
import { PROVIDERS, modelsForProvider, providerKey, providerLabel } from "../src/lib/providers";

describe("PROVIDERS", () => {
  it("mirrors the core ProviderPreset order (openai, deepseek, qwen, volcano, custom)", () => {
    expect(PROVIDERS.map((p) => p.key)).toEqual([
      "openai",
      "deepseek",
      "qwen",
      "volcano",
      "custom",
    ]);
  });

  it("gives every preset a display label", () => {
    for (const p of PROVIDERS) {
      expect(p.label.length).toBeGreaterThan(0);
    }
  });

  it("offers at least one selectable model for every preset except custom", () => {
    for (const p of PROVIDERS) {
      if (p.key === "custom") {
        expect(p.models).toEqual([]);
      } else {
        expect(p.models.length).toBeGreaterThan(0);
      }
    }
  });

  it("resolves labels and models by key and tolerates unknown keys", () => {
    expect(providerLabel("deepseek")).toBe("DeepSeek");
    expect(providerLabel("nope")).toBe("nope");
    expect(modelsForProvider("qwen")).toContain("qwen-plus");
    expect(modelsForProvider("custom")).toEqual([]);
    expect(modelsForProvider("nope")).toEqual([]);
  });

  it("normalizes snapshot labels back to registry keys", () => {
    // The v2 snapshot reports the preset label ("DeepSeek") while
    // setProvider expects the key ("deepseek").
    expect(providerKey("deepseek")).toBe("deepseek");
    expect(providerKey("DeepSeek")).toBe("deepseek");
    expect(providerKey("openai")).toBe("openai");
    expect(providerKey("OpenAI")).toBe("openai");
    expect(providerKey("Volcano Ark")).toBe("volcano");
    expect(providerKey("Custom compatible")).toBe("custom");
  });

  it("passes custom/unknown providers through unchanged", () => {
    expect(providerKey("custom")).toBe("custom");
    expect(providerKey("nope")).toBe("nope");
    expect(providerKey("")).toBe("");
  });
});
