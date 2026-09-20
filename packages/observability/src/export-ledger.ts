import { randomUUID } from "node:crypto";
import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import path from "node:path";

export interface ExportLedgerEntry {
  run_id: string;
  last_revision: number;
}

interface ExportLedgerFileV1 {
  version: "ub_observation_export_ledger.v1";
  entries: Record<string, ExportLedgerEntry>;
}

export interface ExportLedger {
  ensure(identity: string): ExportLedgerEntry;
  confirm(identity: string, revision: number): void;
}

export class MemoryExportLedger implements ExportLedger {
  readonly entries = new Map<string, ExportLedgerEntry>();

  ensure(identity: string): ExportLedgerEntry {
    const existing = this.entries.get(identity);
    if (existing) return existing;
    const entry = { run_id: randomUUID(), last_revision: 0 };
    this.entries.set(identity, entry);
    return entry;
  }

  confirm(identity: string, revision: number): void {
    const entry = this.ensure(identity);
    entry.last_revision = Math.max(entry.last_revision, revision);
  }
}

export class FileExportLedger implements ExportLedger {
  private readonly file: string;
  private readonly entries: Record<string, ExportLedgerEntry>;

  constructor(file: string) {
    this.file = path.resolve(file);
    try {
      const parsed = JSON.parse(readFileSync(this.file, "utf8")) as ExportLedgerFileV1;
      if (parsed.version !== "ub_observation_export_ledger.v1" || !parsed.entries) {
        throw new Error("unsupported export ledger");
      }
      this.entries = parsed.entries;
    } catch (error) {
      const code = error && typeof error === "object" && "code" in error ? String(error.code) : "";
      if (code !== "ENOENT") throw error;
      this.entries = {};
    }
  }

  ensure(identity: string): ExportLedgerEntry {
    const existing = this.entries[identity];
    if (existing) return existing;
    const entry = { run_id: randomUUID(), last_revision: 0 };
    this.entries[identity] = entry;
    this.persist();
    return entry;
  }

  confirm(identity: string, revision: number): void {
    const entry = this.ensure(identity);
    if (revision <= entry.last_revision) return;
    entry.last_revision = revision;
    this.persist();
  }

  private persist(): void {
    mkdirSync(path.dirname(this.file), { recursive: true });
    const temporary = `${this.file}.tmp`;
    const value: ExportLedgerFileV1 = {
      version: "ub_observation_export_ledger.v1",
      entries: this.entries,
    };
    writeFileSync(temporary, `${JSON.stringify(value, null, 2)}\n`, "utf8");
    renameSync(temporary, this.file);
  }
}
