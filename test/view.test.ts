import { test } from "node:test";
import assert from "node:assert/strict";
import type { ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import { parseConfig } from "../src/core.ts";
import { plain, reportText, showText, type SavedAssessment } from "../src/view.ts";

const costs = { cost: 0.1, tokens: 100, calls: 2, unknownCostCalls: 0 };
const complete = { total: 2, forwarded: 2, omitted: 0, truncated: 0, complete: true };
const assessment: SavedAssessment = {
  version: 1,
  anchor: "entry-123",
  turns: 10,
  at: "2026-11-08T14:00:00Z",
  model: "test/model",
  report: {
    summary: "Progress is steady, but one test was repeated without a change.",
    progress: "Implementation is complete; validation is underway.",
    intent: [
      {
        kind: "constraint",
        text: "Do not change production code.",
        sources: [{ id: "user-456", quote: "Don't change production code" }],
      },
    ],
    findings: [
      {
        key: "repeat",
        lens: "efficiency",
        severity: "warning",
        confidence: "high",
        title: "Repeated the same failing test",
        observation: "The same test ran twice without a code change.",
        evidence: [{ id: "tool-789", quote: "npm test failed" }],
        likelyCause: "The failure may not have been inspected.",
        suggestion: "Inspect the failure before rerunning.",
      },
    ],
  },
  coverage: {
    receipts: complete,
    transcript: complete,
    incompleteGoalContext: false,
    forwardedTextChars: 1000,
    maxInputChars: 60000,
    previousReportTruncated: false,
  },
  metrics: { toolCalls: 12, toolErrors: 2, completedAssistantTurns: 10, unverifiedUserMessages: 3 },
};

test("displayed evidence cannot inject terminal controls", () => {
  const output = plain("\x1b[31mred\x1b[0m\x1b]0;bad title\x07\nnext\tcolumn\b");
  assert.equal(output, "red\nnext    column");
  assert.doesNotMatch(output, /[\x00-\x08\x0b-\x1f\x7f-\x9f]/);
});

test("unassessed view distinguishes unknown coverage and unavailable costs", () => {
  const text = reportText(
    undefined,
    { ...costs, unknownCostCalls: 1 },
    parseConfig(),
    "Invalid JSON",
  );
  assert.match(text, /Not assessed yet/);
  assert.match(text, /Cost unavailable for 1 call/);
  assert.match(text, /Previous findings may be stale/);
  assert.match(text, /actual spending may be higher/);
});

test("default report puts useful findings before goal interpretation and hides technical clutter", () => {
  const text = reportText(assessment, costs, parseConfig());
  assert.ok(text.indexOf("SUMMARY") < text.indexOf("FINDINGS"));
  assert.ok(text.indexOf("FINDINGS") < text.indexOf("YOUR GOAL"));
  assert.match(text, /1\. Repeated the same failing test/);
  assert.match(text, /What happened: The same test ran twice/);
  assert.match(text, /Try next: Inspect the failure/);
  assert.match(text, /Boundary: Do not change production code/);
  assert.match(text, /Press d for evidence/);
  assert.doesNotMatch(
    text,
    /receipts|authority|raw user-role|entry-123|user-456|tool-789|test\/model|\nREVIEW DETAILS\n|npm test failed/i,
  );
});

test("expanded report preserves exact evidence and explains message provenance in plain language", () => {
  const text = reportText(assessment, costs, parseConfig(), undefined, true);
  assert.match(text, /“npm test failed” \[tool-789\]/);
  assert.match(text, /You said: “Don't change production code” \[user-456\]/);
  assert.match(text, /Your recorded messages: 2 of 2 included; 0 shortened/);
  assert.match(text, /Model: test\/model/);
  assert.match(text, /Only messages recorded directly from you can establish or change the goal/);
  assert.doesNotMatch(text, /receipts|intent authority|raw user-role/i);
});

test("limited goal context stays visible even when technical details are hidden", () => {
  const limited = {
    ...assessment,
    coverage: { ...assessment.coverage, incompleteGoalContext: true },
  };
  const text = reportText(limited, costs, parseConfig());
  assert.match(text, /Limited context/);
  assert.match(text, /Staying-on-track checks were skipped/);
});

test("no findings and unknown goal are not presented as a correctness guarantee", () => {
  const unknown = { ...assessment, report: { ...assessment.report, findings: [], intent: [] } };
  const text = reportText(unknown, costs, parseConfig());
  assert.match(text, /No concerns found in the activity reviewed/);
  assert.match(text, /does not guarantee the work is correct/);
  assert.match(text, /don't need to set a separate goal/);
});

test("report screen toggles details locally with d and resets to summary", async () => {
  type Factory = Parameters<ExtensionCommandContext["ui"]["custom"]>[0];
  type Args = Parameters<Factory>;
  let renders = 0;
  // SAFETY: this fake implements exactly the UI surface showText uses; no real TUI.
  const ctx = {
    hasUI: true,
    mode: "tui",
    ui: {
      custom: async (factory: Factory) => {
        const screen = await factory(
          {
            terminal: { rows: 24 },
            requestRender: () => {
              renders++;
            },
          } as Args[0],
          { fg: (_key: string, text: string) => text, bold: (text: string) => text } as Args[1],
          { matches: () => false } as unknown as Args[2],
          () => {},
        );
        assert.match(screen.render(80).join("\n"), /Summary only/);
        screen.handleInput?.("d");
        assert.match(screen.render(80).join("\n"), /Evidence included/);
        screen.handleInput?.("d");
        assert.match(screen.render(80).join("\n"), /Summary only/);
      },
    },
  } as unknown as ExtensionCommandContext;
  await showText(ctx, "Pi Assess", "Summary only", { detailsBody: "Evidence included" });
  assert.equal(renders, 2);
});
