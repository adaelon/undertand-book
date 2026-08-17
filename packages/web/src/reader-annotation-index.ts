import type { MemoryRecord } from "./api";

export interface ReaderAnnotationIndexDiagnostics {
  recordsVisited: number;
  mountedLidsVisited: number;
  groupMembersVisited: number;
}

export interface ReaderAnnotationIndex {
  annotationsByLid: ReadonlyMap<string, readonly MemoryRecord[]>;
  highlightsByLid: ReadonlyMap<string, readonly MemoryRecord[]>;
  highlightCardsByLid: ReadonlyMap<string, readonly MemoryRecord[]>;
  notesByLid: ReadonlyMap<string, readonly MemoryRecord[]>;
  renderRevisions: ReadonlyMap<string, string>;
  highlightGroupMembersById: ReadonlyMap<string, readonly MemoryRecord[]>;
  highlightGroupByMemId: ReadonlyMap<string, string>;
  diagnostics: ReaderAnnotationIndexDiagnostics;
}

export interface BuildReaderAnnotationIndexInput {
  annotations: readonly MemoryRecord[];
  mountedLids: readonly string[];
  isInlineNote: (record: MemoryRecord) => boolean;
  highlightGroupId: (record: MemoryRecord) => string | null;
}

function append<K, V>(map: Map<K, V[]>, key: K, value: V): void {
  const values = map.get(key);
  if (values) values.push(value);
  else map.set(key, [value]);
}

/**
 * Builds every mounted-reader annotation projection in one pass over the input.
 * Lookups during render are Map.get; there is no mounted-LID × annotation filter.
 */
export function buildReaderAnnotationIndex(
  input: BuildReaderAnnotationIndexInput,
): ReaderAnnotationIndex {
  const annotationsByLid = new Map<string, MemoryRecord[]>();
  const highlightsByLid = new Map<string, MemoryRecord[]>();
  const notesByLid = new Map<string, MemoryRecord[]>();
  const renderRevisionPartsByLid = new Map<string, string[]>();
  const highlightGroupMembersById = new Map<string, MemoryRecord[]>();
  const highlightGroupByMemId = new Map<string, string>();
  let recordsVisited = 0;
  let groupMembersVisited = 0;

  for (const record of input.annotations) {
    recordsVisited += 1;
    const lid = record.anchor.lid?.trim();
    if (!lid) continue;
    append(annotationsByLid, lid, record);
    if (record.type === "highlight") {
      append(highlightsByLid, lid, record);
      if (record.range) {
        append(
          renderRevisionPartsByLid,
          lid,
          `${record.mem_id}:${record.range.start}:${record.range.end}`,
        );
      }
      const groupId = input.highlightGroupId(record);
      if (groupId) {
        append(highlightGroupMembersById, groupId, record);
        highlightGroupByMemId.set(record.mem_id, groupId);
      }
    }
    else if (record.type === "note" && input.isInlineNote(record)) {
      append(notesByLid, lid, record);
    }
  }

  const mountedOrder = new Map(input.mountedLids.map((lid, index) => [lid, index]));
  const representativeByGroupId = new Map<string, string>();
  for (const [groupId, members] of highlightGroupMembersById) {
    let representative = members[0];
    let representativeOrder = Number.MAX_SAFE_INTEGER;
    for (const member of members) {
      groupMembersVisited += 1;
      const order = mountedOrder.get(member.anchor.lid ?? "") ?? Number.MAX_SAFE_INTEGER;
      if (order < representativeOrder) {
        representative = member;
        representativeOrder = order;
      }
    }
    if (representative) representativeByGroupId.set(groupId, representative.mem_id);
  }

  const highlightCardsByLid = new Map<string, MemoryRecord[]>();
  for (const [lid, highlights] of highlightsByLid) {
    for (const highlight of highlights) {
      const groupId = highlightGroupByMemId.get(highlight.mem_id);
      if (!groupId || representativeByGroupId.get(groupId) === highlight.mem_id) {
        append(highlightCardsByLid, lid, highlight);
      }
    }
  }

  const renderRevisions = new Map<string, string>();
  for (const [lid, parts] of renderRevisionPartsByLid) {
    renderRevisions.set(lid, parts.sort().join("|"));
  }

  return {
    annotationsByLid,
    highlightsByLid,
    highlightCardsByLid,
    notesByLid,
    renderRevisions,
    highlightGroupMembersById,
    highlightGroupByMemId,
    diagnostics: {
      recordsVisited,
      mountedLidsVisited: input.mountedLids.length,
      groupMembersVisited,
    },
  };
}

export function readerHighlightGroupMembers(
  index: ReaderAnnotationIndex,
  record: MemoryRecord,
): readonly MemoryRecord[] {
  const groupId = index.highlightGroupByMemId.get(record.mem_id);
  return groupId ? index.highlightGroupMembersById.get(groupId) ?? [record] : [record];
}
