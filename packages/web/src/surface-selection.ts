import type { BuildWorkbenchSnapshot } from "./api";

export type ReaderSurface = "reader" | "workbench";
export type AppSurface = ReaderSurface | "loading";

const STORAGE_PREFIX = "understand-book:surface:";

function storageKey(bookId: string): string {
  return `${STORAGE_PREFIX}${encodeURIComponent(bookId)}`;
}

export function workbenchAvailable(snapshot: BuildWorkbenchSnapshot | null): boolean {
  return snapshot?.input.manifest !== null && snapshot?.input.manifest !== undefined;
}

export function workbenchControlPending(snapshot: BuildWorkbenchSnapshot): boolean {
  return snapshot.jobs
    .filter((job) => job.status !== "stale_input")
    .some((job) => job.status === "running" || job.status === "needs_user" || job.status === "interrupted");
}

export function chooseAppSurface(
  snapshot: BuildWorkbenchSnapshot,
  current: AppSurface,
  stored: ReaderSurface | null,
): ReaderSurface {
  if (!workbenchAvailable(snapshot)) return "reader";
  if (snapshot.readiness.route === "workbench" || workbenchControlPending(snapshot)) return "workbench";
  if (current === "workbench") return "workbench";
  return stored ?? "reader";
}

export function readSurfacePreference(storage: Pick<Storage, "getItem">, bookId: string): ReaderSurface | null {
  try {
    const value = storage.getItem(storageKey(bookId));
    return value === "reader" || value === "workbench" ? value : null;
  } catch {
    return null;
  }
}

export function writeSurfacePreference(
  storage: Pick<Storage, "setItem">,
  bookId: string,
  surface: ReaderSurface,
): void {
  try {
    storage.setItem(storageKey(bookId), surface);
  } catch {
    // Browser privacy settings may disable sessionStorage; navigation still works in memory.
  }
}
