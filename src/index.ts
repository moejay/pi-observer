import { randomUUID } from "node:crypto";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import {
  assessmentSystemPrompt,
  buildSnapshot,
  parseAssessment,
  parseConfig,
  readReceipts,
  type Config,
  type SessionRecord,
} from "./core.ts";
import { ReviewScheduler, type Checkpoint } from "./scheduler.ts";
import { observerStatus } from "./status.ts";
import { readSavedAssessment } from "./saved-state.ts";
import { editSettings } from "./settings.ts";
import { plain, reportText, showText, type Overhead, type SavedAssessment } from "./view.ts";

const INPUT = "pi-assess.input";
const REPORT = "pi-assess.report";
const CONFIG = "pi-assess.config";
const USAGE = "pi-assess.usage";
const HELP = `Pi Observer observes; it never steers, blocks tools, or changes the agent's context.

/assess             Open a short, readable report (d toggles evidence/details)
/assess details     Open the report with evidence and review details
/assess now         Request a background assessment (also works while paused)
/assess pause       Cancel assessments; keep recording interactive intent
/assess resume      Resume automatic assessments
/assess settings    Toggles, choices, and inputs (Save/Cancel; this session only)
/assess settings json  Advanced JSON editor
/assess model       Choose an assessment model
/assess model provider/model-id
/assess messages    Read the original messages recorded from you
/assess ledger      Alias for /assess messages
/assess help        Show this help

Defaults: every 5 completed turns, at least 30 seconds apart, plus a review of unassessed activity after settling. One call at a time; pending work coalesces.

No required goal-setting step. Only interactive input observed while the extension is loaded is authoritative. Older history and RPC/extension input are not silently promoted. Assistant proposals are context only: a concrete user approval is still required. Exact citations are checked in code; their semantic interpretation remains an LLM judgment.

Settings persist on this session branch, including across /reload. Costs are cumulative over the entire session, including abandoned branches and failed responses with reported usage. The budget gates new calls using reported cost and a conservative estimate; provider pricing or missing usage can prevent exact accounting.

Assessments send bounded session excerpts and effective agent instructions to the configured assessment model (the active model by default). No reasoning blocks or images are forwarded. Reports and your recorded messages are stored in the session, not sent back to the working agent. This is an advisory observer, not a security boundary against an agent with filesystem access.`;

function obj(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}
function textContent(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .flatMap((block) => {
      const b = obj(block);
      return b?.type === "text" && typeof b.text === "string" ? [b.text] : [];
    })
    .join("\n");
}
function checkpoint(branch: readonly SessionRecord[]): Checkpoint {
  let anchor = "";
  let turns = 0;
  for (const entry of branch) {
    if (entry.type !== "message") continue;
    const m = obj(entry.message);
    if (!m || !["assistant", "toolResult", "user"].includes(String(m.role))) continue;
    anchor = entry.id;
    if (m.role === "assistant" && m.stopReason !== "error" && m.stopReason !== "aborted") turns++;
  }
  return { anchor, turns };
}
function overhead(entries: readonly SessionRecord[]): Overhead {
  const total: Overhead = { cost: 0, tokens: 0, calls: 0, unknownCostCalls: 0 };
  for (const entry of entries) {
    if (entry.type !== "custom" || entry.customType !== USAGE) continue;
    const data = obj(entry.data);
    if (data?.version !== 1) continue;
    total.calls++;
    if (typeof data.cost === "number" && Number.isFinite(data.cost) && data.cost >= 0)
      total.cost += data.cost;
    else total.unknownCostCalls++;
    if (typeof data.tokens === "number" && Number.isFinite(data.tokens) && data.tokens >= 0)
      total.tokens += data.tokens;
  }
  return total;
}

export default function assess(pi: ExtensionAPI): void {
  let ctx: ExtensionContext | undefined;
  let config = parseConfig();
  let saved: SavedAssessment | undefined;
  let scheduler: ReviewScheduler | undefined;
  let error: string | undefined;
  let epoch = 0;
  let closed = true;
  let activityPending = false;
  // Prevent a restarted scheduler overlapping a cancelled provider request.
  let activeReview: Promise<void> | undefined;

  function totals(): Overhead {
    return overhead(ctx?.sessionManager.getEntries() ?? []);
  }
  function render(): void {
    if (!ctx?.hasUI || closed) return;
    if (config.display === "silent") {
      ctx.ui.setStatus("pi-assess", undefined);
      ctx.ui.setWidget("pi-assess", undefined);
      return;
    }
    const current = checkpoint(ctx.sessionManager.getBranch());
    const costs = totals();
    const status = observerStatus({
      config,
      saved,
      running: scheduler?.running ?? false,
      cost: costs.cost,
      error,
      current,
      activityPending,
    });
    const label = ctx.mode === "tui" ? ctx.ui.theme.fg(status.tone, status.text) : status.text;
    ctx.ui.setStatus("pi-assess", label);
    ctx.ui.setWidget(
      "pi-assess",
      config.display === "widget"
        ? [
            label,
            plain(
              saved?.report.summary ?? "Not reviewed yet. /assess now to start a review.",
            ).slice(0, 180),
            ...(saved?.report.findings
              .slice(0, 2)
              .map((f) => plain(`• ${f.title}`).slice(0, 160)) ?? []),
            `$${costs.cost.toFixed(4)} spent / $${config.budgetUsd.toFixed(2)} budget · /assess to read more`,
          ]
        : undefined,
    );
  }

  async function evaluate(request: Checkpoint, signal: AbortSignal): Promise<void> {
    // A previous scheduler may still be unwinding after pause/settings/tree navigation.
    if (activeReview) await activeReview.catch(() => {});
    if (signal.aborted || closed || !ctx) return;
    const localCtx = ctx;
    const localConfig = { ...config };
    const localEpoch = epoch;
    const fullBranch = localCtx.sessionManager.getBranch();
    const through = fullBranch.findIndex((entry) => entry.id === request.anchor);
    if (through < 0) return;
    // A timer can fire while the NEXT turn's tools are running. Freeze coverage at
    // the requested completed checkpoint, never judge that half-finished turn.
    const branch = fullBranch.slice(0, through + 1);
    const sessionId = localCtx.sessionManager.getSessionId();
    const model =
      localConfig.model === "current"
        ? localCtx.model
        : (() => {
            const slash = localConfig.model.indexOf("/");
            return slash > 0
              ? localCtx.modelRegistry.find(
                  localConfig.model.slice(0, slash),
                  localConfig.model.slice(slash + 1),
                )
              : undefined;
          })();
    if (!model) throw new Error("Assessment model unavailable. Use /assess model.");
    if (!localCtx.modelRegistry.hasConfiguredAuth(model))
      throw new Error("Assessment model has no configured authentication.");
    if (localConfig.lenses.length === 0) return;
    const known = totals().cost;
    if (known >= localConfig.budgetUsd)
      throw new Error("Assessment budget reached. Increase budgetUsd in /assess settings.");
    const instructions = localCtx.getSystemPrompt();
    const instructionLimit = Math.floor(localConfig.maxInputChars / 5);
    const instructionExcerpt = instructions.slice(0, instructionLimit);
    const snapshot = buildSnapshot(
      branch,
      { ...localConfig, maxInputChars: localConfig.maxInputChars - instructionExcerpt.length },
      saved?.report,
    );
    const data = {
      ...snapshot,
      enabledLenses: localConfig.lenses,
      sensitivity: localConfig.sensitivity,
      effectiveAgentInstructions: {
        untrusted: true,
        text: instructionExcerpt,
        truncated: instructionExcerpt.length < instructions.length,
      },
    };
    const payload = JSON.stringify(data);
    // A UTF-8 byte bound is intentionally conservative compared with ordinary tokenization.
    const estimate =
      (Buffer.byteLength(payload + assessmentSystemPrompt, "utf8") * model.cost.input +
        localConfig.maxOutputTokens * model.cost.output) /
      1_000_000;
    if (!Number.isFinite(estimate) || known + estimate > localConfig.budgetUsd)
      throw new Error(
        "Estimated assessment cost exceeds the remaining budget. Increase budgetUsd or reduce input/output limits.",
      );
    const timeout = AbortSignal.timeout(Math.ceil(localConfig.timeoutSeconds * 1000));
    const combined = AbortSignal.any([signal, timeout]);
    error = undefined;
    const work = async () => {
      const response = await localCtx.modelRegistry
        .streamSimple(
          model,
          {
            systemPrompt: assessmentSystemPrompt,
            messages: [
              { role: "user", content: [{ type: "text", text: payload }], timestamp: Date.now() },
            ],
          },
          {
            signal: combined,
            maxTokens: localConfig.maxOutputTokens,
            reasoning: "low",
            cacheRetention: "none",
            sessionId: randomUUID(),
          },
        )
        .result();
      // Same-session cancelled calls still spent money. Never write to a replaced
      // runtime, but retain known usage across settings changes and tree navigation.
      if (closed || ctx?.sessionManager.getSessionId() !== sessionId) return;
      const cost = response.usage?.cost?.total;
      const tokens = response.usage?.totalTokens;
      pi.appendEntry(USAGE, {
        version: 1,
        at: new Date().toISOString(),
        model: `${model.provider}/${model.id}`,
        cost: Number.isFinite(cost) ? cost : null,
        tokens: Number.isFinite(tokens) ? tokens : null,
      });
      if (epoch !== localEpoch) return;
      if (combined.aborted) {
        if (timeout.aborted && !signal.aborted) throw new Error("Assessment timed out.");
        return;
      }
      if (response.stopReason === "error" || response.stopReason === "aborted")
        throw new Error(
          "Assessment model request failed. Check model authentication/connectivity.",
        );
      if (response.stopReason === "length")
        throw new Error("Assessment output was truncated. Increase maxOutputTokens.");
      const report = parseAssessment(textContent(response.content), snapshot, localConfig);
      saved = {
        version: 1,
        anchor: request.anchor,
        turns: request.turns,
        at: new Date().toISOString(),
        model: `${model.provider}/${model.id}`,
        report,
        coverage: snapshot.coverage,
        metrics: snapshot.metrics,
      };
      pi.appendEntry(REPORT, saved);
      error = undefined;
    };
    const promise = work();
    activeReview = promise;
    try {
      await promise;
    } finally {
      if (activeReview === promise) activeReview = undefined;
    }
  }

  function restart(): void {
    scheduler?.stop();
    epoch++;
    if (!ctx || closed) return;
    const baseline = saved
      ? { anchor: saved.anchor, turns: saved.turns }
      : checkpoint(ctx.sessionManager.getBranch());
    scheduler = new ReviewScheduler(
      config,
      evaluate,
      (err) => {
        error = plain(err instanceof Error ? err.message : String(err)).slice(0, 500);
        render();
      },
      render,
      baseline,
    );
    render();
  }
  function restore(context: ExtensionContext): void {
    ctx = context;
    closed = false;
    config = parseConfig();
    for (const entry of context.sessionManager.getBranch()) {
      if (entry.type !== "custom" || entry.customType !== CONFIG) continue;
      try {
        config = parseConfig(entry.data);
      } catch {
        /* Keep the last valid configuration. */
      }
    }
    saved = readSavedAssessment(context.sessionManager.getBranch());
    activityPending = false;
    error = undefined;
    restart();
  }
  function request(context: ExtensionContext, trigger: "periodic" | "settled" | "manual"): void {
    ctx = context;
    if (closed || (!config.enabled && trigger !== "manual")) return;
    scheduler?.request(checkpoint(context.sessionManager.getBranch()), trigger);
    render();
  }
  function setConfig(next: Config): void {
    config = next;
    pi.appendEntry(CONFIG, config);
    restart();
  }

  pi.on("session_start", (_event, context) => restore(context));
  pi.on("session_tree", (_event, context) => restore(context));
  pi.on("session_shutdown", (_event, context) => {
    closed = true;
    epoch++;
    scheduler?.stop();
    context.ui.setStatus("pi-assess", undefined);
    context.ui.setWidget("pi-assess", undefined);
    ctx = undefined;
  });
  pi.on("input", (event, context) => {
    if (event.text.trim()) {
      ctx = context;
      activityPending = true;
      render();
    }
    if (event.source !== "interactive" || !event.text.trim()) return;
    // Capture provenance here, not by treating every persisted user-role message as human.
    // This receipt never participates in the working agent's context.
    const branch = context.sessionManager.getBranch();
    let proposal: { id: string; text: string } | undefined;
    for (let i = branch.length - 1; i >= 0; i--) {
      const entry = branch[i];
      if (entry.type !== "message" || entry.message.role !== "assistant") continue;
      const text = textContent(entry.message.content);
      if (text) proposal = { id: entry.id, text };
      break;
    }
    pi.appendEntry(INPUT, {
      version: 1,
      text: event.text,
      timestamp: Date.now(),
      ...(proposal ? { proposal } : {}),
    });
  });
  pi.on("turn_start", (_event, context) => {
    ctx = context;
    activityPending = true;
    render();
  });
  pi.on("turn_end", (event, context) => {
    activityPending = false;
    if (event.outcome === "completed") request(context, "periodic");
    else {
      ctx = context;
      render();
    }
  });
  pi.on("agent_settled", (_event, context) => {
    activityPending = false;
    request(context, "settled");
  });

  pi.registerCommand("assess", {
    description: "Inspect the session observer, request a review, or adjust settings",
    getArgumentCompletions(prefix) {
      return [
        "now",
        "details",
        "pause",
        "resume",
        "settings",
        "model",
        "messages",
        "ledger",
        "help",
      ]
        .filter((value) => value.startsWith(prefix))
        .map((value) => ({ value, label: value }));
    },
    async handler(args, context) {
      ctx = context;
      const command = args.trim();
      try {
        if (!command || command === "details") {
          const costs = totals();
          await showText(context, "Pi Observer", reportText(saved, costs, config, error), {
            detailsBody: reportText(saved, costs, config, error, true),
            startWithDetails: command === "details",
          });
          return;
        }
        if (command === "help") {
          await showText(context, "Pi Observer help", HELP);
          return;
        }
        if (command === "now") {
          request(context, "manual");
          if (context.hasUI)
            context.ui.notify(
              "Assessment requested in the background. /assess to inspect results.",
              "info",
            );
          return;
        }
        if (command === "pause" || command === "resume") {
          setConfig(parseConfig({ ...config, enabled: command === "resume" }));
          if (command === "resume" && context.isIdle()) request(context, "settled");
          return;
        }
        if (command === "settings") {
          const next = await editSettings(context, config);
          if (next) setConfig(next);
          return;
        }
        if (command === "settings json") {
          if (!context.hasUI) return;
          const edited = await context.ui.editor(
            "Pi Observer · Advanced session settings (JSON)",
            JSON.stringify(config, null, 2),
          );
          if (edited === undefined) return;
          setConfig(parseConfig(JSON.parse(edited)));
          return;
        }
        if (command === "model" || command.startsWith("model ")) {
          let selection = command.slice(5).trim();
          if (!selection) {
            if (!context.hasUI) return;
            selection =
              (await context.ui.select("Assessment model", [
                "current",
                ...context.modelRegistry.getAvailable().map((m) => `${m.provider}/${m.id}`),
              ])) ?? "";
            if (!selection) return;
          }
          if (selection !== "current") {
            const slash = selection.indexOf("/");
            if (
              slash <= 0 ||
              !context.modelRegistry.find(selection.slice(0, slash), selection.slice(slash + 1))
            )
              throw new Error("Unknown model; use provider/model-id or current.");
          }
          setConfig(parseConfig({ ...config, model: selection }));
          return;
        }
        if (command === "messages" || command === "ledger") {
          const messages = readReceipts(context.sessionManager.getBranch());
          const intro =
            "These are your original messages recorded while the observer was enabled.\nOnly your messages can establish or change the goal.\n\n";
          const body = messages.length
            ? messages
                .map(
                  (message, index) =>
                    `Your message ${index + 1}\n${message.text}\n\nSource: ${message.id}${message.proposal ? `\n\nWhat the assistant said before you replied (context only):\n${message.proposal.text}` : ""}`,
                )
                .join("\n\n────\n\n")
            : "No messages have been recorded from you yet. Continue chatting normally.\nMessages from before the observer was enabled are not automatically treated as your instructions.";
          await showText(context, "Your recorded messages", intro + body);
          return;
        }
        throw new Error("Unknown assess command. Try /assess help.");
      } catch (err) {
        if (context.hasUI)
          context.ui.notify(plain(err instanceof Error ? err.message : String(err)), "error");
      }
    },
  });
}
