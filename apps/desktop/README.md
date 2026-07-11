# Understand Book Windows distribution

The desktop package is a per-user Tauri 2 application. Setup installs `UnderstandBook.exe`, the
hidden deterministic `understand-book-build.exe` sidecar, reader web assets, and Start Menu entries.
It then asks for explicit consent before calling the detected Codex CLI to add the public Git
marketplace and install the `understand-book` plugin.

Reader installation and plugin installation are separate transactions. A missing Codex CLI,
offline marketplace, or declined consent leaves the reader installed and the plugin retryable from
the desktop Settings dialog. Uninstall removes the plugin only when an Understand Book installation
receipt proves Setup installed it; books, registered external workspaces, and memory are retained.

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

The release command refuses local marketplace paths and exports `dist/UnderstandBookSetup.exe`.
For a local pending-state smoke build, run Tauri with `--debug --bundles nsis`, then run
`node apps/desktop/scripts/export-installer.mjs --debug`.
