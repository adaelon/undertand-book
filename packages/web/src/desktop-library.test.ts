import { describe, expect, it } from "vitest";
import { desktopLibraryNeedsSelection } from "./desktop-library";

describe("desktopLibraryNeedsSelection", () => {
  it("blocks desktop startup when the persisted library root is unavailable", () => {
    expect(
      desktopLibraryNeedsSelection({
        desktop_host: true,
        active_book: true,
        book_dir: "E:\\books\\paper-a",
        library_root: "E:\\offline\\.understand-book",
        library_root_available: false,
      }),
    ).toBe(true);
  });

  it("does not affect web mode or an available desktop library", () => {
    expect(desktopLibraryNeedsSelection(null)).toBe(false);
    expect(
      desktopLibraryNeedsSelection({
        desktop_host: true,
        active_book: false,
        book_dir: null,
        library_root: "D:\\books\\.understand-book",
        library_root_available: true,
      }),
    ).toBe(false);
  });
});
