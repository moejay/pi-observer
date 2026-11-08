import test from "node:test";
import assert from "node:assert/strict";
import { parseConfig } from "../src/core.ts";
import { observerStatus } from "../src/status.ts";
import type { SavedAssessment } from "../src/view.ts";

const coverage = { total: 1, forwarded: 1, omitted: 0, truncated: 0, complete: true };
const saved: SavedAssessment = {
  version: 1,
  anchor: "a",
  turns: 2,
  at: "2026-11-08T00:00:00Z",
  model: "test/model",
  report: { summary: "No concerns observed.", progress: "Progressing.", intent: [], findings: [] },
  coverage: {
    receipts: coverage,
    transcript: coverage,
    incompleteGoalContext: false,
    forwardedTextChars: 10,
    maxInputChars: 1000,
    previousReportTruncated: false,
  },
  metrics: { toolCalls: 0, toolErrors: 0, completedAssistantTurns: 2, unverifiedUserMessages: 0 },
};
const base = { config: parseConfig(), running: false, cost: 0, current: { anchor: "a", turns: 2 } };

test("unreviewed session is not displayed as healthy", () => {
  const status = observerStatus(base);
  assert.match(status.text, /watching.*not assessed/);
  assert.doesNotMatch(status.text, /no concerns/);
  assert.equal(status.tone, "muted");
});

test("freshness distinguishes new input from newly completed turns", () => {
  assert.match(observerStatus({ ...base, saved }).text, /up to date/);
  assert.match(
    observerStatus({ ...base, saved, current: { anchor: "b", turns: 2 } }).text,
    /new activity/,
  );
  assert.match(
    observerStatus({ ...base, saved, current: { anchor: "b", turns: 3 } }).text,
    /1 turn ago/,
  );
  assert.match(
    observerStatus({ ...base, saved, current: { anchor: "b", turns: 5 } }).text,
    /3 turns ago/,
  );
});

test("a request or running turn immediately invalidates a previously healthy checkpoint", () => {
  const status = observerStatus({ ...base, saved, activityPending: true });
  assert.match(status.text, /new activity/);
  assert.doesNotMatch(status.text, /up to date/);
  assert.equal(status.tone, "muted");
});

test("limited coverage never receives a healthy status or zero-concern reassurance", () => {
  const limited = { ...saved, coverage: { ...saved.coverage, incompleteGoalContext: true } };
  const status = observerStatus({ ...base, saved: limited });
  assert.match(status.text, /limited context/);
  assert.doesNotMatch(status.text, /no concerns/);
  assert.equal(status.tone, "muted");
});

test("status priorities include running, paused, disabled checks, budget and errors", () => {
  assert.equal(
    observerStatus({ ...base, running: true, config: parseConfig({ enabled: false }) }).state,
    "reviewing",
  );
  assert.equal(
    observerStatus({ ...base, config: parseConfig({ enabled: false }) }).state,
    "paused",
  );
  assert.equal(
    observerStatus({ ...base, config: parseConfig({ lenses: [] }) }).state,
    "checks off",
  );
  assert.equal(observerStatus({ ...base, cost: 2 }).state, "budget reached");
  assert.equal(observerStatus({ ...base, error: "bad JSON" }).state, "review failed");
  assert.equal(observerStatus({ ...base, saved }).tone, "success");
});

test("findings use correct singular and plural wording", () => {
  const finding = {
    key: "repeat",
    lens: "efficiency" as const,
    severity: "warning" as const,
    confidence: "high" as const,
    title: "Repeated test",
    observation: "Repeated.",
    evidence: [{ id: "a", quote: "test" }],
    likelyCause: "Unknown.",
    suggestion: "Inspect first.",
  };
  const one = { ...saved, report: { ...saved.report, findings: [finding] } };
  assert.match(observerStatus({ ...base, saved: one }).text, /1 concern ·/);
  assert.equal(observerStatus({ ...base, saved: one }).tone, "warning");
  const two = {
    ...one,
    report: { ...one.report, findings: [finding, { ...finding, key: "other" }] },
  };
  assert.match(observerStatus({ ...base, saved: two }).text, /2 concerns ·/);
});
