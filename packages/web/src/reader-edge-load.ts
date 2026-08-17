export type ReaderEdgeDirection = "up" | "down";

export interface ReaderEdgeLoadToken {
  epoch: number;
  direction: ReaderEdgeDirection;
  requestId: number;
}

interface ReaderViewportProjection {
  delta: number;
  expectedViewportLids: readonly string[];
}

interface ReaderViewportEffectLike {
  ok: boolean;
  viewport: {
    top_lid: string;
    visible_lids: readonly string[];
  };
}

function sameLidSequence(left: readonly string[], right: readonly string[]): boolean {
  return left.length === right.length && left.every((lid, index) => lid === right[index]);
}

export async function alignReaderViewportForEdge<T extends ReaderViewportEffectLike>(input: {
  currentTopLid: string;
  project: (currentTopLid: string) => ReaderViewportProjection;
  scroll: (delta: number) => Promise<T>;
}): Promise<{ effect: T; corrections: 0 | 1 }> {
  let projection = input.project(input.currentTopLid);
  for (const corrections of [0, 1] as const) {
    const effect = await input.scroll(projection.delta);
    if (!effect.ok) throw new Error("reader.scroll did not commit an authoritative viewport");
    if (sameLidSequence(effect.viewport.visible_lids, projection.expectedViewportLids)) {
      return { effect, corrections };
    }
    if (corrections === 1) {
      throw new Error("reader.scroll viewport did not match the planned buffer insertion after correction");
    }
    projection = input.project(effect.viewport.top_lid);
  }
  throw new Error("reader viewport alignment exhausted unexpectedly");
}

export class ReaderEdgeLoadGate {
  private epochValue = 0;
  private nextRequestId = 1;
  private replacementEpoch: number | null = null;
  private readonly activeByDirection = new Map<ReaderEdgeDirection, ReaderEdgeLoadToken>();

  get epoch(): number {
    return this.epochValue;
  }

  invalidate(): number {
    this.epochValue += 1;
    this.replacementEpoch = null;
    this.activeByDirection.clear();
    return this.epochValue;
  }

  beginReplacement(): number {
    const epoch = this.invalidate();
    this.replacementEpoch = epoch;
    return epoch;
  }

  isReplacementCurrent(epoch: number): boolean {
    return epoch === this.epochValue && this.replacementEpoch === epoch;
  }

  finishReplacement(epoch: number): boolean {
    if (!this.isReplacementCurrent(epoch)) return false;
    this.replacementEpoch = null;
    return true;
  }

  begin(direction: ReaderEdgeDirection): ReaderEdgeLoadToken | null {
    if (this.replacementEpoch !== null) return null;
    const active = this.activeByDirection.get(direction);
    if (active?.epoch === this.epochValue) return null;
    const token = {
      epoch: this.epochValue,
      direction,
      requestId: this.nextRequestId++,
    };
    this.activeByDirection.set(direction, token);
    return token;
  }

  isCurrent(token: ReaderEdgeLoadToken): boolean {
    const active = this.activeByDirection.get(token.direction);
    return token.epoch === this.epochValue && active?.requestId === token.requestId;
  }

  commit(token: ReaderEdgeLoadToken, apply: () => void): boolean {
    if (!this.isCurrent(token)) return false;
    apply();
    return true;
  }

  finish(token: ReaderEdgeLoadToken): void {
    if (this.isCurrent(token)) this.activeByDirection.delete(token.direction);
  }
}
