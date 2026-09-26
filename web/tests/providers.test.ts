import { describe, expect, it } from "vitest";
import type { ProviderModelDto, ProviderSettingsDto } from "../src/types";
import {
  PROVIDERS,
  buildProviderModelGroups,
  modelsForProvider,
  profileLabel,
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

describe("profileLabel", () => {
  it("prefers a custom provider's name", () => {
    expect(profileLabel({ name: "Gateway A", preset: "custom" })).toBe("Gateway A");
    expect(profileLabel({ name: "  Padded  ", preset: "custom" })).toBe("Padded");
  });

  it("falls back to the preset label for built-ins and unnamed profiles", () => {
    expect(profileLabel({ preset: "deepseek" })).toBe("DeepSeek");
    expect(profileLabel({ name: "", preset: "custom" })).toBe("Custom compatible");
    expect(profileLabel({ name: "   ", preset: "custom" })).toBe("Custom compatible");
  });
});

describe("buildProviderModelGroups", () => {
  const providerModels: ProviderModelDto[] = [
    { id: "gateway-model", context_window_tokens: 256000, max_output_tokens: 8192 },
    { id: "deepseek-v4-flash", context_window_tokens: 128000, max_output_tokens: 8192 },
  ];

  const settings: ProviderSettingsDto = {
    active: {
      id: "deepseek",
      preset: "deepseek",
      name: "",
      kind: "responses",
      model: "deepseek-v4-flash",
      base_url: "https://api.deepseek.com",
      enabled_models: [],
    },
    saved: [
      {
        id: "custom-aaaa",
        name: "Gateway A",
        preset: "custom",
        kind: "chat_completions",
        model: "my-compatible-model",
        base_url: "https://example.com/v1",
        enabled_models: [],
      },
      {
        // Two custom providers share the `custom` family but have distinct ids
        // and names - the group key must be the id, not the preset.
        id: "custom-bbbb",
        name: "Gateway B",
        preset: "custom",
        kind: "chat_completions",
        model: "second-model",
        base_url: "https://second.example.com/v1",
        enabled_models: [],
      },
      {
        id: "nope",
        name: "",
        preset: "nope",
        kind: "responses",
        model: "unknown-provider-model",
        base_url: "https://unknown.example.com/v1",
        enabled_models: [],
      },
    ],
    connected: ["qwen", "deepseek", "custom-aaaa", "custom-bbbb", "nope"],
  };

  it("groups only connected providers in registry order and preserves labels", () => {
    const groups = buildProviderModelGroups({
      settings,
      providerId: "deepseek",
      model: "deepseek-v4-flash",
      providerModels,
    });

    // Built-ins keep registry order; custom ids follow in core order.
    expect(groups.map((group) => group.key)).toEqual([
      "deepseek",
      "qwen",
      "custom-aaaa",
      "custom-bbbb",
      "nope",
    ]);
    expect(groups.map((group) => group.label)).toEqual([
      "DeepSeek",
      "Qwen / Bailian",
      "Gateway A",
      "Gateway B",
      "nope",
    ]);
    expect(groups.map((group) => group.preset)).toEqual([
      "deepseek",
      "qwen",
      "custom",
      "custom",
      "nope",
    ]);
    expect(groups.map((group) => group.key)).not.toContain("openai");
  });

  it("keys two custom providers on the same family as separate groups", () => {
    const groups = buildProviderModelGroups({
      settings,
      providerId: "custom-aaaa",
      model: "my-compatible-model",
      providerModels: null,
    });

    const gatewayA = groups.find((group) => group.key === "custom-aaaa");
    const gatewayB = groups.find((group) => group.key === "custom-bbbb");
    expect(gatewayA?.label).toBe("Gateway A");
    expect(gatewayB?.label).toBe("Gateway B");
    expect(gatewayA?.preset).toBe("custom");
    // Neither custom provider inherits the other's models.
    expect(gatewayA?.models).toEqual([{ id: "my-compatible-model" }]);
    expect(gatewayB?.models).toEqual([{ id: "second-model" }]);
  });

  it("merges dynamic active-provider models and preserves their metadata", () => {
    const [deepseek] = buildProviderModelGroups({
      settings,
      providerId: "deepseek",
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
      providerId: "deepseek",
      model: "deepseek-v4-flash",
      providerModels,
    });

    expect(groups.find((group) => group.key === "custom-aaaa")?.models).toEqual([
      { id: "my-compatible-model" },
    ]);
    expect(groups.find((group) => group.key === "nope")?.models).toEqual([
      { id: "unknown-provider-model" },
    ]);
  });

  it("uses the active provider id as a fallback before settings has loaded", () => {
    const groups = buildProviderModelGroups({
      settings: null,
      providerId: "deepseek",
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
      providerId: "openai",
      model: "gpt-5",
      providerModels: null,
    });

    expect(groups.map((group) => group.key)).toEqual(["deepseek"]);
  });
});
