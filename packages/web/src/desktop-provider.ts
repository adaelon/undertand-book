export type DesktopProviderMode = "native" | "react";

export interface DesktopProviderStatus {
  configured: boolean;
  source: "settings" | "environment" | "unconfigured";
  mode: DesktopProviderMode;
  base_url: string;
  model: string;
  api_key_configured: boolean;
}

export interface DesktopProviderDraft {
  mode: DesktopProviderMode;
  baseUrl: string;
  model: string;
  apiKey: string;
}

export function desktopProviderDraft(status: DesktopProviderStatus): DesktopProviderDraft {
  return {
    mode: status.mode,
    baseUrl: status.base_url,
    model: status.model,
    apiKey: "",
  };
}

export function desktopProviderStatusLabel(status: DesktopProviderStatus | null): string {
  if (!status) return "尚未检测";
  if (!status.configured) return "尚未配置";
  return status.source === "settings" ? "已保存并应用" : "使用环境配置";
}
