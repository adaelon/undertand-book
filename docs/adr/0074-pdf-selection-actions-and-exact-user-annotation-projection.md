# ADR-0074 PDF selection actions and exact user annotation projection

Status: Accepted, 2026-07-13.

PDF mouse selection resolves into an ephemeral, revision-safe draft and only shows explicit Highlight, Note, and Ask AI actions; it never navigates, opens source text, sends a question, or writes memory by itself. `resolved` enables all actions, `partial` enables Note and Ask AI with an explicit warning, and `unresolved` preserves native copy only.

Only user-created annotations may project onto the PDF. Highlights use exact character-range strokes without borders; Notes persist a structured selection context and place a small marker after the final exactly projected character, opening the shared Markdown NoteCard in a desktop popover or mobile bottom sheet. Automatic source-map regions and whole-LID bbox fallbacks remain invisible; annotations that cannot be projected exactly stay in the side list.

Selection context keeps raw user text separate from resolved quote/ranges, and only resolved data may become citations or geometry. Ask AI enhances the existing cross-LID draft rather than creating a PDF-only path. Note content edits use atomic `memory.replace`, preserve anchors by default, and require an explicit reselection to move the marker.

This requires backward-compatible memory selection metadata, exact char-level reverse projection, shared NoteCard rendering, deterministic marker collision handling, and request IDs that prevent stale selection responses from replacing newer drafts.
