export interface UnknownSubmissionAudit {
  sessionId: string;
  user: string;
  knownTurnIds: string[];
}

export interface SubmissionHistoryView {
  sessionId: string;
  turns: Array<{ turnId: string; user: string }>;
}

export function submissionWasAccepted(
  audit: UnknownSubmissionAudit,
  history: SubmissionHistoryView,
): boolean {
  if (audit.sessionId !== history.sessionId) return false;
  const known = new Set(audit.knownTurnIds);
  return history.turns.some((turn) => !known.has(turn.turnId) && turn.user === audit.user);
}
