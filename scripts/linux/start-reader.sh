#!/usr/bin/env bash
set -euo pipefail
source_root="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/../.." && pwd)"
cd "$source_root"
: "${UNDERSTAND_BOOK_DIR:?Set UNDERSTAND_BOOK_DIR to a complete book workspace}"
: "${UNDERSTAND_BOOK_LIBRARY_ROOT:?Set UNDERSTAND_BOOK_LIBRARY_ROOT}"
: "${UNDERSTAND_BOOK_MEMORY_DIR:?Set UNDERSTAND_BOOK_MEMORY_DIR}"
: "${UNDERSTAND_BOOK_PRIVATE_DIR:?Set UNDERSTAND_BOOK_PRIVATE_DIR}"
: "${UNDERSTAND_BOOK_NODE:?Set UNDERSTAND_BOOK_NODE to the Node executable}"
export UNDERSTAND_BOOK_WEB_DIST="${UNDERSTAND_BOOK_WEB_DIST:-$source_root/packages/web/dist}"
exec "$source_root/target/release/server" --reader-only "$UNDERSTAND_BOOK_DIR"
