---
name: read
description: Start the understand-book local reader: one localhost server serves both the packaged Vue SPA and the REST command surface for a built book.
argument-hint: ["<book-dir>"]
---

# /understand-book:read

Start the read-time product for a built book directory. One `server` process serves the packaged SPA and API on the same localhost port, so there is no CORS boundary.

## Usage

```bat
pnpm -C packages\web build
cargo run -p server -- <book-dir>
```

Then open the printed `http://127.0.0.1:8787` URL. If `<book-dir>` is omitted, set `UNDERSTAND_BOOK_DIR`; use `UNDERSTAND_BOOK_ADDR` to choose another host/port and `UNDERSTAND_BOOK_WEB_DIST` to point at a custom web `dist` directory.

## Notes

- API requests from the packaged SPA go through `/api/*`; the server strips `/api` before dispatching to the frozen command surface (`/book/*`, `/reader/*`, `/memory/*`, `/agent/*`).
- Missing `.env` only disables `book.query` and agent calls with a `PROVIDER_ERROR`; plain reading, scrolling, highlighting, and notes still work.
- Build a book first with `/understand-book:build` if the target directory has no `base.json`.
