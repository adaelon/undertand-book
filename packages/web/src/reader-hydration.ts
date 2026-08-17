import type { FormulaSemantics } from "../../core/src/generated/FormulaSemantics";
import type { FormulaSemanticsRangeReply } from "./generated/FormulaSemanticsRangeReply";
import type { ManifestNode } from "./generated/ManifestNode";
import { splitUtf16Range, type TextRangeReply } from "./reader-text-range";

const SETTLED_WINDOW_MULTIPLIER = 5;

export interface ReaderHydrationApi {
  textRange: (
    startLid: string,
    endLid: string,
    signal: AbortSignal,
  ) => Promise<TextRangeReply>;
  formulaRange: (
    startLid: string,
    endLid: string,
    signal: AbortSignal,
  ) => Promise<FormulaSemanticsRangeReply>;
}

export interface ReaderHydrationSource {
  identity: string;
  leaves: readonly ManifestNode[];
  windowSize: number;
}

export interface HydratedReaderContent {
  lid: string;
  text: string;
  formula: FormulaSemantics | null;
}

export interface ReaderHydrationDebugSnapshot {
  sourceIdentity: string | null;
  epoch: number;
  capacity: number;
  textSettledLids: string[];
  formulaSettledLids: string[];
  textInFlightLids: string[];
  formulaInFlightLids: string[];
}

export class ReaderHydrationStaleError extends Error {
  constructor() {
    super("Reader hydration response belongs to a stale epoch");
    this.name = "ReaderHydrationStaleError";
  }
}

export function isReaderHydrationCancellation(error: unknown): boolean {
  return error instanceof ReaderHydrationStaleError
    || (error instanceof DOMException && error.name === "AbortError")
    || (error instanceof Error && error.name === "AbortError");
}

export function batchedHydrationV1Enabled(
  search: string,
  environmentValue: string | undefined,
): boolean {
  const query = new URLSearchParams(search).get("batched_hydration_v1");
  if (query === "1" || query === "true") return true;
  if (query === "0" || query === "false") return false;
  return environmentValue !== "0" && environmentValue !== "false";
}

class LruCache<V> {
  private readonly entries = new Map<string, V>();
  private capacityValue = 1;

  get capacity(): number {
    return this.capacityValue;
  }

  resize(capacity: number): void {
    this.capacityValue = capacity;
    this.trim();
  }

  has(key: string): boolean {
    return this.entries.has(key);
  }

  get(key: string): V | undefined {
    if (!this.entries.has(key)) return undefined;
    const value = this.entries.get(key)!;
    this.entries.delete(key);
    this.entries.set(key, value);
    return value;
  }

  set(key: string, value: V): void {
    this.entries.delete(key);
    this.entries.set(key, value);
    this.trim();
  }

  clear(): void {
    this.entries.clear();
  }

  keys(): string[] {
    return [...this.entries.keys()];
  }

  private trim(): void {
    while (this.entries.size > this.capacityValue) {
      const oldest = this.entries.keys().next().value;
      if (oldest === undefined) return;
      this.entries.delete(oldest);
    }
  }
}

function windowCapacity(windowSize: number): number {
  if (!Number.isSafeInteger(windowSize) || windowSize <= 0) {
    throw new Error("reader hydration window size must be a positive integer");
  }
  return SETTLED_WINDOW_MULTIPLIER * windowSize;
}

function validateSourceLeaves(leaves: readonly ManifestNode[]): string {
  if (leaves.length === 0) throw new Error("reader hydration source has no leaves");
  const seen = new Set<string>();
  let previous: ManifestNode | null = null;
  const signature: string[] = [];
  for (const leaf of leaves) {
    if (!leaf.lid || seen.has(leaf.lid)) {
      throw new Error(`reader hydration source has an empty or duplicate LID: ${leaf.lid}`);
    }
    if (leaf.children.length !== 0) {
      throw new Error(`reader hydration source contains a non-leaf node: ${leaf.lid}`);
    }
    if (
      !Number.isSafeInteger(leaf.span.start)
      || !Number.isSafeInteger(leaf.span.end)
      || leaf.span.start < 0
      || leaf.span.start >= leaf.span.end
    ) {
      throw new Error(`reader hydration source has an invalid span for ${leaf.lid}`);
    }
    if (previous && previous.span.end > leaf.span.start) {
      throw new Error(`reader hydration source overlaps or reverses at ${leaf.lid}`);
    }
    seen.add(leaf.lid);
    signature.push(`${leaf.lid}:${leaf.kind}:${leaf.span.start}:${leaf.span.end}`);
    previous = leaf;
  }
  return signature.join("|");
}

export class ReaderHydrator {
  private sourceIdentity: string | null = null;
  private sourceSignature: string | null = null;
  private leaves: readonly ManifestNode[] = [];
  private leafByLid = new Map<string, ManifestNode>();
  private leafIndexByLid = new Map<string, number>();
  private epochValue = 0;
  private readonly textSettled = new LruCache<string>();
  private readonly formulaSettled = new LruCache<FormulaSemantics | null>();
  private readonly textInFlight = new Map<string, Promise<void>>();
  private readonly formulaInFlight = new Map<string, Promise<void>>();
  private readonly controllers = new Set<AbortController>();

  constructor(private readonly api: ReaderHydrationApi) {}

  setSource(source: ReaderHydrationSource): void {
    if (!source.identity) throw new Error("reader hydration source identity is empty");
    const signature = validateSourceLeaves(source.leaves);
    const capacity = windowCapacity(source.windowSize);
    if (source.identity === this.sourceIdentity && signature === this.sourceSignature) {
      this.resizeSettled(capacity);
      return;
    }

    this.invalidatePending();
    this.textSettled.clear();
    this.formulaSettled.clear();
    this.sourceIdentity = source.identity;
    this.sourceSignature = signature;
    this.leaves = [...source.leaves];
    this.leafByLid = new Map(this.leaves.map((leaf) => [leaf.lid, leaf]));
    this.leafIndexByLid = new Map(this.leaves.map((leaf, index) => [leaf.lid, index]));
    this.resizeSettled(capacity);
  }

  clearSource(): void {
    this.invalidatePending();
    this.textSettled.clear();
    this.formulaSettled.clear();
    this.sourceIdentity = null;
    this.sourceSignature = null;
    this.leaves = [];
    this.leafByLid.clear();
    this.leafIndexByLid.clear();
  }

  invalidatePending(): void {
    this.epochValue += 1;
    const active = [...this.controllers];
    this.controllers.clear();
    this.textInFlight.clear();
    this.formulaInFlight.clear();
    for (const controller of active) controller.abort();
  }

  async hydrate(lids: readonly string[], windowSize?: number): Promise<HydratedReaderContent[]> {
    if (this.sourceIdentity === null) throw new Error("reader hydration source is not configured");
    if (windowSize !== undefined) this.resizeSettled(windowCapacity(windowSize));
    if (lids.length === 0) return [];
    const requestedLeaves = this.requestedLeaves(lids);
    if (requestedLeaves.length > this.textSettled.capacity) {
      throw new Error("reader hydration request exceeds the five-window settled-cache bound");
    }
    const epoch = this.epochValue;

    await Promise.all([
      this.ensureTexts(requestedLeaves, epoch),
      this.ensureFormulas(requestedLeaves, epoch),
    ]);
    this.assertCurrent(epoch);

    return requestedLeaves.map((leaf) => {
      const text = this.textSettled.get(leaf.lid);
      if (text === undefined) {
        throw new Error(`reader hydration completed without text for ${leaf.lid}`);
      }
      let formula: FormulaSemantics | null = null;
      if (leaf.kind === "formula") {
        if (!this.formulaSettled.has(leaf.lid)) {
          throw new Error(`reader hydration completed without formula state for ${leaf.lid}`);
        }
        formula = this.formulaSettled.get(leaf.lid) ?? null;
      }
      return { lid: leaf.lid, text, formula };
    });
  }

  debugSnapshot(): ReaderHydrationDebugSnapshot {
    return {
      sourceIdentity: this.sourceIdentity,
      epoch: this.epochValue,
      capacity: this.textSettled.capacity,
      textSettledLids: this.textSettled.keys(),
      formulaSettledLids: this.formulaSettled.keys(),
      textInFlightLids: [...this.textInFlight.keys()],
      formulaInFlightLids: [...this.formulaInFlight.keys()],
    };
  }

  private resizeSettled(capacity: number): void {
    this.textSettled.resize(capacity);
    this.formulaSettled.resize(capacity);
  }

  private requestedLeaves(lids: readonly string[]): ManifestNode[] {
    const requested: ManifestNode[] = [];
    let previousIndex = -1;
    const seen = new Set<string>();
    for (const lid of lids) {
      const leaf = this.leafByLid.get(lid);
      const index = this.leafIndexByLid.get(lid);
      if (!leaf || index === undefined) {
        throw new Error(`reader hydration requested an unknown leaf LID: ${lid}`);
      }
      if (seen.has(lid)) throw new Error(`reader hydration requested duplicate LID: ${lid}`);
      if (index <= previousIndex) {
        throw new Error("reader hydration LIDs must follow canonical leaf order");
      }
      seen.add(lid);
      requested.push(leaf);
      previousIndex = index;
    }
    return requested;
  }

  private consecutiveGroups(leaves: readonly ManifestNode[]): ManifestNode[][] {
    const groups: ManifestNode[][] = [];
    let current: ManifestNode[] = [];
    let previousIndex = -2;
    for (const leaf of leaves) {
      const index = this.leafIndexByLid.get(leaf.lid)!;
      if (current.length > 0 && index !== previousIndex + 1) {
        groups.push(current);
        current = [];
      }
      current.push(leaf);
      previousIndex = index;
    }
    if (current.length > 0) groups.push(current);
    return groups;
  }

  private async ensureTexts(leaves: readonly ManifestNode[], epoch: number): Promise<void> {
    this.assertCurrent(epoch);
    const pending = new Set<Promise<void>>();
    const missing: ManifestNode[] = [];
    for (const leaf of leaves) {
      if (this.textSettled.has(leaf.lid)) {
        this.textSettled.get(leaf.lid);
        continue;
      }
      const inFlight = this.textInFlight.get(leaf.lid);
      if (inFlight) pending.add(inFlight);
      else missing.push(leaf);
    }
    for (const group of this.consecutiveGroups(missing)) {
      pending.add(this.requestTextRange(group, epoch));
    }
    await Promise.all(pending);
    this.assertCurrent(epoch);
  }

  private requestTextRange(group: readonly ManifestNode[], epoch: number): Promise<void> {
    const first = group[0]!;
    const last = group[group.length - 1]!;
    const controller = new AbortController();
    this.controllers.add(controller);
    let task!: Promise<void>;
    task = Promise.resolve()
      .then(() => {
        this.assertRequestCurrent(epoch, controller);
        return this.api.textRange(first.lid, last.lid, controller.signal);
      })
      .then((reply) => {
        this.assertRequestCurrent(epoch, controller);
        const split = splitUtf16Range(reply, group);
        this.assertRequestCurrent(epoch, controller);
        for (const leaf of group) {
          const text = split.get(leaf.lid);
          if (text === undefined) throw new Error(`text range omitted ${leaf.lid}`);
          this.textSettled.set(leaf.lid, text);
        }
      })
      .catch((error: unknown) => this.rethrowRequestError(error, epoch, controller))
      .finally(() => {
        this.controllers.delete(controller);
        for (const leaf of group) {
          if (this.textInFlight.get(leaf.lid) === task) this.textInFlight.delete(leaf.lid);
        }
      });
    for (const leaf of group) this.textInFlight.set(leaf.lid, task);
    return task;
  }

  private async ensureFormulas(leaves: readonly ManifestNode[], epoch: number): Promise<void> {
    this.assertCurrent(epoch);
    const pending = new Set<Promise<void>>();
    for (const run of this.consecutiveGroups(leaves)) {
      let missingGroup: ManifestNode[] = [];
      const flush = () => {
        if (missingGroup.length > 0) {
          pending.add(this.requestFormulaRange(missingGroup, epoch));
          missingGroup = [];
        }
      };
      for (const leaf of run) {
        if (leaf.kind !== "formula") continue;
        if (this.formulaSettled.has(leaf.lid)) {
          this.formulaSettled.get(leaf.lid);
          flush();
          continue;
        }
        const inFlight = this.formulaInFlight.get(leaf.lid);
        if (inFlight) {
          flush();
          pending.add(inFlight);
          continue;
        }
        missingGroup.push(leaf);
      }
      flush();
    }
    await Promise.all(pending);
    this.assertCurrent(epoch);
  }

  private requestFormulaRange(group: readonly ManifestNode[], epoch: number): Promise<void> {
    const first = group[0]!;
    const last = group[group.length - 1]!;
    const firstIndex = this.leafIndexByLid.get(first.lid)!;
    const lastIndex = this.leafIndexByLid.get(last.lid)!;
    const rangeLeaves = this.leaves.slice(firstIndex, lastIndex + 1);
    const controller = new AbortController();
    this.controllers.add(controller);
    let task!: Promise<void>;
    task = Promise.resolve()
      .then(() => {
        this.assertRequestCurrent(epoch, controller);
        return this.api.formulaRange(first.lid, last.lid, controller.signal);
      })
      .then((reply) => {
        this.assertRequestCurrent(epoch, controller);
        const returned = this.validateFormulaReply(reply, first, last, rangeLeaves);
        this.assertRequestCurrent(epoch, controller);
        for (const leaf of group) {
          this.formulaSettled.set(leaf.lid, returned.get(leaf.lid) ?? null);
        }
      })
      .catch((error: unknown) => this.rethrowRequestError(error, epoch, controller))
      .finally(() => {
        this.controllers.delete(controller);
        for (const leaf of group) {
          if (this.formulaInFlight.get(leaf.lid) === task) this.formulaInFlight.delete(leaf.lid);
        }
      });
    for (const leaf of group) this.formulaInFlight.set(leaf.lid, task);
    return task;
  }

  private validateFormulaReply(
    reply: FormulaSemanticsRangeReply,
    first: ManifestNode,
    last: ManifestNode,
    rangeLeaves: readonly ManifestNode[],
  ): Map<string, FormulaSemantics> {
    if (reply.start_lid !== first.lid || reply.end_lid !== last.lid) {
      throw new Error("formula range response identity does not match the request");
    }
    const rangeByLid = new Map(rangeLeaves.map((leaf, index) => [leaf.lid, { leaf, index }]));
    const returned = new Map<string, FormulaSemantics>();
    let previousIndex = -1;
    for (const item of reply.items) {
      const entry = rangeByLid.get(item.formula_lid);
      if (!entry || entry.leaf.kind !== "formula") {
        throw new Error(`formula range returned an out-of-range identity: ${item.formula_lid}`);
      }
      if (item.composition.source_lid !== item.formula_lid) {
        throw new Error(`formula range returned a mismatched composition identity: ${item.formula_lid}`);
      }
      if (entry.index <= previousIndex || returned.has(item.formula_lid)) {
        throw new Error("formula range response is out of order or duplicated");
      }
      returned.set(item.formula_lid, item);
      previousIndex = entry.index;
    }
    return returned;
  }

  private assertCurrent(epoch: number): void {
    if (epoch !== this.epochValue || this.sourceIdentity === null) {
      throw new ReaderHydrationStaleError();
    }
  }

  private assertRequestCurrent(epoch: number, controller: AbortController): void {
    if (controller.signal.aborted) throw new ReaderHydrationStaleError();
    this.assertCurrent(epoch);
  }

  private rethrowRequestError(
    error: unknown,
    epoch: number,
    controller: AbortController,
  ): never {
    if (
      epoch !== this.epochValue
      || controller.signal.aborted
      || isReaderHydrationCancellation(error)
    ) {
      throw new ReaderHydrationStaleError();
    }
    throw error;
  }
}
