export type ReaderSurface = "markdown" | "pdf";

export interface ReaderSurfaceIdentity {
  bookId: string;
  sourceFingerprint: string;
}

const PREFIX = "understand-book:reader-surface:v1";

function preferenceKey(identity: ReaderSurfaceIdentity): string {
  return `${PREFIX}:${encodeURIComponent(identity.bookId)}:${encodeURIComponent(identity.sourceFingerprint)}`;
}

export function resolveReaderSurface(
  preference: ReaderSurface | null,
  pdfAvailable: boolean,
): ReaderSurface {
  if (!pdfAvailable) return "markdown";
  return preference ?? "pdf";
}

export function readReaderSurfacePreference(
  storage: Pick<Storage, "getItem">,
  identity: ReaderSurfaceIdentity,
): ReaderSurface | null {
  const stored = storage.getItem(preferenceKey(identity));
  return stored === "markdown" || stored === "pdf" ? stored : null;
}

export function writeReaderSurfacePreference(
  storage: Pick<Storage, "setItem">,
  identity: ReaderSurfaceIdentity,
  surface: ReaderSurface,
) {
  storage.setItem(preferenceKey(identity), surface);
}
