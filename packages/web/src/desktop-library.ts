import type { DesktopStatus } from "./api";

export function desktopLibraryNeedsSelection(status: DesktopStatus | null): boolean {
  return Boolean(status?.desktop_host && !status.library_root_available);
}
