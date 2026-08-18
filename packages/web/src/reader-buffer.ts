export type ReaderBufferDirection = "up" | "down";
export type ReaderBufferPin = "selection" | "note";
export type ReaderBufferPhase = "settled" | "loading" | "trim_pending";
export type ReaderBufferRange = readonly [startLeafIndex: number, endLeafIndex: number];

export interface ReaderBufferTransition {
  transitionId: number;
  sourceFingerprint: string;
  epoch: number;
  direction: ReaderBufferDirection;
  baseRange: ReaderBufferRange;
  insertRange: ReaderBufferRange;
  keepRange: ReaderBufferRange;
  evictRange: ReaderBufferRange | null;
  transientRange: ReaderBufferRange;
  settledRange: ReaderBufferRange;
  preserveAnchorLid: string;
}

export interface ReaderBufferPendingTrim {
  transitionId: number;
  epoch: number;
  direction: ReaderBufferDirection;
  settledRange: ReaderBufferRange;
  evictRange: ReaderBufferRange | null;
  preserveAnchorLid: string;
}

export interface ReaderBufferState {
  sourceFingerprint: string;
  leafCount: number;
  startLeafIndex: number;
  endLeafIndex: number;
  mountedLids: string[];
  viewportWidth: number;
  epoch: number;
  phase: ReaderBufferPhase;
  pins: ReaderBufferPin[];
  activeTransition: ReaderBufferTransition | null;
  pendingTrim: ReaderBufferPendingTrim | null;
  nextTransitionId: number;
}

export interface ReplaceReaderBufferInput {
  sourceFingerprint: string;
  leafOrder: readonly string[];
  mountedLids: readonly string[];
  viewportWidth: number;
}

export type ReaderBufferPlanBlock =
  | "empty_buffer"
  | "book_edge"
  | "transition_in_flight"
  | "trim_pending";

export interface ReaderBufferPlanResult {
  state: ReaderBufferState;
  transition: ReaderBufferTransition | null;
  blocked: ReaderBufferPlanBlock | null;
}

export interface ReaderBufferCommitResult {
  state: ReaderBufferState;
  committed: boolean;
  trimDeferred: boolean;
}

export interface ReaderBufferAbortResult {
  state: ReaderBufferState;
  aborted: boolean;
}

export interface ReaderBufferPinResult {
  state: ReaderBufferState;
  trimmed: boolean;
  settledTrim: ReaderBufferPendingTrim | null;
}

const PIN_ORDER: readonly ReaderBufferPin[] = ["selection", "note"];

function range(startLeafIndex: number, endLeafIndex: number): ReaderBufferRange {
  return [startLeafIndex, endLeafIndex];
}

function rangeLength(value: ReaderBufferRange): number {
  return value[1] - value[0];
}

function sameRange(left: ReaderBufferRange, right: ReaderBufferRange): boolean {
  return left[0] === right[0] && left[1] === right[1];
}

function sameOptionalRange(
  left: ReaderBufferRange | null,
  right: ReaderBufferRange | null,
): boolean {
  return left === null ? right === null : right !== null && sameRange(left, right);
}

function assertPositiveInteger(value: number, label: string): void {
  if (!Number.isInteger(value) || value <= 0) {
    throw new Error(`${label} must be a positive integer`);
  }
}

function assertRange(value: ReaderBufferRange, leafCount: number, label: string): void {
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

export function readerTargetIsBeyondAdjacentWindow(
  mountedRange: ReaderBufferRange,
  targetLeafIndex: number,
  viewportWidth: number,
  leafCount: number,
): boolean {
  if (!Number.isInteger(leafCount) || leafCount <= 0) {
    throw new Error("leafCount must be a positive integer");
  }
  assertRange(mountedRange, leafCount, "mountedRange");
  assertPositiveInteger(viewportWidth, "viewportWidth");
  if (
    !Number.isInteger(targetLeafIndex)
    || targetLeafIndex < 0
    || targetLeafIndex >= leafCount
  ) {
    throw new Error("targetLeafIndex must identify an existing leaf");
  }
  const adjacentStart = Math.max(0, mountedRange[0] - viewportWidth);
  const adjacentEnd = Math.min(leafCount, mountedRange[1] + viewportWidth);
  return targetLeafIndex < adjacentStart || targetLeafIndex >= adjacentEnd;
}

function assertUniqueLeafOrder(leafOrder: readonly string[]): void {
  const seen = new Set<string>();
  for (const lid of leafOrder) {
    if (seen.has(lid)) throw new Error(`leafOrder contains duplicate LID: ${lid}`);
    seen.add(lid);
  }
}

function assertMountedSlice(state: ReaderBufferState, leafOrder: readonly string[]): void {
  const expected = leafOrder.slice(state.startLeafIndex, state.endLeafIndex);
  if (
    expected.length !== state.mountedLids.length
    || expected.some((lid, index) => lid !== state.mountedLids[index])
  ) {
    throw new Error("mountedLids must equal one contiguous leafOrder slice");
  }
}

function assertCanonicalPins(pins: readonly ReaderBufferPin[]): void {
  const expected = PIN_ORDER.filter((pin) => pins.includes(pin));
  if (expected.length !== pins.length || expected.some((pin, index) => pin !== pins[index])) {
    throw new Error("reader buffer pins must be unique and canonically ordered");
  }
}

function sameTransition(
  left: ReaderBufferTransition,
  right: ReaderBufferTransition,
): boolean {
  return left.transitionId === right.transitionId
    && left.sourceFingerprint === right.sourceFingerprint
    && left.epoch === right.epoch
    && left.direction === right.direction
    && sameRange(left.baseRange, right.baseRange)
    && sameRange(left.insertRange, right.insertRange)
    && sameRange(left.keepRange, right.keepRange)
    && sameOptionalRange(left.evictRange, right.evictRange)
    && sameRange(left.transientRange, right.transientRange)
    && sameRange(left.settledRange, right.settledRange)
    && left.preserveAnchorLid === right.preserveAnchorLid;
}

function assertTransition(
  state: ReaderBufferState,
  transition: ReaderBufferTransition,
  leafOrder: readonly string[],
): void {
  const leafCount = leafOrder.length;
  for (const [label, value] of [
    ["baseRange", transition.baseRange],
    ["insertRange", transition.insertRange],
    ["keepRange", transition.keepRange],
    ["transientRange", transition.transientRange],
    ["settledRange", transition.settledRange],
  ] as const) {
    assertRange(value, leafCount, label);
  }
  if (transition.evictRange) assertRange(transition.evictRange, leafCount, "evictRange");
  if (transition.epoch !== state.epoch) throw new Error("transition epoch must match buffer epoch");
  if (transition.sourceFingerprint !== state.sourceFingerprint) {
    throw new Error("transition source fingerprint must match buffer source");
  }
  if (!sameRange(transition.baseRange, range(state.startLeafIndex, state.endLeafIndex))) {
    throw new Error("transition base range must match the settled buffer");
  }
  if (rangeLength(transition.insertRange) <= 0) {
    throw new Error("transition insert range must not be empty");
  }
  if (rangeLength(transition.transientRange) > 4 * state.viewportWidth) {
    throw new Error("transition exceeds the 4w transient budget");
  }
  if (rangeLength(transition.settledRange) > 3 * state.viewportWidth) {
    throw new Error("transition exceeds the 3w settled budget");
  }
  const preserveAnchorIndex = transition.keepRange[0] < transition.keepRange[1]
    ? transition.keepRange[0]
    : transition.insertRange[0];
  if (leafOrder[preserveAnchorIndex] !== transition.preserveAnchorLid) {
    throw new Error("transition preserve anchor must be a current leaf LID");
  }
}

function assertReaderBufferState(
  state: ReaderBufferState,
  leafOrder: readonly string[],
  verifyLeafOrderUniqueness: boolean,
): void {
  if (verifyLeafOrderUniqueness) assertUniqueLeafOrder(leafOrder);
  assertPositiveInteger(state.viewportWidth, "viewportWidth");
  if (!Number.isInteger(state.epoch) || state.epoch < 1) {
    throw new Error("reader buffer epoch must be a positive integer");
  }
  if (!Number.isInteger(state.nextTransitionId) || state.nextTransitionId < 1) {
    throw new Error("nextTransitionId must be a positive integer");
  }
  if (state.leafCount !== leafOrder.length) {
    throw new Error("reader buffer leaf count does not match leafOrder");
  }
  assertRange(range(state.startLeafIndex, state.endLeafIndex), leafOrder.length, "buffer range");
  assertMountedSlice(state, leafOrder);
  assertCanonicalPins(state.pins);

  if (state.phase === "settled") {
    if (state.activeTransition || state.pendingTrim) {
      throw new Error("settled buffer cannot own transition debt");
    }
    if (state.mountedLids.length > 3 * state.viewportWidth) {
      throw new Error("settled buffer exceeds the 3w budget");
    }
    return;
  }

  if (state.phase === "loading") {
    if (!state.activeTransition || state.pendingTrim) {
      throw new Error("loading buffer must own exactly one active transition");
    }
    if (state.mountedLids.length > 3 * state.viewportWidth) {
      throw new Error("loading base buffer exceeds the 3w budget");
    }
    assertTransition(state, state.activeTransition, leafOrder);
    return;
  }

  if (state.activeTransition || !state.pendingTrim) {
    throw new Error("trim_pending buffer must own only trim debt");
  }
  if (state.pins.length === 0) {
    throw new Error("trim_pending buffer requires an active interaction pin");
  }
  if (state.mountedLids.length > 4 * state.viewportWidth) {
    throw new Error("trim_pending buffer exceeds the 4w budget");
  }
  assertRange(state.pendingTrim.settledRange, leafOrder.length, "pending settled range");
  if (rangeLength(state.pendingTrim.settledRange) > 3 * state.viewportWidth) {
    throw new Error("pending settled range exceeds the 3w budget");
  }
  if (
    state.pendingTrim.settledRange[0] < state.startLeafIndex
    || state.pendingTrim.settledRange[1] > state.endLeafIndex
  ) {
    throw new Error("pending settled range must be inside the transient buffer");
  }
}

export function assertReaderBufferInvariants(
  state: ReaderBufferState,
  leafOrder: readonly string[],
): void {
  assertReaderBufferState(state, leafOrder, true);
}

function contiguousMountedStart(
  leafOrder: readonly string[],
  mountedLids: readonly string[],
): number {
  if (mountedLids.length === 0) return 0;
  const startLeafIndex = leafOrder.indexOf(mountedLids[0]);
  if (startLeafIndex < 0) {
    throw new Error("mountedLids must be a contiguous leafOrder slice");
  }
  for (let index = 0; index < mountedLids.length; index += 1) {
    if (leafOrder[startLeafIndex + index] !== mountedLids[index]) {
      throw new Error("mountedLids must be a contiguous leafOrder slice");
    }
  }
  return startLeafIndex;
}

export function replaceReaderBuffer(
  previous: ReaderBufferState | null,
  input: ReplaceReaderBufferInput,
): ReaderBufferState {
  assertPositiveInteger(input.viewportWidth, "viewportWidth");
  assertUniqueLeafOrder(input.leafOrder);
  if (input.mountedLids.length > 3 * input.viewportWidth) {
    throw new Error("replacement buffer exceeds the 3w settled budget");
  }
  const startLeafIndex = contiguousMountedStart(input.leafOrder, input.mountedLids);
  const state: ReaderBufferState = {
    sourceFingerprint: input.sourceFingerprint,
    leafCount: input.leafOrder.length,
    startLeafIndex,
    endLeafIndex: startLeafIndex + input.mountedLids.length,
    mountedLids: [...input.mountedLids],
    viewportWidth: input.viewportWidth,
    epoch: (previous?.epoch ?? 0) + 1,
    phase: "settled",
    pins: [],
    activeTransition: null,
    pendingTrim: null,
    nextTransitionId: previous?.nextTransitionId ?? 1,
  };
  assertReaderBufferState(state, input.leafOrder, false);
  return state;
}

function blockedPlan(
  state: ReaderBufferState,
  blocked: ReaderBufferPlanBlock,
): ReaderBufferPlanResult {
  return { state, transition: null, blocked };
}

export function planBufferTransition(
  state: ReaderBufferState,
  input: { leafOrder: readonly string[]; direction: ReaderBufferDirection },
): ReaderBufferPlanResult {
  assertReaderBufferState(state, input.leafOrder, false);
  if (state.phase === "loading") return blockedPlan(state, "transition_in_flight");
  if (state.phase === "trim_pending") return blockedPlan(state, "trim_pending");
  if (state.mountedLids.length === 0) return blockedPlan(state, "empty_buffer");

  const width = state.viewportWidth;
  const baseStart = state.startLeafIndex;
  const baseEnd = state.endLeafIndex;
  let insertRange: ReaderBufferRange;
  let keepRange: ReaderBufferRange;
  let evictRange: ReaderBufferRange | null;
  let transientRange: ReaderBufferRange;
  let settledRange: ReaderBufferRange;
  let preserveAnchorIndex: number;

  if (input.direction === "down") {
    const insertEnd = Math.min(input.leafOrder.length, baseEnd + width);
    if (insertEnd === baseEnd) return blockedPlan(state, "book_edge");
    insertRange = range(baseEnd, insertEnd);
    transientRange = range(baseStart, insertEnd);
    const settledStart = Math.max(baseStart, insertEnd - 3 * width);
    settledRange = range(settledStart, insertEnd);
    keepRange = range(settledStart, baseEnd);
    evictRange = settledStart > baseStart ? range(baseStart, settledStart) : null;
    preserveAnchorIndex = keepRange[0] < keepRange[1] ? keepRange[0] : insertRange[0];
  }
  else {
    const insertStart = Math.max(0, baseStart - width);
    if (insertStart === baseStart) return blockedPlan(state, "book_edge");
    insertRange = range(insertStart, baseStart);
    transientRange = range(insertStart, baseEnd);
    const settledEnd = Math.min(baseEnd, insertStart + 3 * width);
    settledRange = range(insertStart, settledEnd);
    keepRange = range(baseStart, settledEnd);
    evictRange = settledEnd < baseEnd ? range(settledEnd, baseEnd) : null;
    preserveAnchorIndex = keepRange[0] < keepRange[1] ? keepRange[0] : insertRange[0];
  }

  const transition: ReaderBufferTransition = {
    transitionId: state.nextTransitionId,
    sourceFingerprint: state.sourceFingerprint,
    epoch: state.epoch,
    direction: input.direction,
    baseRange: range(baseStart, baseEnd),
    insertRange,
    keepRange,
    evictRange,
    transientRange,
    settledRange,
    preserveAnchorLid: input.leafOrder[preserveAnchorIndex],
  };
  const next: ReaderBufferState = {
    ...state,
    phase: "loading",
    activeTransition: transition,
    nextTransitionId: state.nextTransitionId + 1,
  };
  assertReaderBufferState(next, input.leafOrder, false);
  return { state: next, transition, blocked: null };
}

export function commitBufferTransition(
  state: ReaderBufferState,
  transition: ReaderBufferTransition,
  input: { leafOrder: readonly string[] },
): ReaderBufferCommitResult {
  assertReaderBufferState(state, input.leafOrder, false);
  if (
    state.phase !== "loading"
    || !state.activeTransition
    || !sameTransition(state.activeTransition, transition)
    || transition.epoch !== state.epoch
    || transition.sourceFingerprint !== state.sourceFingerprint
  ) {
    return { state, committed: false, trimDeferred: false };
  }

  if (state.pins.length > 0) {
    const pendingTrim: ReaderBufferPendingTrim = {
      transitionId: transition.transitionId,
      epoch: transition.epoch,
      direction: transition.direction,
      settledRange: transition.settledRange,
      evictRange: transition.evictRange,
      preserveAnchorLid: transition.preserveAnchorLid,
    };
    const next: ReaderBufferState = {
      ...state,
      startLeafIndex: transition.transientRange[0],
      endLeafIndex: transition.transientRange[1],
      mountedLids: input.leafOrder.slice(...transition.transientRange),
      phase: "trim_pending",
      activeTransition: null,
      pendingTrim,
    };
    assertReaderBufferState(next, input.leafOrder, false);
    return { state: next, committed: true, trimDeferred: true };
  }

  const next: ReaderBufferState = {
    ...state,
    startLeafIndex: transition.settledRange[0],
    endLeafIndex: transition.settledRange[1],
    mountedLids: input.leafOrder.slice(...transition.settledRange),
    phase: "settled",
    activeTransition: null,
    pendingTrim: null,
  };
  assertReaderBufferState(next, input.leafOrder, false);
  return { state: next, committed: true, trimDeferred: false };
}

export function abortBufferTransition(
  state: ReaderBufferState,
  transition: ReaderBufferTransition,
): ReaderBufferAbortResult {
  if (
    state.phase !== "loading"
    || !state.activeTransition
    || !sameTransition(state.activeTransition, transition)
  ) {
    return { state, aborted: false };
  }
  return {
    state: {
      ...state,
      phase: "settled",
      activeTransition: null,
    },
    aborted: true,
  };
}

export function setReaderBufferPin(
  state: ReaderBufferState,
  input: {
    leafOrder: readonly string[];
    pin: ReaderBufferPin;
    active: boolean;
  },
): ReaderBufferPinResult {
  assertReaderBufferState(state, input.leafOrder, false);
  const pins = PIN_ORDER.filter((pin) => (
    pin === input.pin ? input.active : state.pins.includes(pin)
  ));
  if (pins.length > 0 || state.phase !== "trim_pending") {
    const next = pins.length === state.pins.length
      && pins.every((pin, index) => pin === state.pins[index])
      ? state
      : { ...state, pins };
    assertReaderBufferState(next, input.leafOrder, false);
    return { state: next, trimmed: false, settledTrim: null };
  }

  const settledTrim = state.pendingTrim;
  if (!settledTrim) throw new Error("trim_pending buffer lost its trim debt");
  const next: ReaderBufferState = {
    ...state,
    startLeafIndex: settledTrim.settledRange[0],
    endLeafIndex: settledTrim.settledRange[1],
    mountedLids: input.leafOrder.slice(...settledTrim.settledRange),
    phase: "settled",
    pins,
    pendingTrim: null,
  };
  assertReaderBufferState(next, input.leafOrder, false);
  return { state: next, trimmed: true, settledTrim };
}
