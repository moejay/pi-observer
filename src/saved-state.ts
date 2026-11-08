import {
  buildSnapshot,
  parseAssessment,
  parseConfig,
  type Coverage,
  type SessionRecord,
} from "./core.ts";
import type { SavedAssessment } from "./view.ts";

type ObjectValue = Record<string, unknown>;
function object(value: unknown): ObjectValue {
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new Error("Invalid saved object");
  return value as ObjectValue;
}
function count(value: unknown): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0)
    throw new Error("Invalid saved count");
  return value;
}
function flag(value: unknown): boolean {
  if (typeof value !== "boolean") throw new Error("Invalid saved flag");
  return value;
}
function text(value: unknown, max: number): string {
  if (typeof value !== "string" || !value.trim() || value.length > max)
    throw new Error("Invalid saved text");
  return value;
}
function coverage(value: unknown): Coverage {
  const data = object(value);
  const result = {
    total: count(data.total),
    forwarded: count(data.forwarded),
    omitted: count(data.omitted),
    truncated: count(data.truncated),
    complete: flag(data.complete),
  };
  if (
    result.total !== result.forwarded + result.omitted ||
    result.truncated > result.forwarded ||
    result.complete !== (result.omitted === 0 && result.truncated === 0)
  )
    throw new Error("Invalid saved coverage");
  return result;
}

/** Persisted extension data is still an I/O boundary; damaged entries must not break Pi. */
export function readSavedAssessment(branch: readonly SessionRecord[]): SavedAssessment | undefined {
  for (let index = branch.length - 1; index >= 0; index--) {
    const entry = branch[index];
    if (entry.type !== "custom" || entry.customType !== "pi-assess.report") continue;
    try {
      const data = object(entry.data);
      if (data.version !== 1) continue;
      const anchor = text(data.anchor, 256);
      const through = branch
        .slice(0, index)
        .findIndex((source) => source.id === anchor && source.type === "message");
      if (through < 0) continue;
      const at = text(data.at, 100);
      if (!Number.isFinite(Date.parse(at))) continue;
      const c = object(data.coverage);
      const maxInputChars = count(c.maxInputChars);
      const forwardedTextChars = count(c.forwardedTextChars);
      if (maxInputChars < 1 || maxInputChars > 1_000_000 || forwardedTextChars > maxInputChars)
        continue;
      const savedCoverage = {
        receipts: coverage(c.receipts),
        transcript: coverage(c.transcript),
        incompleteGoalContext: flag(c.incompleteGoalContext),
        forwardedTextChars,
        maxInputChars,
        previousReportTruncated: flag(c.previousReportTruncated),
      };
      const m = object(data.metrics);
      const metrics = {
        toolCalls: count(m.toolCalls),
        toolErrors: count(m.toolErrors),
        completedAssistantTurns: count(m.completedAssistantTurns),
        unverifiedUserMessages: count(m.unverifiedUserMessages),
      };
      const policy = { ...parseConfig(), maxInputChars };
      // Recheck structure AND citations against original branch sources, not the report's claims.
      // Omitting generated prior-report context gives a superset of the original evidence window.
      const snapshot = buildSnapshot(branch.slice(0, through + 1), policy);
      const report = parseAssessment(JSON.stringify(data.report), snapshot, policy);
      return {
        version: 1,
        anchor,
        turns: count(data.turns),
        at,
        model: text(data.model, 512),
        report,
        coverage: savedCoverage,
        metrics,
      };
    } catch {
      // Skip malformed or incompatible entries; an earlier valid report may still be usable.
    }
  }
  return undefined;
}
