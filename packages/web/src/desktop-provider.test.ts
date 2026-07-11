import { describe, expect, it } from "vitest";
import { desktopProviderDraft, desktopProviderStatusLabel } from "./desktop-provider";

describe("desktop provider settings", () => {
  it("hydrates editable metadata without ever hydrating the API key", () => {
    expect(
      desktopProviderDraft({
        configured: true,
        source: "settings",
        mode: "react",
        base_url: "https://provider.example/v1",
        model: "model-a",
        api_key_configured: true,
      }),
    ).toEqual({
      mode: "react",
      baseUrl: "https://provider.example/v1",
      model: "model-a",
      apiKey: "",
    });
  });

  it("distinguishes saved, environment, and missing configuration", () => {
    expect(desktopProviderStatusLabel(null)).toBe("尚未检测");
    expect(
      desktopProviderStatusLabel({
        configured: false,
        source: "unconfigured",
        mode: "native",
        base_url: "",
        model: "",
        api_key_configured: false,
      }),
    ).toBe("尚未配置");
    expect(
      desktopProviderStatusLabel({
        configured: true,
        source: "environment",
        mode: "native",
        base_url: "https://provider.example/v1",
        model: "model-a",
        api_key_configured: true,
      }),
    ).toBe("使用环境配置");
  });
});
