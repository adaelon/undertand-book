import path from "node:path";
import { homedir } from "node:os";
import { findExecutorChildRollout, readOwnedExecutorOpenDiagnostic } from "../../packages/core/src/build-executor-call-diagnostics";

export async function runBuildChildDiagnostic(args: string[]): Promise<void> {
  if (args.length !== 3) throw new Error("usage: build.diagnose-child <parent-id> <child-id> <issued-handoff-ref>");
  const [parent, child, issued] = args as [string, string, string];
  const root = path.join(process.env.CODEX_HOME ?? path.join(homedir(), ".codex"), "sessions");
  try {
    const file = await findExecutorChildRollout(root, child);
    if (!file) throw new Error("missing rollout");
    process.stdout.write(JSON.stringify(await readOwnedExecutorOpenDiagnostic(file, parent, child, issued)) + "\n");
  } catch {
    process.stdout.write(JSON.stringify({ version: "automatic_build_child_open_diagnostic.v1",
      status: "evidence_missing", missing: "readable child rollout with matching parent/child ownership and valid issued ref" }) + "\n");
  }
}
