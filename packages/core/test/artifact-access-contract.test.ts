import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

interface Golden {
  version: "artifact_access.v1.golden";
  scope: {
    book_id: string;
    source_fingerprint: string;
    overlay_identity: string;
  };
  artifacts: Array<{
    artifact_id: string;
    blueprint_digest: string;
    payload_digest: string;
  }>;
  expected: {
    overlay_revision: string;
    artifact_refs: string[];
    record_ref: string;
    relation_ref: string;
    list_cursor_after_1: string;
    read_cursor_after_1: string;
  };
}

const golden = JSON.parse(readFileSync(
  new URL("./fixtures/artifact-access.v1.golden.json", import.meta.url),
  "utf8",
)) as Golden;

function digestParts(parts: string[]): Buffer {
  const digest = createHash("sha256");
  for (const part of parts) {
    const body = Buffer.from(part, "utf8");
    const length = Buffer.alloc(8);
    length.writeBigUInt64BE(BigInt(body.byteLength));
    digest.update(length);
    digest.update(body);
  }
  return digest.digest();
}

function opaqueReference(prefix: string, parts: string[]): string {
  return `${prefix}${digestParts(parts).subarray(0, 18).toString("base64url")}`;
}

function cursor(
  overlayRevision: string,
  operation: "list" | "read",
  artifactRef: string,
  offset: number,
): string {
  const signature = digestParts([
    "artifact-cursor.v1",
    overlayRevision,
    operation,
    artifactRef,
    String(offset),
  ]);
  const token = Buffer.alloc(24);
  token.writeBigUInt64BE(BigInt(offset));
  signature.copy(token, 8, 0, 16);
  return `ac1_${token.toString("base64url")}`;
}

describe("artifact access Rust/TypeScript golden", () => {
  it("pins overlay, opaque refs, and scope-bound cursor bytes", () => {
    expect(golden.version).toBe("artifact_access.v1.golden");
    const { book_id: bookId, source_fingerprint: source, overlay_identity: overlay } = golden.scope;
    const overlayParts = ["artifact-overlay-revision.v1", bookId, source, overlay];
    for (const artifact of golden.artifacts) {
      overlayParts.push(artifact.artifact_id, artifact.blueprint_digest, artifact.payload_digest);
    }
    const overlayRevision = digestParts(overlayParts).toString("hex");
    expect(overlayRevision).toBe(golden.expected.overlay_revision);

    const artifactRefs = golden.artifacts.map((artifact) => opaqueReference("ar1_", [
      "artifact-ref.v1",
      bookId,
      source,
      overlayRevision,
      artifact.artifact_id,
      artifact.blueprint_digest,
      artifact.payload_digest,
    ]));
    expect(artifactRefs).toEqual(golden.expected.artifact_refs);
    expect(opaqueReference("rr1_", [
      "record-ref.v1",
      bookId,
      source,
      golden.artifacts[0].artifact_id,
      golden.artifacts[0].blueprint_digest,
      golden.artifacts[0].payload_digest,
      "event-1",
    ])).toBe(golden.expected.record_ref);
    expect(opaqueReference("rl1_", [
      "relation-ref.v1",
      bookId,
      source,
      golden.artifacts[0].artifact_id,
      golden.artifacts[0].blueprint_digest,
      golden.artifacts[0].payload_digest,
      "edge-1",
    ])).toBe(golden.expected.relation_ref);
    expect(cursor(overlayRevision, "list", "", 1)).toBe(golden.expected.list_cursor_after_1);
    expect(cursor(overlayRevision, "read", artifactRefs[0], 1)).toBe(golden.expected.read_cursor_after_1);
  });
});
