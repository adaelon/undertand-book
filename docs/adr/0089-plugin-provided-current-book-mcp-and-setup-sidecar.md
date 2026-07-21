# ADR-0089 Plugin-provided current-book MCP and Setup sidecar
Status: Accepted, 2026-07-21.

**Decision**: The Codex plugin declares the canonical readonly Book MCP in `.mcp.json`. Windows Setup installs `book-mcp.exe` beside the Reader and build sidecar. The plugin-owned launcher resolves that executable from `UNDERSTAND_BOOK_MCP_BIN` or the Setup-owned `HKCU\Software\UnderstandBook\InstallDir` registry value; Codex user configuration controls enablement and tool policy but does not duplicate the transport command.

**Book binding**: One MCP process binds exactly one immutable book snapshot for its lifetime. Resolution order is positional `<book_dir>`, `UNDERSTAND_BOOK_DIR`, then the Reader's persisted `session.json.current_book_dir`. Explicit invalid input fails closed and never falls through. An absent, invalid, or unloadable current-book pointer returns an actionable startup error. Switching books in Reader takes effect for a newly started MCP process/new Codex thread.

**Privacy boundary**: The fallback reads only the resident session's current-book routing pointer. The MCP still constructs `MemoryStore::unavailable`, exposes only the readonly Book capability set, and never reads resident memory, profile, agent history, pending governance state, or provider settings. Plugin installation remains user-consented under ADR-0068.

**Release gate**: Root and public marketplace plugin copies must contain byte-equivalent `.mcp.json` and launcher files. Tauri release configuration must declare the MCP sidecar, the release build must compile it, and an end-to-end stdio smoke must call a canonical Book tool through the packaged binary. Setup and the public Git plugin remain separate release artifacts; a public rollout is incomplete until the committed plugin snapshot is available from the configured marketplace source.

**Rejected**:
- Writing `[mcp_servers]` into `~/.codex/config.toml`: duplicates plugin transport ownership and creates schema/config drift.
- Bundling a compiled executable in the Git plugin: couples the plugin archive to one OS/architecture and bloats marketplace updates.
- Guessing among every book in the library: makes an apparently successful answer depend on nondeterministic book selection.
- Binding to the live Reader loopback server: requires Reader uptime and introduces port discovery/authentication work unrelated to readonly Book tools.
- Exposing a multi-book MCP implicitly: changes every canonical input contract and lets an agent cross book boundaries without an explicit user choice.

**Revisit when**: Codex provides a portable plugin executable resolver, Understand Book ships non-Windows desktop installers, or canonical Book contracts gain an explicit library/book selector.
