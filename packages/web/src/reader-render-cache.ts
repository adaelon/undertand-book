export interface ReaderHtmlCacheScope {
  bookId: string;
  sourceFingerprint: string;
  rendererVersion: string;
  maxEntries: number;
}

export interface ReaderHtmlCacheInput {
  lid: string;
  text: string;
  kind: string;
}

export interface ReaderHtmlCacheSnapshot {
  scope: Omit<ReaderHtmlCacheScope, "maxEntries"> | null;
  entries: number;
  maxEntries: number;
  hits: number;
  misses: number;
  evictions: number;
  resets: number;
}

export interface ReaderRenderBatchOptions {
  batchSize?: number;
  shouldContinue?: () => boolean;
  yieldAfterLast?: boolean;
  yieldToMain?: () => Promise<void>;
}

interface ReaderHtmlCacheEntry {
  lid: string;
  text: string;
  kind: string;
  html: string;
}

function assertPositiveInteger(value: number, label: string): void {
  if (!Number.isInteger(value) || value <= 0) {
    throw new Error(`${label} must be a positive integer`);
  }
}

function yieldReaderRenderTask(): Promise<void> {
  const scheduler = (globalThis as typeof globalThis & {
    scheduler?: { yield?: () => Promise<void> };
  }).scheduler;
  if (scheduler?.yield) return scheduler.yield();
  return new Promise((resolve) => globalThis.setTimeout(resolve, 0));
}

/**
 * Run reader render work in bounded tasks so one hydrated window cannot
 * concentrate Markdown/KaTeX or DOM insertion in one edge-load completion.
 */
export async function runReaderRenderWorkInBatches<T>(
  inputs: readonly T[],
  work: (input: T) => void,
  options: ReaderRenderBatchOptions = {},
): Promise<boolean> {
  const batchSize = options.batchSize ?? 4;
  assertPositiveInteger(batchSize, "reader HTML prewarm batchSize");
  const shouldContinue = options.shouldContinue ?? (() => true);
  const yieldToMain = options.yieldToMain ?? yieldReaderRenderTask;

  for (let start = 0; start < inputs.length; start += batchSize) {
    if (!shouldContinue()) return false;
    const end = Math.min(inputs.length, start + batchSize);
    for (let index = start; index < end; index += 1) work(inputs[index]!);
    if (end < inputs.length || options.yieldAfterLast) await yieldToMain();
  }
  return shouldContinue();
}

function sameScope(
  left: Omit<ReaderHtmlCacheScope, "maxEntries"> | null,
  right: Omit<ReaderHtmlCacheScope, "maxEntries">,
): boolean {
  return left !== null
    && left.bookId === right.bookId
    && left.sourceFingerprint === right.sourceFingerprint
    && left.rendererVersion === right.rendererVersion;
}

/**
 * Source-scoped base HTML cache. Overlay state is intentionally absent from both
 * the key and the stored value; Highlight/Note/focus rendering stays outside it.
 */
export class ReaderSegmentHtmlCache {
  private scope: Omit<ReaderHtmlCacheScope, "maxEntries"> | null = null;
  private maxEntries = 1;
  private readonly entries = new Map<string, ReaderHtmlCacheEntry>();
  private hits = 0;
  private misses = 0;
  private evictions = 0;
  private resets = 0;

  configure(input: ReaderHtmlCacheScope): void {
    assertPositiveInteger(input.maxEntries, "reader HTML cache maxEntries");
    const nextScope = {
      bookId: input.bookId,
      sourceFingerprint: input.sourceFingerprint,
      rendererVersion: input.rendererVersion,
    };
    if (!sameScope(this.scope, nextScope)) {
      this.entries.clear();
      this.scope = nextScope;
      this.resets += 1;
    }
    this.maxEntries = input.maxEntries;
    this.trimToLimit();
  }

  clear(): void {
    if (this.entries.size > 0 || this.scope !== null) this.resets += 1;
    this.entries.clear();
    this.scope = null;
  }

  render(input: ReaderHtmlCacheInput, renderer: () => string): string {
    if (!this.scope) throw new Error("reader HTML cache must be configured before rendering");
    const previous = this.entries.get(input.lid);
    if (previous && previous.text === input.text && previous.kind === input.kind) {
      this.entries.delete(input.lid);
      this.entries.set(input.lid, previous);
      this.hits += 1;
      return previous.html;
    }

    this.misses += 1;
    const html = renderer();
    this.entries.delete(input.lid);
    this.entries.set(input.lid, { ...input, html });
    this.trimToLimit();
    return html;
  }

  private trimToLimit(): void {
    while (this.entries.size > this.maxEntries) {
      const oldest = this.entries.keys().next().value as string | undefined;
      if (oldest === undefined) return;
      this.entries.delete(oldest);
      this.evictions += 1;
    }
  }

  snapshot(): ReaderHtmlCacheSnapshot {
    return {
      scope: this.scope ? { ...this.scope } : null,
      entries: this.entries.size,
      maxEntries: this.maxEntries,
      hits: this.hits,
      misses: this.misses,
      evictions: this.evictions,
      resets: this.resets,
    };
  }
}
