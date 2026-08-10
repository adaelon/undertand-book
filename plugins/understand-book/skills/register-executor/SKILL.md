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

- `personal`: install into the current user's personal Codex agent directory.
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

The script owns template resolution. It must read only the published
`assets/codex-agents/understand-book-executor.toml` beside the installed plugin; never search the
repository, current directory, or another plugin installation for a template.

The operation is deliberately narrow:

- An absent target is created atomically from the exact published bytes.
- A target with the same SHA-256 is accepted without rewriting it.
- A target with a different SHA-256 is a conflict and must not be overwritten, deleted, renamed,
  or merged. An upgrade request does not waive this rule.

On success, relay only the script's `digest`, `scope`, `target`, and `activation` fields. The agent
becomes available only in a new Codex task; never claim that the current task hot-reloaded it. On a
conflict or invalid scope/root, report the bounded failure and that nothing was overwritten.
