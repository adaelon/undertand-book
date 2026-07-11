---
name: understand-book-build
description: Build or resume a Markdown/EPUB book or trusted paper Workbench workspace with one Codex invocation.
---

# $understand-book-build

Run the deterministic build loop until `done`, `needs_user`, or an exhausted external failure. Do
not stop at ordinary stage boundaries and do not replace extractor output with generic summaries.

1. Resolve the installed build executable in this order:
   - existing file from `UNDERSTAND_BOOK_BUILD_EXE`;
   - on Windows, read `InstallDir` from `HKCU\Software\UnderstandBook` and use
     `understand-book-build.exe` in that directory;
   - if neither exists, tell the user to install the Understand Book desktop reader. Do not install
     Node, Cargo, or another runtime as an implicit fallback.
2. Run `<build-exe> next <target> --plugin-root <this-plugin-root>` and parse only the
   `automatic_build_next.v1` JSON written to stdout.
3. For `extract`, execute `extractor_prompt_command` and use its complete stdout as the dedicated
   extractor contract. For every task, execute `input_command`, then delegate only that contract and
   input to a dedicated subagent. Save its contract JSON to a temporary file and execute
   `write_command` with `{output_json}` replaced by that path. Execute `record_success_command` only
   after the writer succeeds. On subagent, writer, or gate failure, execute
   `record_failure_command` with `{diagnostic}` replaced by the deterministic error and retry.
4. For `close_stage`, execute `command` exactly as returned. Never add `--allow-partial`.
5. After every write or close, return to step 2. `.build/<stage>` is the only resume truth.
6. For `needs_user`, show the stage, task ids, last diagnostics, and reset commands, then wait for
   explicit confirmation. For `done`, report the workspace and completed stages.

Hard boundaries:

- A paper must already have source reconciliation and hybrid foundation artifacts from the desktop
  Build Workbench. The plugin locates and verifies them; it does not recreate that human-reviewed
  foundation.
- Markdown/EPUB inputs run the full pipeline from the source file.
- Dedicated subagents are required. If unavailable, fail explicitly.
- Automatic repair is limited to three total attempts per task; the durable attempt ledger decides.
