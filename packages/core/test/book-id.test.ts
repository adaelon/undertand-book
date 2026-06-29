import { describe, it, expect } from "vitest";
import { deriveBookId } from "../src/book-id";

describe("PB5-1 deriveBookId [ADR-0042]", () => {
  it("basename 去扩展 + slug 化(与旧硬编码 game-programming-patterns 一致)", () => {
    expect(deriveBookId("game-programming-patterns.md")).toBe("game-programming-patterns");
    expect(deriveBookId("books/sub/game-programming-patterns.epub")).toBe("game-programming-patterns");
    expect(deriveBookId("C:\\books\\game-programming-patterns.md")).toBe("game-programming-patterns");
  });

  it("ASCII-safe:小写、空格/下划线→连字符、剥非 url-safe、折叠并 trim", () => {
    expect(deriveBookId("The Pragmatic Programmer.epub")).toBe("the-pragmatic-programmer");
    expect(deriveBookId("clean_code.md")).toBe("clean-code");
    expect(deriveBookId("a (draft!!) -- v2.md")).toBe("a-draft-v2");
    expect(deriveBookId("only-last.tar.gz")).toBe("only-last-tar"); // 只去最后一个扩展名;剩余点当分隔符
  });

  it("--book-id override 无视路径、slug 化后采用", () => {
    expect(deriveBookId("深入理解计算机系统.epub", "csapp")).toBe("csapp");
    expect(deriveBookId("anything.md", "My Book 2")).toBe("my-book-2");
  });

  it("非 ASCII 主导 → 报错要 --book-id", () => {
    expect(() => deriveBookId("深入理解计算机系统.epub")).toThrow(/--book-id/);
    expect(() => deriveBookId("算法导论.md")).toThrow(/--book-id/);
    // 非 ASCII 字符数 > ASCII 字母数字数 → 判主导 → 报错
    expect(() => deriveBookId("第三章节go.md")).toThrow(/--book-id/);
  });

  it("slug 为空 → 报错(纯符号文件名 / 空 override)", () => {
    expect(() => deriveBookId("___.md")).toThrow(/--book-id/);
    expect(() => deriveBookId("book.md", "你好")).toThrow(/slug/);
  });

  it("ASCII 主导但含少量非 ASCII → 取 ASCII 部分,不报错", () => {
    expect(deriveBookId("game深.md")).toBe("game");
  });
});
