import type { BuildWorkbenchSnapshot } from "./api";

export type ReaderSurface = "reader" | "workbench" | "waiting-materials";
export type AppSurface = ReaderSurface | "loading";

export function workbenchAvailable(snapshot: BuildWorkbenchSnapshot | null): boolean {
  return snapshot?.input.manifest !== null && snapshot?.input.manifest !== undefined;
}

export function chooseAppSurface(snapshot: BuildWorkbenchSnapshot, readerOnly = false): ReaderSurface {
  if (readerOnly) return snapshot.readiness.route === "reader" ? "reader" : "waiting-materials";
  if (!workbenchAvailable(snapshot)) return "reader";
  return snapshot.readiness.route;
}
