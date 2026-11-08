import type { Config } from "./core.ts";
import type { SavedAssessment } from "./view.ts";

export interface ObserverStatus {
  text: string;
  tone: "accent" | "muted" | "warning" | "success" | "error";
  state: string;
  freshness: string;
}

/** Presentation policy only: a quiet observer must never imply unreviewed work is safe. */
export function observerStatus(input: {
  config: Config;
  saved?: SavedAssessment;
  running: boolean;
  cost: number;
  error?: string;
  current: { anchor: string; turns: number };
  activityPending?: boolean;
}): ObserverStatus {
  const { config, saved, running, cost, error, current } = input;
  let state = "watching";
  let icon = "◉";
  let tone: ObserverStatus["tone"] = "muted";
  if (running) {
    state = "reviewing";
    icon = "◌";
    tone = "accent";
  } else if (!config.enabled) {
    state = "paused";
    icon = "Ⅱ";
  } else if (config.lenses.length === 0) {
    state = "checks off";
    icon = "–";
  } else if (cost >= config.budgetUsd) {
    state = "budget reached";
    icon = "$";
    tone = "warning";
  } else if (error) {
    state = "review failed";
    icon = "!";
    tone = "error";
  }

  let freshness = "not assessed";
  const parts = [`Observer ${icon} ${state}`];
  if (saved) {
    const age = Math.max(0, current.turns - saved.turns);
    if (input.activityPending) freshness = "new activity";
    else if (current.anchor === saved.anchor) freshness = "up to date";
    else if (age === 0) freshness = "new activity";
    else freshness = `${age} ${age === 1 ? "turn" : "turns"} ago`;
    const count = saved.report.findings.length;
    if (count > 0) parts.push(`${count} ${count === 1 ? "concern" : "concerns"}`);
    else if (!saved.coverage.incompleteGoalContext) parts.push("no concerns seen");
    if (saved.coverage.incompleteGoalContext) parts.push("limited context");
    if (state === "watching") {
      if (count > 0) tone = "warning";
      else if (
        !input.activityPending &&
        !saved.coverage.incompleteGoalContext &&
        current.anchor === saved.anchor
      )
        tone = "success";
    }
  }
  parts.push(freshness);
  return { text: parts.join(" · "), tone, state, freshness };
}
