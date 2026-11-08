import test from "node:test";
import assert from "node:assert/strict";
import { buildSnapshot, parseConfig, type SessionRecord } from "../src/core.ts";
import { readSavedAssessment } from "../src/saved-state.ts";
import type { SavedAssessment } from "../src/view.ts";

function fixture() {
  const branch: SessionRecord[] = [
    {
      id: "input",
      type: "custom",
      customType: "pi-assess.input",
      data: { version: 1, text: "Keep the API unchanged.", timestamp: 1 },
    },
    {
      id: "assistant",
      type: "message",
      message: { role: "assistant", content: "Renamed the public method.", stopReason: "stop" },
    },
  ];
  const snapshot = buildSnapshot(branch, parseConfig());
  const saved: SavedAssessment = {
    version: 1,
    anchor: "assistant",
    turns: 1,
    at: "2026-11-08T00:00:00Z",
    model: "test/model",
    report: {
      summary: "Scope may have changed.",
      progress: "The agent changed a public method.",
      intent: [
        {
          kind: "constraint",
          text: "Preserve the API.",
          sources: [{ id: "input", quote: "Keep the API unchanged." }],
        },
      ],
      findings: [
        {
          key: "api",
          lens: "alignment",
          severity: "warning",
          confidence: "high",
          title: "API changed",
          observation: "The method was renamed.",
          evidence: [{ id: "assistant", quote: "Renamed the public method." }],
          likelyCause: "Scope expansion.",
          suggestion: "Keep the original name.",
        },
      ],
    },
    coverage: snapshot.coverage,
    metrics: snapshot.metrics,
  };
  const entry: SessionRecord = {
    id: "report",
    type: "custom",
    customType: "pi-assess.report",
    data: saved,
  };
  return { branch, saved, entry };
}

test("saved reports restore only with valid structure and original source citations", () => {
  const { branch, saved, entry } = fixture();
  assert.deepEqual(readSavedAssessment([...branch, entry]), saved);
});

test("malformed stored fields are skipped rather than crashing rendering", () => {
  const { branch, saved, entry } = fixture();
  for (const data of [
    null,
    { ...saved, coverage: {} },
    { ...saved, metrics: {} },
    { ...saved, report: { ...saved.report, findings: [null] } },
    {
      ...saved,
      report: { ...saved.report, intent: [{ kind: "constraint", text: "oops", sources: [] }] },
    },
    { ...saved, turns: NaN },
    { ...saved, at: "not a date" },
    { ...saved, version: 2 },
    {
      ...saved,
      coverage: { ...saved.coverage, receipts: { ...saved.coverage.receipts, omitted: 99 } },
    },
  ])
    assert.equal(readSavedAssessment([...branch, { ...entry, data }]), undefined);
});

test("damaged latest entry falls back to a previous valid report", () => {
  const { branch, saved, entry } = fixture();
  assert.deepEqual(
    readSavedAssessment([
      ...branch,
      entry,
      { ...entry, id: "bad", data: { ...saved, coverage: {} } },
    ]),
    saved,
  );
});

test("saved report cannot invent sources or cross to an absent branch", () => {
  const { branch, saved, entry } = fixture();
  const changed = {
    ...saved,
    report: {
      ...saved.report,
      intent: [
        {
          ...saved.report.intent[0],
          sources: [{ id: "assistant", quote: "Renamed the public method." }],
        },
      ],
    },
  };
  assert.equal(readSavedAssessment([...branch, { ...entry, data: changed }]), undefined);
  assert.equal(readSavedAssessment([entry]), undefined);
  assert.equal(
    readSavedAssessment([...branch, { ...entry, data: { ...saved, anchor: "other-branch" } }]),
    undefined,
  );
});
