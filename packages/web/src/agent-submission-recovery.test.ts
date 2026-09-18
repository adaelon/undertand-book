import { describe, expect, it } from "vitest";
import { submissionWasAccepted } from "./agent-submission-recovery";

describe("unknown Agent submission recovery", () => {
  it("resolves only from a new turn in the same session with the submitted user text", () => {
    const audit = {
      sessionId: "session-a",
      user: "same question",
      knownTurnIds: ["old-turn"],
    };
    expect(submissionWasAccepted(audit, {
      sessionId: "session-a",
      turns: [{ turnId: "old-turn", user: "same question" }],
    })).toBe(false);
    expect(submissionWasAccepted(audit, {
      sessionId: "session-b",
      turns: [{ turnId: "new-turn", user: "same question" }],
    })).toBe(false);
    expect(submissionWasAccepted(audit, {
      sessionId: "session-a",
      turns: [{ turnId: "old-turn", user: "same question" }, { turnId: "new-turn", user: "same question" }],
    })).toBe(true);
    expect(submissionWasAccepted(audit, {
      sessionId: "session-a",
      turns: [{ turnId: "new-turn", user: "different question" }],
    })).toBe(false);
  });
});
