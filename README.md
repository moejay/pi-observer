# Pi Observer

[![Checks](https://github.com/moejay/pi-observer/actions/workflows/checks-and-pages.yml/badge.svg)](https://github.com/moejay/pi-observer/actions/workflows/checks-and-pages.yml)
[![MIT](https://img.shields.io/badge/license-MIT-green.svg)](LICENSE)

A quiet, read-only [Pi](https://pi.dev) extension that reviews your session for **efficiency and instruction friction**, **confusion**, and **goal alignment**.

Your agent keeps working. The observer periodically takes a second look and gives you evidence-backed findings—without steering, interruptions, or extra messages in the agent's context.

**[Documentation & examples](https://moejay.github.io/pi-observer/)** · [Changelog](CHANGELOG.md) · [Contributing](CONTRIBUTING.md) · [Security & privacy](SECURITY.md)

## Install

Requires Pi **1.5.0+ (1.x)** and **Node.js 24+**. Runtime dependencies come from Pi; there is no build step.

```sh
pi install git:github.com/moejay/pi-observer@v1.0.0
```

Then run `/reload` in Pi, or start a new session. To try a local checkout instead:

```sh
pi -e ./src/index.ts
```

> Loading enables additional model calls using your Pi credentials. The current session model is used by default. Session excerpts may contain sensitive data; v1 does not automatically redact secrets.

## A quiet footer, a readable report

```text
Observer ◉ watching · 1 concern · 2 turns ago
```

Theme-aware status distinguishes reviewing, paused, budget reached, failed reviews, and incomplete goal context. It never presents unreviewed activity as healthy. Choose an expanded widget or hide the status in settings.

Open `/assess` for a short summary, actionable findings, progress, and your goal as understood from your messages. Press **d** for exact source quotes, coverage, model information, and cost details. Arrow keys or Page Up/Down scroll; Enter/Escape closes it.

Reports are snapshots: reopen one after a review finishes. “No concerns found” is not a correctness guarantee.

| Command                            | Action                                                                     |
| ---------------------------------- | -------------------------------------------------------------------------- |
| `/assess`                          | Read the latest report                                                     |
| `/assess now`                      | Request a background review, including while paused                        |
| `/assess details`                  | Open with evidence and review details expanded                             |
| `/assess settings`                 | Toggles, choices, and inputs; **Save** applies, **Cancel/Escape** discards |
| `/assess settings json`            | Advanced JSON editor                                                       |
| `/assess model`                    | Pick an observer model; `current` follows the working model                |
| `/assess model provider/model-id`  | Choose a model directly                                                    |
| `/assess pause` / `/assess resume` | Control automatic reviews                                                  |
| `/assess messages`                 | Inspect your original recorded messages                                    |
| `/assess ledger`                   | Compatibility alias for `/assess messages`                                 |
| `/assess help`                     | Show controls and limitations                                              |

Settings are **session-local**, saved on the active conversation branch, and restored on resume or `/reload`. They are not global defaults. RPC uses standard selection/input dialogs instead of a custom TUI screen.

## How it works

- One background LLM call evaluates all enabled checks. No classifier in v1.
- Default cadence: every **5 successful completed turns**, including tool-use turns, at least **30 seconds between review starts**.
- Unassessed tail activity is reviewed after the agent settles, including after an abort. Cooldown may delay it.
- Only one review runs at a time. Pending requests coalesce to the latest completed checkpoint, not a backlog; half-finished tool turns are not reviewed.
- Pause, branch navigation, reload, and shutdown cancel pending work. Late responses cannot replace another branch's report.
- Failed reviews do not automatically retry the same checkpoint; `/assess now` explicitly retries.

### Your goal comes from you

No separate goal-setting ceremony. The observer records input it sees directly from the interactive user. Interpretations of your outcome, current request, constraints, and decisions must cite those messages.

Assistant plans, tool output, generated summaries, RPC/extension input, and unverified older history cannot authorize goal changes. A proposal can contextualize your explicit approval but cannot approve itself. Constraints should remain unless you change them.

Messages from **before the observer was enabled** are not automatically trusted as user instructions. Limited context is shown openly; goal-drift findings are disabled when the recorded goal context is missing or shortened. Original messages survive compaction and remain branch-aware.

Citation matching and provenance are enforced in code. Whether a quote actually supports a goal interpretation remains an LLM judgment—not tamper-proof authorization.

## Controls and defaults

| Setting                         | Default                                  |
| ------------------------------- | ---------------------------------------- |
| Automatic reviews               | On                                       |
| Checks                          | Efficiency, confusion, staying on track  |
| Sensitivity                     | Balanced (`low`, `balanced`, `high`)     |
| Display                         | Footer (`status`, `widget`, `silent`)    |
| Observer model                  | Current session model                    |
| Review every / minimum interval | 5 turns / 30 seconds                     |
| Session budget                  | $2 of known reported observer spending   |
| Input / output limit            | 60,000 content characters / 2,500 tokens |
| Timeout                         | 60 seconds                               |

The budget gates new calls using known reported cost and conservative price estimates. It is a **soft limit**, not a provider-enforced cap; missing usage/pricing can limit accuracy. Manual reviews do not bypass it. Set the budget to zero to prevent new calls. Spending includes abandoned conversation branches; observer usage is shown separately from Pi's native accounting.

Sensitivity changes the review rubric, not a calibrated probability threshold. Input limits bound content, not JSON wrappers or the fixed observer prompt. Earlier user messages are preserved first; if they fill the window, goal-alignment findings are disabled rather than silently dropping constraints.

## Privacy and boundaries

Assessments send bounded user input, preceding assistant proposals, recent assistant text, tool arguments/results, effective working-agent instructions, and previous review context to the selected model provider. Thinking blocks and images are excluded.

**No automatic secret redaction.** Choose an appropriate provider or pause reviews for sensitive work. Pausing stops model calls but still records your input in the existing session file.

Reports, recorded messages, settings, and usage are custom session entries, never messages injected into the working agent's context. An extension shares Pi's process/filesystem permissions; an agent with shell or file access can potentially tamper with it. This is an **advisory observer, not a security boundary**. See [SECURITY.md](SECURITY.md).

## Develop

```sh
npm ci
npm run check
```

Checks cover formatting, strict types, deterministic offline tests, and site generation. No credentials or paid model calls are needed. [CONTRIBUTING.md](CONTRIBUTING.md) describes local preview, project structure, and releases.

The dependency-free documentation site is built from `docs/` into an allowlisted `dist/`. GitHub Pages publishes it only after release checks pass on `main`. There is no automatic npm publish workflow.

**Compatibility:** session storage retains the original `pi-assess.*` entry keys and `/assess` commands. Existing local sessions remain readable after the public package rename to `pi-observer`.

MIT licensed. Alerts, classifiers, and interventions are deliberately outside v1.
