import { describe, expect, it } from "vitest";
import type { ProviderModelDto, ProviderSettingsDto } from "../src/types";
import {
  PROVIDERS,
  buildProviderModelGroups,
  modelsForProvider,
  providerKey,
  providerLabel,
} from "../src/lib/providers";

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

describe("buildProviderModelGroups", () => {
  const providerModels: ProviderModelDto[] = [
    { id: "gateway-model", context_window_tokens: 256000, max_output_tokens: 8192 },
    { id: "deepseek-v4-flash", context_window_tokens: 128000, max_output_tokens: 8192 },
  ];

  const settings: ProviderSettingsDto = {
    active: {
      preset: "deepseek",
      kind: "responses",
      model: "deepseek-v4-flash",
      base_url: "https://api.deepseek.com",
    },
    saved: [
      {
        preset: "custom",
        kind: "chat_completions",
        model: "my-compatible-model",
        base_url: "https://example.com/v1",
      },
      {
        preset: "nope",
        kind: "responses",
        model: "unknown-provider-model",
        base_url: "https://unknown.example.com/v1",
      },
    ],
    connected: ["qwen", "deepseek", "custom", "nope"],
  };

  it("groups only connected providers in registry order and preserves labels", () => {
    const groups = buildProviderModelGroups({
      settings,
      provider: "deepseek",
      model: "deepseek-v4-flash",
      providerModels,
    });

    expect(groups.map((group) => group.key)).toEqual([
      "deepseek",
      "qwen",
      "custom",
      "nope",
    ]);
    expect(groups.map((group) => group.label)).toEqual([
      "DeepSeek",
      "Qwen / Bailian",
      "Custom compatible",
      "nope",
    ]);
    expect(groups.map((group) => group.key)).not.toContain("openai");
  });

  it("merges dynamic active-provider models and preserves their metadata", () => {
    const [deepseek] = buildProviderModelGroups({
      settings,
      provider: "deepseek",
      model: "deepseek-v4-flash",
      providerModels,
    });

    expect(deepseek.models.map((model) => model.id)).toEqual([
      "deepseek-v4-flash",
      "deepseek-v4-pro",
      "deepseek-chat",
      "deepseek-reasoner",
      "gateway-model",
    ]);
    expect(deepseek.models[0].context_window_tokens).toBe(128000);
    const gateway = deepseek.models.find((model) => model.id === "gateway-model");
    expect(gateway?.context_window_tokens).toBe(256000);
  });

  it("falls back to saved models for custom and unknown providers", () => {
    const groups = buildProviderModelGroups({
      settings,
      provider: "deepseek",
      model: "deepseek-v4-flash",
      providerModels,
    });

    expect(groups.find((group) => group.key === "custom")?.models).toEqual([
      { id: "my-compatible-model" },
    ]);
    expect(groups.find((group) => group.key === "nope")?.models).toEqual([
      { id: "unknown-provider-model" },
    ]);
  });

  it("uses the active provider as a fallback before settings has loaded", () => {
    const groups = buildProviderModelGroups({
      settings: null,
      provider: "DeepSeek",
      model: "deepseek-v4-flash",
      providerModels,
    });

    expect(groups).toHaveLength(1);
    expect(groups[0].key).toBe("deepseek");
    expect(groups[0].label).toBe("DeepSeek");
  });

  it("does not include the active provider when loaded settings marks it disconnected", () => {
    const groups = buildProviderModelGroups({
      settings: { ...settings, connected: ["deepseek"] },
      provider: "openai",
      model: "gpt-5",
      providerModels: null,
    });

    expect(groups.map((group) => group.key)).toEqual(["deepseek"]);
  });
});
