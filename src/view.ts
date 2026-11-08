import type { ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import {
  matchesKey,
  stripTerminalSequences,
  truncateToWidth,
  wrapTextWithAnsi,
} from "@earendil-works/pi-tui";
import type { AssessmentReport, Config, Snapshot } from "./core.ts";

export interface SavedAssessment {
  version: 1;
  anchor: string;
  turns: number;
  at: string;
  model: string;
  report: AssessmentReport;
  coverage: Snapshot["coverage"];
  metrics: Snapshot["metrics"];
}
export interface Overhead {
  cost: number;
  tokens: number;
  calls: number;
  unknownCostCalls: number;
}

/** Never let observed tool/model text inject terminal control sequences. */
export function plain(text: string): string {
  return stripTerminalSequences(text)
    .replace(/[\u0000-\u0008\u000b-\u001f\u007f-\u009f]/g, "")
    .replace(/\t/g, "    ");
}

const lensLabels = {
  efficiency: "Efficiency",
  confusion: "Confusion",
  alignment: "Staying on track",
};
const intentLabels = {
  outcome: "Goal",
  request: "Current request",
  constraint: "Boundary",
  decision: "Decision",
};
const severityLabels = { info: "Worth noting", warning: "Needs attention", critical: "Important" };

function reviewedAt(at: string): string {
  const date = new Date(at);
  return Number.isNaN(date.getTime()) ? at : date.toLocaleString();
}

export function reportText(
  saved: SavedAssessment | undefined,
  overhead: Overhead,
  config: Config,
  error?: string,
  details = false,
): string {
  const lines: string[] = [];
  if (error) lines.push(`Review failed: ${error}`, "Previous findings may be stale.", "");
  if (!saved) {
    lines.push("Not assessed yet. Run /assess now to review the session.");
  } else {
    lines.push(
      "SUMMARY",
      saved.report.summary,
      "",
      `Last reviewed: ${reviewedAt(saved.at)}`,
      "",
      "FINDINGS",
    );
    if (saved.report.findings.length) {
      saved.report.findings.forEach((finding, index) => {
        lines.push(
          `${index + 1}. ${finding.title}`,
          `   ${lensLabels[finding.lens]} · ${severityLabels[finding.severity]} · ${finding.confidence} confidence`,
          "",
          `   What happened: ${finding.observation}`,
          `   Try next: ${finding.suggestion}`,
        );
        if (details)
          lines.push(
            `   Possible cause: ${finding.likelyCause}`,
            "   Evidence:",
            ...finding.evidence.map((source) => `     “${source.quote}” [${source.id}]`),
          );
        lines.push("");
      });
    } else {
      lines.push(
        "No concerns found in the activity reviewed.",
        "This does not guarantee the work is correct.",
        "",
      );
    }
    lines.push(
      "PROGRESS",
      saved.report.progress,
      "",
      "YOUR GOAL — as understood from your messages",
    );
    if (saved.report.intent.length) {
      for (const intent of saved.report.intent) {
        lines.push(`${intentLabels[intent.kind]}: ${intent.text}`);
        if (details)
          lines.push(
            ...intent.sources.map((source) => `  You said: “${source.quote}” [${source.id}]`),
          );
      }
    } else {
      lines.push(
        "Not enough of your messages were recorded to identify the goal yet.",
        "Keep chatting normally; you don't need to set a separate goal.",
      );
    }
    if (saved.coverage.incompleteGoalContext)
      lines.push(
        "",
        "Limited context: some of your messages are missing or shortened.",
        "Staying-on-track checks were skipped to avoid guessing your goal.",
      );
  }
  lines.push(
    "",
    `${config.enabled ? "Watching" : "Paused"} · $${overhead.cost.toFixed(4)} spent / $${config.budgetUsd.toFixed(2)} budget`,
  );
  if (overhead.unknownCostCalls)
    lines.push(
      `Cost unavailable for ${overhead.unknownCostCalls} call(s); actual spending may be higher.`,
    );
  if (details) {
    lines.push(
      "",
      "REVIEW DETAILS",
      `Checks: ${config.lenses.map((lens) => lensLabels[lens]).join(", ") || "none"}`,
      `${overhead.calls} model calls · ${overhead.tokens.toLocaleString()} tokens`,
    );
    if (saved)
      lines.push(
        `Model: ${saved.model}`,
        `Reviewed through entry ${saved.anchor} (${saved.turns} completed turns).`,
        `Your recorded messages: ${saved.coverage.receipts.forwarded} of ${saved.coverage.receipts.total} included; ${saved.coverage.receipts.truncated} shortened.`,
        `Activity excerpts: ${saved.coverage.transcript.forwarded} of ${saved.coverage.transcript.total} included; ${saved.coverage.transcript.truncated} shortened.`,
        `Tool activity: ${saved.metrics.toolCalls} calls, ${saved.metrics.toolErrors} errors.`,
      );
    lines.push(
      "",
      "Only messages recorded directly from you can establish or change the goal.",
      "Messages from before the observer was enabled, automation (RPC), or extensions cannot change it.",
    );
  }
  lines.push(
    "",
    details
      ? "Press d to hide evidence and review details."
      : "Press d for evidence and review details.",
    "/assess now: review again · /assess messages: see your original messages",
  );
  return plain(lines.join("\n"));
}

/** Explicitly opened report, not a modal that appears while the agent is working. */
export async function showText(
  ctx: ExtensionCommandContext,
  title: string,
  body: string,
  options: { detailsBody?: string; startWithDetails?: boolean } = {},
): Promise<void> {
  if (!ctx.hasUI) return;
  if (ctx.mode !== "tui") {
    ctx.ui.notify(plain(options.startWithDetails ? (options.detailsBody ?? body) : body), "info");
    return;
  }
  await ctx.ui.custom<void>((tui, theme, kb, done) => {
    let offset = 0;
    let content: string[] = [];
    let height = 16;
    let expanded = options.startWithDetails ?? false;
    const headings = new Set([
      "SUMMARY",
      "FINDINGS",
      "PROGRESS",
      "YOUR GOAL — as understood from your messages",
      "REVIEW DETAILS",
    ]);
    return {
      render(width: number): string[] {
        height = Math.max(1, Math.min(30, tui.terminal.rows - 7));
        const displayed = expanded ? (options.detailsBody ?? body) : body;
        content = plain(displayed)
          .split("\n")
          .flatMap((line) => {
            const styled = headings.has(line) ? theme.fg("accent", theme.bold(line)) : line;
            return wrapTextWithAnsi(styled, Math.max(1, width));
          });
        offset = Math.min(offset, Math.max(0, content.length - height));
        return [
          truncateToWidth(theme.fg("accent", theme.bold(title)), width),
          ...content.slice(offset, offset + height).map((line) => truncateToWidth(line, width)),
          truncateToWidth(
            theme.fg(
              "dim",
              `↑/↓ scroll · PgUp/PgDn page${options.detailsBody ? ` · d ${expanded ? "summary" : "details"}` : ""} · Enter/Esc close · ${offset + 1}/${content.length}`,
            ),
            width,
          ),
        ];
      },
      handleInput(data: string): void {
        if (kb.matches(data, "tui.select.cancel") || kb.matches(data, "tui.select.confirm")) {
          done();
          return;
        }
        if (options.detailsBody && matchesKey(data, "d")) {
          expanded = !expanded;
          offset = 0;
        } else if (kb.matches(data, "tui.select.up")) offset = Math.max(0, offset - 1);
        else if (kb.matches(data, "tui.select.down"))
          offset = Math.min(Math.max(0, content.length - height), offset + 1);
        else if (kb.matches(data, "tui.select.pageUp")) offset = Math.max(0, offset - height);
        else if (kb.matches(data, "tui.select.pageDown"))
          offset = Math.min(Math.max(0, content.length - height), offset + height);
        else return;
        tui.requestRender();
      },
      invalidate() {},
    };
  });
}
