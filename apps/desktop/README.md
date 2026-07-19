# Understand Book Windows distribution

The desktop package is a per-user Tauri 2 application. Setup installs `UnderstandBook.exe`, the
hidden deterministic `understand-book-build.exe` sidecar, reader web assets, and Start Menu entries.
It then asks for explicit consent before calling the detected Codex CLI to add the public Git
marketplace and install the `understand-book` plugin.

Reader installation and plugin installation are separate transactions. A missing Codex CLI,
offline marketplace, or declined consent leaves the reader installed and the plugin retryable from
the desktop Settings dialog. Uninstall removes the plugin only when an Understand Book installation
receipt proves Setup installed it; books, registered external workspaces, and memory are retained.
Retrying an installed Setup-owned plugin refreshes its marketplace. If the configured source changed,
the Reader migrates the marketplace only when the receipt proves Setup created it; an external
same-name marketplace is never removed automatically and instead returns manual recovery guidance.

Desktop Settings lets the user select a library parent (or an existing `.understand-book`) and
change the Reader LLM provider without restarting. The effective library root and provider mode,
Base URL, model, and API key are stored in `%LOCALAPPDATA%\UnderstandBook\settings.json`. The API
key is currently plain text by explicit product decision; it is never returned to the web UI or
embedded in Setup. A blank key on a later save preserves the stored value.

Release prerequisites:

- Windows x64 with Rust MSVC, WebView2, pnpm, Bun, and the Tauri NSIS tooling;
- a published Git repository containing `.agents/plugins/marketplace.json` and
  `plugins/understand-book`;
- `UNDERSTAND_BOOK_MARKETPLACE_SOURCE`; the current public source is
  `adaelon/undertand-book` (the repository name intentionally follows the existing remote spelling);
- optional `UNDERSTAND_BOOK_MARKETPLACE_NAME` when it differs from `understand-book`.

Build the distributable from the repository root:

```powershell
$env:UNDERSTAND_BOOK_MARKETPLACE_SOURCE = "adaelon/undertand-book"
pnpm -C apps/desktop package:windows
```

The release command first verifies that the public marketplace plugin manifest matches the root
Codex manifest and that its compact build skill carries the automatic-build v2 orchestration
contract. It then refuses local marketplace paths and exports `dist/UnderstandBookSetup.exe`.
For a local pending-state smoke build, run Tauri with `--debug --bundles nsis`, then run
`node apps/desktop/scripts/export-installer.mjs --debug`.
