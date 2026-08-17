import { describe, expect, it } from "vitest";
import { ReaderCommandQueue } from "./reader-command-queue";

describe("ReaderCommandQueue", () => {
  it("serializes reader viewport mutations in invocation order", async () => {
    const queue = new ReaderCommandQueue();
    const events: string[] = [];
    let releaseScroll!: () => void;
    const scrollGate = new Promise<void>((resolve) => { releaseScroll = resolve; });

    const scroll = queue.run(async () => {
      events.push("scroll:start");
      await scrollGate;
      events.push("scroll:end");
      return "scroll";
    });
    const goto = queue.run(async () => {
      events.push("goto:start");
      events.push("goto:end");
      return "goto";
    });
    await Promise.resolve();
    expect(events).toEqual(["scroll:start"]);
    releaseScroll();

    await expect(scroll).resolves.toBe("scroll");
    await expect(goto).resolves.toBe("goto");
    expect(events).toEqual(["scroll:start", "scroll:end", "goto:start", "goto:end"]);
  });

  it("continues after a rejected command", async () => {
    const queue = new ReaderCommandQueue();
    await expect(queue.run(async () => { throw new Error("scroll failed"); }))
      .rejects.toThrow("scroll failed");
    await expect(queue.run(async () => "next")).resolves.toBe("next");
  });
});
