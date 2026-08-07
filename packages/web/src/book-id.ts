const MAX_BOOK_ID_LENGTH = 80;

function stableTitleHash(value: string): string {
  let hash = 0x811c9dc5;
  for (const byte of new TextEncoder().encode(value.normalize("NFKC"))) {
    hash ^= byte;
    hash = Math.imul(hash, 0x01000193);
  }
  return (hash >>> 0).toString(16).padStart(8, "0");
}

/** Generate the server-safe, system-owned directory id for a paper title. */
export function generateBookIdFromTitle(value: string): string {
  const title = value.trim();
  if (!title) return "";

  const slug = title
    .normalize("NFKD")
    .toLowerCase()
    .replace(/[\s_.]+/g, "-")
    .replace(/[^a-z0-9-]/g, "")
    .replace(/-+/g, "-")
    .replace(/^-+|-+$/g, "");
  if (!slug) return `book-${stableTitleHash(title)}`;

  return slug
    .slice(0, MAX_BOOK_ID_LENGTH)
    .replace(/-+$/g, "");
}
