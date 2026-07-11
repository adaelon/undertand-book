import type { BuildWorkbenchSnapshot } from "./api";

export type ReaderSurface = "reader" | "workbench";
export type AppSurface = ReaderSurface | "loading";

export function workbenchAvailable(snapshot: BuildWorkbenchSnapshot | null): boolean {
  return snapshot?.input.manifest !== null && snapshot?.input.manifest !== undefined;
}

export function chooseAppSurface(snapshot: BuildWorkbenchSnapshot): ReaderSurface {
  if (!workbenchAvailable(snapshot)) return "reader";
  return snapshot.readiness.route;
}
