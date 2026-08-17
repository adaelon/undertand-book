import type {
  ReaderBufferRange,
  ReaderBufferTransition,
} from "./reader-buffer";

export interface ReaderHeightLedgerIdentity {
  sourceFingerprint: string;
  leafOrder: readonly string[];
  layoutToken: string;
  rendererVersion: string;
  estimatedLeafHeightPx: number;
}

export interface ReaderHeightEntry {
  key: string;
  lids: readonly string[];
  startLeafIndex: number;
  endLeafIndex: number;
  blockHeightPx: number;
}

export interface ReaderHeightLedger {
  sourceFingerprint: string;
  leafOrder: readonly string[];
  layoutToken: string;
  rendererVersion: string;
  estimatedLeafHeightPx: number;
  entries: ReadonlyMap<string, ReaderHeightEntry>;
  itemKeyByLid: ReadonlyMap<string, string>;
  revision: number;
}

export interface ReaderItemHeightObservation {
  key: string;
  lids: readonly string[];
  blockHeightPx: number;
}

export interface ReaderItemHeightReceipt {
  ledger: ReaderHeightLedger;
  changed: boolean;
  previousHeightPx: number | null;
  deltaPx: number;
}

export interface ReaderSpacerTotals {
  topSpacerPx: number;
  bottomSpacerPx: number;
}

export interface ReaderSpacerDelta {
  topSpacerDeltaPx: number;
  bottomSpacerDeltaPx: number;
}

const HEIGHT_EPSILON_PX = 0.25;

function assertFiniteNonNegative(value: number, label: string): void {
  if (!Number.isFinite(value) || value < 0) {
    throw new Error(`${label} must be a finite non-negative number`);
  }
}

function assertRange(
  value: ReaderBufferRange,
  leafCount: number,
  label: string,
): void {
  if (
    !Number.isInteger(value[0])
    || !Number.isInteger(value[1])
    || value[0] < 0
    || value[1] < value[0]
    || value[1] > leafCount
  ) {
    throw new Error(`${label} must be a valid half-open leaf range`);
  }
}

function sameLeafOrder(left: readonly string[], right: readonly string[]): boolean {
  return left.length === right.length && left.every((lid, index) => lid === right[index]);
}

function assertUniqueLeafOrder(leafOrder: readonly string[]): void {
  const seen = new Set<string>();
  for (const lid of leafOrder) {
    if (seen.has(lid)) throw new Error(`leafOrder contains duplicate LID: ${lid}`);
    seen.add(lid);
  }
}

export function readerRenderItemKey(lids: readonly string[]): string {
  if (lids.length === 0) throw new Error("reader render item requires at least one LID");
  return JSON.stringify(lids);
}

function contiguousItemRange(
  leafOrder: readonly string[],
  lids: readonly string[],
): ReaderBufferRange {
  if (lids.length === 0) throw new Error("reader render item requires at least one LID");
  const startLeafIndex = leafOrder.indexOf(lids[0]);
  if (startLeafIndex < 0) throw new Error("render-item LIDs must exist in leafOrder");
  for (let index = 0; index < lids.length; index += 1) {
    if (leafOrder[startLeafIndex + index] !== lids[index]) {
      throw new Error("render-item LIDs must be one contiguous leafOrder slice");
    }
  }
  return [startLeafIndex, startLeafIndex + lids.length];
}

export function createReaderHeightLedger(
  input: ReaderHeightLedgerIdentity,
): ReaderHeightLedger {
  assertUniqueLeafOrder(input.leafOrder);
  assertFiniteNonNegative(input.estimatedLeafHeightPx, "estimatedLeafHeightPx");
  return {
    sourceFingerprint: input.sourceFingerprint,
    leafOrder: [...input.leafOrder],
    layoutToken: input.layoutToken,
    rendererVersion: input.rendererVersion,
    estimatedLeafHeightPx: input.estimatedLeafHeightPx,
    entries: new Map(),
    itemKeyByLid: new Map(),
    revision: 0,
  };
}

export function resetReaderHeightLedger(
  previous: ReaderHeightLedger,
  input: ReaderHeightLedgerIdentity,
): ReaderHeightLedger {
  if (
    previous.sourceFingerprint === input.sourceFingerprint
    && previous.layoutToken === input.layoutToken
    && previous.rendererVersion === input.rendererVersion
    && previous.estimatedLeafHeightPx === input.estimatedLeafHeightPx
    && sameLeafOrder(previous.leafOrder, input.leafOrder)
  ) {
    return previous;
  }
  return createReaderHeightLedger(input);
}

export function recordReaderItemHeight(
  ledger: ReaderHeightLedger,
  observation: ReaderItemHeightObservation,
): ReaderItemHeightReceipt {
  assertFiniteNonNegative(observation.blockHeightPx, "blockHeightPx");
  const expectedKey = readerRenderItemKey(observation.lids);
  if (observation.key !== expectedKey) {
    throw new Error("render-item key must be derived from its ordered LID set");
  }
  const [startLeafIndex, endLeafIndex] = contiguousItemRange(
    ledger.leafOrder,
    observation.lids,
  );
  const previous = ledger.entries.get(observation.key);
  if (
    previous
    && previous.startLeafIndex === startLeafIndex
    && previous.endLeafIndex === endLeafIndex
    && Math.abs(previous.blockHeightPx - observation.blockHeightPx) < HEIGHT_EPSILON_PX
  ) {
    return {
      ledger,
      changed: false,
      previousHeightPx: previous.blockHeightPx,
      deltaPx: 0,
    };
  }

  const entries = new Map(ledger.entries);
  const itemKeyByLid = new Map(ledger.itemKeyByLid);
  const overlappingKeys = new Set<string>();
  for (const lid of observation.lids) {
    const key = itemKeyByLid.get(lid);
    if (key && key !== observation.key) overlappingKeys.add(key);
  }
  for (const key of overlappingKeys) {
    const entry = entries.get(key);
    entries.delete(key);
    if (!entry) continue;
    for (const lid of entry.lids) {
      if (itemKeyByLid.get(lid) === key) itemKeyByLid.delete(lid);
    }
  }

  const entry: ReaderHeightEntry = {
    key: observation.key,
    lids: [...observation.lids],
    startLeafIndex,
    endLeafIndex,
    blockHeightPx: observation.blockHeightPx,
  };
  entries.set(entry.key, entry);
  for (const lid of entry.lids) itemKeyByLid.set(lid, entry.key);
  const previousHeightPx = previous?.blockHeightPx ?? null;
  return {
    ledger: {
      ...ledger,
      entries,
      itemKeyByLid,
      revision: ledger.revision + 1,
    },
    changed: true,
    previousHeightPx,
    deltaPx: previousHeightPx === null ? 0 : observation.blockHeightPx - previousHeightPx,
  };
}

export function readerRangeHeight(
  ledger: ReaderHeightLedger,
  value: ReaderBufferRange,
): number {
  assertRange(value, ledger.leafOrder.length, "height range");
  let total = (value[1] - value[0]) * ledger.estimatedLeafHeightPx;
  for (const entry of ledger.entries.values()) {
    const overlapStart = Math.max(value[0], entry.startLeafIndex);
    const overlapEnd = Math.min(value[1], entry.endLeafIndex);
    if (overlapEnd <= overlapStart) continue;
    const overlapLength = overlapEnd - overlapStart;
    const entryLength = entry.endLeafIndex - entry.startLeafIndex;
    total += overlapLength * (
      entry.blockHeightPx / entryLength - ledger.estimatedLeafHeightPx
    );
  }
  return total;
}

export function readerSpacerTotals(
  ledger: ReaderHeightLedger,
  mountedRange: ReaderBufferRange,
): ReaderSpacerTotals {
  assertRange(mountedRange, ledger.leafOrder.length, "mounted range");
  return {
    topSpacerPx: readerRangeHeight(ledger, [0, mountedRange[0]]),
    bottomSpacerPx: readerRangeHeight(ledger, [mountedRange[1], ledger.leafOrder.length]),
  };
}

export function projectReaderSpacerDelta(
  ledger: ReaderHeightLedger,
  transition: ReaderBufferTransition,
): ReaderSpacerDelta {
  assertRange(transition.baseRange, ledger.leafOrder.length, "transition base range");
  assertRange(transition.settledRange, ledger.leafOrder.length, "transition settled range");
  const before = readerSpacerTotals(ledger, transition.baseRange);
  const after = readerSpacerTotals(ledger, transition.settledRange);
  return {
    topSpacerDeltaPx: after.topSpacerPx - before.topSpacerPx,
    bottomSpacerDeltaPx: after.bottomSpacerPx - before.bottomSpacerPx,
  };
}
