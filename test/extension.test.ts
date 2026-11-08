import test, { type TestContext } from "node:test";
import assert from "node:assert/strict";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import assess from "../src/index.ts";
import {
  parseConfig,
  readReceipts,
  type AssessmentReport,
  type Config,
  type SessionRecord,
  type Snapshot,
} from "../src/core.ts";
import type { SavedAssessment } from "../src/view.ts";

type Handler = (event: Record<string, unknown>, context: ExtensionContext) => unknown;
type Command = { handler: (args: string, context: ExtensionContext) => Promise<void> };
type Payload = Snapshot & { effectiveAgentInstructions: { text: string; untrusted: boolean } };
const validReport: AssessmentReport = {
  intent: [],
  findings: [],
  summary: "Independent review completed.",
  progress: "Work is ongoing.",
};
function response(text = JSON.stringify(validReport), cost = 0.02, tokens = 42) {
  return {
    content: [{ type: "text", text }],
    stopReason: "stop",
    usage: { cost: { total: cost }, totalTokens: tokens },
  };
}
function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason: Error) => void;
  const promise = new Promise<T>((yes, no) => {
    resolve = yes;
    reject = no;
  });
  return { promise, resolve, reject };
}
type Call = {
  payload: Payload;
  options: { signal: AbortSignal; maxTokens: number; reasoning: string; cacheRetention: string };
  input: { systemPrompt: string; messages: unknown[]; tools?: unknown };
  result: ReturnType<typeof deferred<ReturnType<typeof response>>>;
};
const flush = async () => {
  await new Promise<void>((resolve) => setImmediate(resolve));
};

/** All provider calls end here: never use a real registry, credential, or network. */
function harness(t: TestContext, overrides: Partial<Config> = {}) {
  let sequence = 0;
  let branch: SessionRecord[] = [];
  const entries: SessionRecord[] = [];
  const handlers = new Map<string, Handler>();
  const commands = new Map<string, Command>();
  const calls: Call[] = [];
  const statuses: (string | undefined)[] = [];
  const notifications: string[] = [];
  const writes: SessionRecord[] = [];
  const selections: string[] = [];
  let editorValue: string | undefined;
  const model = { provider: "fake", id: "offline", cost: { input: 1, output: 1 } };
  function add(entry: Omit<SessionRecord, "id">): SessionRecord {
    const saved = { ...entry, id: `entry-${++sequence}` };
    branch.push(saved);
    entries.push(saved);
    return saved;
  }
  function context(instructions = "Follow the real user request.") {
    const contextBranch = branch;
    // SAFETY: the fixture implements only the context surface used by index.ts;
    // no Pi runtime/session file or real model registry is involved.
    return {
      hasUI: true,
      mode: "rpc",
      model,
      isIdle: () => false,
      getSystemPrompt: () => instructions,
      sessionManager: {
        getBranch: () => contextBranch,
        getEntries: () => entries,
        getSessionId: () => "fake-session",
      },
      modelRegistry: {
        hasConfiguredAuth: () => true,
        find: (provider: string, id: string) =>
          provider === model.provider && id === model.id ? model : undefined,
        getAvailable: () => [model],
        streamSimple: (_model: unknown, input: Call["input"], options: Call["options"]) => {
          const result = deferred<ReturnType<typeof response>>();
          // SAFETY: index.ts always sends exactly one text-only user message.
          const messages = input.messages as { content: { text: string }[] }[];
          calls.push({
            input,
            options,
            payload: JSON.parse(messages[0].content[0].text) as Payload,
            result,
          });
          return { result: () => result.promise };
        },
      },
      ui: {
        setStatus: (_key: string, value: string | undefined) => {
          statuses.push(value);
        },
        setWidget: () => {},
        notify: (text: string) => {
          notifications.push(text);
        },
        editor: async () => editorValue,
        select: async (_title: string, options: string[]) => {
          const prefix = selections.shift();
          return options.find((option) => prefix !== undefined && option.startsWith(prefix));
        },
      },
    } as unknown as ExtensionContext;
  }
  const fakeAPI = {
    on: (name: string, handler: Handler) => {
      handlers.set(name, handler);
    },
    registerCommand: (name: string, command: Command) => {
      commands.set(name, command);
    },
    appendEntry: (customType: string, data: unknown) => {
      writes.push(add({ type: "custom", customType, data }));
    },
  };
  // SAFETY: overloaded Pi registration types are erased at this fake boundary.
  // Fail closed on every other API, notably registerTool/sendMessage/sendUserMessage.
  const api = new Proxy(fakeAPI, {
    get(target, key) {
      assert.ok(Object.hasOwn(target, key), `Observer accessed unexpected API: ${String(key)}`);
      return Reflect.get(target, key);
    },
  }) as unknown as ExtensionAPI;
  add({
    type: "custom",
    customType: "pi-assess.config",
    data: parseConfig({ minIntervalSeconds: 0, ...overrides }),
  });
  let ctx = context();
  function emit(name: string, event: Record<string, unknown> = {}) {
    const handler = handlers.get(name);
    assert.ok(handler, `Missing ${name} handler`);
    return handler(event, ctx);
  }
  function load() {
    handlers.clear();
    commands.clear();
    assess(api);
    emit("session_start");
  }
  async function command(args: string) {
    await commands.get("assess")!.handler(args, ctx);
  }
  function custom(type: string) {
    return writes.filter((entry) => entry.customType === `pi-assess.${type}`);
  }
  function turn(outcome = "completed", stopReason = "stop") {
    add({
      type: "message",
      message: {
        role: "assistant",
        content: [{ type: "text", text: "Working on the task." }],
        stopReason,
      },
    });
    return emit("turn_end", { outcome });
  }
  load();
  t.after(async () => {
    emit("session_shutdown");
    for (const call of calls) call.result.resolve(response());
    await flush();
  });
  return {
    entries,
    writes,
    calls,
    statuses,
    notifications,
    selections,
    add,
    emit,
    command,
    custom,
    turn,
    async settings(value: Partial<Config>) {
      editorValue = JSON.stringify(parseConfig(value));
      await command("settings json");
    },
    async finish(index = calls.length - 1, value = response()) {
      calls[index].result.resolve(value);
      await flush();
    },
    switchBranch(next: SessionRecord[], instructions: string) {
      branch = next;
      ctx = context(instructions);
      emit("session_tree");
    },
    reload() {
      emit("session_shutdown");
      ctx = context();
      load();
    },
  };
}

test("settings command applies only explicitly saved interactive changes", async (t) => {
  const h = harness(t);
  h.selections.push("Automatic reviews", "Cancel");
  await h.command("settings");
  assert.equal(h.custom("config").length, 0);
  h.selections.push("Automatic reviews", "Save");
  await h.command("settings");
  assert.equal((h.custom("config").at(-1)!.data as Config).enabled, false);
  assert.match(h.statuses.at(-1)!, /paused/);
  assert.equal(h.calls.length, 0);
});

test("new input and turn start immediately refresh a previously up-to-date footer", async (t) => {
  const h = harness(t);
  h.turn();
  await h.command("now");
  await flush();
  await h.finish();
  assert.match(h.statuses.at(-1)!, /up to date/);
  h.emit("input", { source: "interactive", text: "Now investigate the timeout." });
  assert.match(h.statuses.at(-1)!, /new activity/);
  h.emit("turn_start");
  assert.match(h.statuses.at(-1)!, /new activity/);
  assert.equal(h.calls.length, 1);
});

test("input provenance: only nonempty interactive events create non-context receipts", async (t) => {
  const h = harness(t);
  h.add({ type: "message", message: { role: "user", content: "Old history is not authority." } });
  const proposal = h.add({
    type: "message",
    message: { role: "assistant", content: [{ type: "text", text: "Shall I write tests?" }] },
  });
  h.emit("input", { source: "rpc", text: "Deploy from RPC." });
  h.emit("input", { source: "extension", text: "Deploy from extension." });
  h.emit("input", { source: "interactive", text: "  " });
  assert.equal(h.custom("input").length, 0);
  assert.equal(
    h.emit("input", { source: "interactive", text: "Write tests, do not deploy." }),
    undefined,
  );
  const receipts = readReceipts(h.entries);
  assert.equal(receipts.length, 1);
  assert.equal(receipts[0].text, "Write tests, do not deploy.");
  assert.deepEqual(receipts[0].proposal, { id: proposal.id, text: "Shall I write tests?" });
  assert.equal(h.custom("input")[0].type, "custom");
  // Pi persists the actual user message after the input handlers return.
  h.add({ type: "message", message: { role: "user", content: "Write tests, do not deploy." } });
  await h.command("now");
  await flush();
  assert.deepEqual(h.calls[0].payload.receipts, receipts);
  assert.equal(h.calls[0].payload.metrics.unverifiedUserMessages, 2);
  assert.match(
    h.calls[0].payload.evidence.find((e) => e.role === "user")!.text,
    /UNVERIFIED USER TRANSCRIPT/,
  );
});

test("turn cadence counts completed assistant turns and persists a valid review without steering tools", async (t) => {
  const h = harness(t, { everyTurns: 3 });
  h.turn("aborted", "aborted");
  h.turn("error", "error");
  h.turn();
  h.turn();
  await flush();
  assert.equal(h.calls.length, 0);
  assert.equal(h.turn(), undefined);
  await flush();
  assert.equal(h.calls.length, 1);
  assert.equal(h.calls[0].payload.metrics.completedAssistantTurns, 3);
  assert.equal(h.calls[0].input.tools, undefined);
  assert.deepEqual(Object.keys(h.calls[0].input).sort(), ["messages", "systemPrompt"]);
  assert.equal(h.calls[0].options.cacheRetention, "none");
  await h.finish();
  const report = h.custom("report")[0];
  assert.equal(report.type, "custom");
  assert.equal((report.data as SavedAssessment).turns, 3);
  assert.deepEqual((report.data as SavedAssessment).report, validReport);
  assert.equal(h.custom("usage").length, 1);
  assert.ok(h.writes.every((entry) => entry.type === "custom"));
  assert.match(h.statuses.at(-1)!, /watching.*up to date/);
});

test("settled reviews are nonblocking below cadence, single-flight and deduplicated", async (t) => {
  const h = harness(t);
  h.turn();
  assert.equal(h.emit("agent_settled"), undefined);
  await flush();
  assert.equal(h.calls.length, 1);
  h.emit("agent_settled");
  h.turn();
  h.emit("agent_settled");
  await flush();
  assert.equal(
    h.calls.length,
    1,
    "unresolved assessment must not block events or overlap requests",
  );
  await h.finish(0);
  assert.equal(h.calls.length, 2, "pending tail assessment runs after first settles");
  await h.finish(1);
  h.emit("agent_settled");
  await flush();
  assert.equal(h.calls.length, 2, "unchanged settled anchor is already assessed");
});

test("manual review works while paused without re-enabling automatic reviews", async (t) => {
  const h = harness(t, { everyTurns: 1 });
  await h.command("pause");
  h.turn();
  h.emit("agent_settled");
  await flush();
  assert.equal(h.calls.length, 0);
  await h.command("now");
  await flush();
  assert.equal(h.calls.length, 1);
  await h.finish();
  assert.match(h.statuses.at(-1)!, /paused/);
  h.turn();
  h.emit("agent_settled");
  await flush();
  assert.equal(h.calls.length, 1);
  assert.equal((h.custom("config").at(-1)!.data as Config).enabled, false);
});

test("invalid JSON still records reported cost/tokens and subsequent reviews recover", async (t) => {
  const h = harness(t);
  h.turn();
  await h.command("now");
  await flush();
  await h.finish(0, response("not JSON", 0.125, 87));
  assert.equal(h.custom("report").length, 0);
  assert.equal(h.custom("usage").length, 1);
  assert.deepEqual(Object.assign({}, h.custom("usage")[0].data, { at: "" }), {
    version: 1,
    at: "",
    model: "fake/offline",
    cost: 0.125,
    tokens: 87,
  });
  assert.match(h.statuses.at(-1)!, /review failed/);
  await h.command("details");
  assert.match(h.notifications.at(-1)!, /87 tokens/);
  assert.match(h.notifications.at(-1)!, /\$0\.1250/);
  assert.match(h.notifications.at(-1)!, /valid JSON/);
  await h.command("now");
  await flush();
  assert.equal(h.calls.length, 2);
  await h.finish(1);
  assert.equal(h.custom("report").length, 1);
});

test("budget gates prevent calls both for exhausted totals and conservative estimates", async (t) => {
  const h = harness(t, { budgetUsd: 0.05 });
  h.turn();
  await h.command("now");
  await flush();
  await h.finish(0, response("bad JSON", 0.05));
  await h.command("now");
  await flush();
  assert.equal(h.calls.length, 1);
  await h.command("");
  assert.match(h.notifications.at(-1)!, /budget reached/i);
  await h.settings({ budgetUsd: 0.050001 });
  await h.command("now");
  await flush();
  assert.equal(h.calls.length, 1);
  await h.command("");
  assert.match(h.notifications.at(-1)!, /Estimated assessment cost exceeds/);
});

test("pause aborts an in-flight provider and suppresses stale reports even if abort is ignored", async (t) => {
  const h = harness(t);
  h.turn();
  await h.command("now");
  await flush();
  const signal = h.calls[0].options.signal;
  assert.equal(signal.aborted, false);
  await h.command("pause");
  assert.equal(signal.aborted, true);
  await h.command("now");
  await flush();
  assert.equal(h.calls.length, 1, "manual request waits for the cancelled provider to unwind");
  await h.finish(0);
  assert.equal(h.custom("report").length, 0, "cancelled generation must not publish");
  assert.equal(
    h.custom("usage").length,
    1,
    "same-session cancellation still accounts for provider usage",
  );
  assert.equal(h.calls.length, 2);
  await h.finish(1);
  assert.equal(h.custom("report").length, 1);
  assert.match(h.statuses.at(-1)!, /paused/);
});

test("a rejected cancelled provider does not poison a waiting manual review", async (t) => {
  const h = harness(t);
  h.turn();
  await h.command("now");
  await flush();
  await h.command("pause");
  await h.command("now");
  await flush();
  assert.equal(h.calls.length, 1);
  h.calls[0].result.reject(new Error("Provider aborted the old request."));
  await flush();
  assert.equal(h.calls.length, 2, "replacement review proceeds despite old provider rejection");
  await h.finish(1);
  assert.equal(h.custom("report").length, 1);
  assert.match(h.statuses.at(-1)!, /paused/);
});

test("branch restore and reload recover branch-local config/report and refresh effective instructions", async (t) => {
  const h = harness(t);
  h.turn();
  await h.settings({
    everyTurns: 2,
    minIntervalSeconds: 0,
    enabled: false,
    model: "fake/offline",
    display: "widget",
  });
  await h.command("now");
  await flush();
  await h.finish();
  const branchA = [...h.entries];
  h.reload();
  assert.match(h.statuses.at(-1)!, /paused.*up to date/);
  await h.command("");
  assert.match(h.notifications.at(-1)!, /Independent review completed/);
  h.turn();
  h.emit("agent_settled");
  await flush();
  assert.equal(h.calls.length, 1, "paused settings survived reload");
  h.switchBranch([], "Branch B effective instructions.");
  assert.match(h.statuses.at(-1)!, /watching.*not assessed/);
  h.turn();
  h.turn();
  await flush();
  assert.equal(h.calls.length, 1, "default cadence restored on branch without config");
  h.emit("agent_settled");
  await flush();
  assert.equal(h.calls.length, 2);
  assert.deepEqual(h.calls[1].payload.effectiveAgentInstructions, {
    text: "Branch B effective instructions.",
    untrusted: true,
    truncated: false,
  });
  assert.equal(h.calls[1].payload.previousReport, undefined);
  await h.finish(1);
  h.switchBranch(branchA, "Branch A revised instructions.");
  assert.match(h.statuses.at(-1)!, /paused.*up to date/);
  await h.command("details");
  assert.match(
    h.notifications.at(-1)!,
    /2 model calls/,
    "overhead includes abandoned branch calls",
  );
  await h.command("now");
  await flush();
  assert.equal(
    h.calls[2].payload.effectiveAgentInstructions.text,
    "Branch A revised instructions.",
  );
  assert.match(h.calls[2].payload.previousReport!.text, /Independent review completed/);
});

test("branch navigation aborts and suppresses old-context reports", async (t) => {
  const h = harness(t);
  h.turn();
  await h.command("now");
  await flush();
  h.switchBranch([], "New branch instructions.");
  assert.equal(h.calls[0].options.signal.aborted, true);
  await h.finish(0);
  assert.equal(h.custom("report").length, 0);
  assert.equal(h.custom("usage").length, 1, "branch navigation must not erase incurred cost");
  assert.match(h.statuses.at(-1)!, /not assessed/);
});

test("shutdown aborts pending assessment and permits no late writes or rendering", async (t) => {
  const h = harness(t);
  h.turn();
  await h.command("now");
  await flush();
  h.emit("session_shutdown");
  assert.equal(h.calls[0].options.signal.aborted, true);
  const writes = h.writes.length;
  const renders = h.statuses.length;
  assert.equal(h.statuses.at(-1), undefined);
  await h.finish(0);
  assert.equal(h.writes.length, writes);
  assert.equal(h.statuses.length, renders);
  assert.equal(h.custom("report").length, 0);
});

test("readable report and details commands reuse the same saved assessment without model calls", async (t) => {
  const h = harness(t);
  h.turn();
  await h.command("now");
  await flush();
  await h.finish();
  await h.command("");
  assert.match(h.notifications.at(-1)!, /SUMMARY/);
  assert.doesNotMatch(h.notifications.at(-1)!, /REVIEW DETAILS|Model: fake\/offline|receipts/);
  await h.command("details");
  assert.match(h.notifications.at(-1)!, /REVIEW DETAILS/);
  assert.match(h.notifications.at(-1)!, /Model: fake\/offline/);
  assert.equal(h.calls.length, 1);
});

test("messages command explains recorded user input and keeps ledger as an alias", async (t) => {
  const h = harness(t);
  h.emit("input", { source: "interactive", text: "Keep this read-only." });
  await h.command("messages");
  const text = h.notifications.at(-1)!;
  assert.match(text, /Your message 1/);
  assert.match(text, /Keep this read-only/);
  assert.doesNotMatch(text, /receipts|intent authority/);
  await h.command("ledger");
  assert.equal(h.notifications.at(-1), text);
  assert.equal(h.calls.length, 0);
});
