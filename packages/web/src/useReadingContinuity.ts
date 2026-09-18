export interface MarkdownReadingAnchor {
  surface: "markdown";
  lid: string;
  top: number;
}

export interface PdfReadingAnchor {
  surface: "pdf";
  sourceKey: string;
  pageIndex: number;
  pageRatio: number;
  probeRatio: number;
  horizontalRatio: number | null;
  anchorLid: string | null;
}

export type ReadingAnchor = MarkdownReadingAnchor | PdfReadingAnchor;

export interface ReadingReturnPoint {
  contextKey: string;
  turnId: string;
  anchor: ReadingAnchor | null;
}

export interface ReadingRestoreToken {
  contextKey: string;
  generation: number;
}

export function createReadingContinuity(limit = 16) {
  let points: ReadingReturnPoint[] = [];
  let restoreGeneration = 0;

  function push(point: ReadingReturnPoint) {
    points = [...points, point].slice(-Math.max(1, limit));
  }

  function pop(contextKey: string): ReadingReturnPoint | null {
    for (let index = points.length - 1; index >= 0; index -= 1) {
      if (points[index].contextKey !== contextKey) continue;
      const [point] = points.splice(index, 1);
      return point;
    }
    return null;
  }

  function has(contextKey: string): boolean {
    return points.some((point) => point.contextKey === contextKey);
  }

  function invalidateContext(contextKey: string) {
    points = points.filter((point) => point.contextKey === contextKey);
    restoreGeneration += 1;
  }

  function beginRestore(contextKey: string): ReadingRestoreToken {
    restoreGeneration += 1;
    return { contextKey, generation: restoreGeneration };
  }

  function isCurrent(token: ReadingRestoreToken): boolean {
    return token.generation === restoreGeneration;
  }

  function cancelRestore() {
    restoreGeneration += 1;
  }

  return { push, pop, has, invalidateContext, beginRestore, isCurrent, cancelRestore };
}
