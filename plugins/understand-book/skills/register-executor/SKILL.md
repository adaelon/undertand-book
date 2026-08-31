---
name: understand-book-register-executor
description: Register or install the published Understand Book executor agent in an explicitly selected personal or project Codex scope.
---

# Register the Understand Book executor agent

Use this skill only when the user explicitly asks to register or install the executor agent. Do not
activate it for ordinary book builds, opaque handoff execution, setup, or plugin
installation.

## Required choice

Obtain exactly one registration scope from the user:

- `personal`: install into the current user's personal Codex agent directory. When `CODEX_HOME` is
  set, the target is `<CODEX_HOME>/agents`; otherwise it is the user-profile `.codex/agents` directory.
- `project`: install into one explicitly named absolute workspace root. Do not infer the workspace
  from the current directory.

For `project`, require the exact existing workspace root. Do not run the script while either the
scope or required root is unresolved.

## Registration boundary

Resolve `<plugin-root>` as exactly two parent directories above this installed `SKILL.md`, then run
the packaged script at `<plugin-root>\scripts\register-executor-agent.ps1`:

```powershell
# personal
powershell.exe -NoProfile -NonInteractive -ExecutionPolicy Bypass -File <plugin-root>\scripts\register-executor-agent.ps1 -Scope personal

# project
powershell.exe -NoProfile -NonInteractive -ExecutionPolicy Bypass -File <plugin-root>\scripts\register-executor-agent.ps1 -Scope project -WorkspaceRoot <absolute-workspace-root>
```

Add `-MigrateKnownPredecessor` only when the user explicitly asks to upgrade the published known
predecessor. Do not infer migration consent from an ordinary registration request.

The script owns template resolution. It must read only the current and known-predecessor templates
under `assets/codex-agents/` beside the installed plugin; never search the repository, current
directory, or another plugin installation. It registers only the custom-agent role. The
`understand_book_build_executor` transport enters the parent session through the enabled plugin's
shared `.mcp.json`; the script never writes transport into the Agent TOML or user `config.toml`.

The operation is deliberately narrow:

- An absent target is created atomically from the exact current published bytes.
- A target whose normalized full text is current is accepted without rewriting it. Normalization
  changes only CRLF or CR line endings to LF.
- A target whose normalized full text equals the published known predecessor is migrated only with
  `-MigrateKnownPredecessor`. Before replacement, its original bytes are written create-only to the
  fixed same-directory `.automatic_build_executor_session.v2.bak` path. An existing backup is reused
  only when its bytes equal the original target bytes.
- Any other target is an unknown conflict and is not overwritten, deleted, renamed, or merged.

On success, relay only the script's `source_state`, `target_version`, `backup`, and
`new_task_required` fields. The agent becomes available only in a new Codex task; never claim that
the current task hot-reloaded it. On missing migration consent, a backup conflict, an unknown target,
or invalid scope/root, report the bounded failure and that the existing target was not overwritten.
