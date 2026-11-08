import { test } from "node:test";
import assert from "node:assert/strict";
import type { ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import { getKeybindings, visibleWidth, type Component } from "@earendil-works/pi-tui";
import { defaultConfig, parseConfig } from "../src/core.ts";
import { editSettings, parseNumericSetting, type NumericField } from "../src/settings.ts";

type Factory = Parameters<ExtensionCommandContext["ui"]["custom"]>[0];
type FactoryArgs = Parameters<Factory>;
const down = "\x1b[B";
const up = "\x1b[A";
const enter = "\r";
const escape = "\x1b";
function keys(screen: Component, ...input: string[]) {
  input.forEach((key) => screen.handleInput?.(key));
}
function move(screen: Component, count: number) {
  keys(screen, ...Array(Math.abs(count)).fill(count < 0 ? up : down));
}

function harness(mode: "tui" | "rpc" = "rpc") {
  const screens: ((screen: Component) => void)[] = [];
  const selections: ((title: string, options: string[]) => string | undefined)[] = [];
  const inputs: (string | undefined)[] = [];
  const confirms: boolean[] = [];
  const errors: string[] = [];
  let customActive = false;
  let customs = 0;
  const ctx = {
    hasUI: true,
    mode,
    modelRegistry: { getAvailable: () => [{ provider: "test", id: "available" }] },
    ui: {
      custom: async (factory: Factory) => {
        customs++;
        assert.equal(customActive, false);
        customActive = true;
        let completed = false;
        let result: unknown;
        const screen = await factory(
          { terminal: { rows: 24 }, requestRender() {} } as FactoryArgs[0],
          {
            fg: (_color: string, text: string) => text,
            bold: (text: string) => text,
          } as FactoryArgs[1],
          getKeybindings() as FactoryArgs[2],
          (value) => {
            completed = true;
            result = value;
          },
        );
        assert.match(screen.render(80).join("\n"), /Session settings/);
        for (const width of [1, 8, 24, 80]) {
          assert.ok(screen.render(width).every((line) => visibleWidth(line) <= width));
        }
        screen.invalidate();
        assert.ok(screens.length, "unexpected custom screen");
        screens.shift()!(screen);
        assert.ok(completed, "screen must complete");
        customActive = false;
        return result;
      },
      select: async (title: string, options: string[]) => {
        assert.equal(customActive, false, "dialogs must not nest inside custom");
        assert.ok(selections.length, `unexpected select: ${title}`);
        return selections.shift()!(title, options);
      },
      input: async () => {
        assert.equal(customActive, false);
        assert.ok(inputs.length, "unexpected input");
        return inputs.shift();
      },
      confirm: async () => {
        assert.equal(customActive, false);
        assert.ok(confirms.length, "unexpected confirm");
        return confirms.shift()!;
      },
      notify: (message: string) => errors.push(message),
    },
  } as unknown as ExtensionCommandContext;
  const pick = (prefix: string) =>
    selections.push((_title, options) => {
      const choice = options.find((option) => option.startsWith(prefix));
      assert.ok(choice, `missing option: ${prefix}`);
      return choice;
    });
  return { ctx, screens, selections, inputs, confirms, errors, pick, customs: () => customs };
}

test("numeric fields accept exact finite decimals and defer ranges to parseConfig", () => {
  const config = parseConfig();
  for (const invalid of [
    "",
    " ",
    "NaN",
    "Infinity",
    "-Infinity",
    "1foo",
    "1 2",
    "0x20",
    "1_000",
    "1e999",
    ".",
    "++1",
  ]) {
    assert.throws(() => parseNumericSetting(config, "budgetUsd", invalid), /finite decimal/);
  }
  assert.equal(parseNumericSetting(config, "budgetUsd", " .25 ").budgetUsd, 0.25);
  assert.equal(parseNumericSetting(config, "everyTurns", "1e2").everyTurns, 100);
  const cases: [NumericField, string][] = [
    ["everyTurns", "1.5"],
    ["everyTurns", "0"],
    ["minIntervalSeconds", "-1"],
    ["budgetUsd", "10001"],
    ["maxInputChars", "1023"],
    ["maxOutputTokens", "32001"],
    ["timeoutSeconds", "601"],
  ];
  for (const [field, value] of cases)
    assert.throws(() => parseNumericSetting(config, field, value));
  assert.deepEqual(config, defaultConfig);
});

test("TUI native toggles and choices update a draft, explicit Save returns it", async () => {
  const h = harness("tui");
  const current = parseConfig();
  h.screens.push((screen) => {
    // Toggle enabled and all three lenses, cycle both choice fields.
    for (let i = 0; i < 6; i++) keys(screen, enter, down);
    move(screen, 7); // model -> Save
    keys(screen, enter);
  });
  const result = await editSettings(h.ctx, current);
  assert.equal(result?.enabled, false);
  assert.deepEqual(result?.lenses, []);
  assert.equal(result?.sensitivity, "high");
  assert.equal(result?.display, "widget");
  assert.deepEqual(current, defaultConfig);
});

test("TUI Escape and Cancel both discard changes", async () => {
  for (const explicit of [false, true]) {
    const h = harness("tui");
    h.screens.push((screen) => {
      keys(screen, enter);
      if (explicit) {
        move(screen, 14);
        keys(screen, enter);
      } else keys(screen, escape);
    });
    assert.equal(await editSettings(h.ctx, parseConfig()), undefined);
  }
});

test("TUI numeric dialogs retry invalid input, cancel keeps draft, and restore row selection", async () => {
  const h = harness("tui");
  h.screens.push((screen) => {
    move(screen, 7);
    keys(screen, enter);
  });
  h.inputs.push("7junk", "", "9");
  h.screens.push((screen) => {
    move(screen, 1);
    keys(screen, enter);
  }); // interval
  h.inputs.push(undefined);
  h.screens.push((screen) => {
    move(screen, 5);
    keys(screen, enter);
  }); // Save
  const result = await editSettings(h.ctx, parseConfig());
  assert.equal(result?.everyTurns, 9);
  assert.equal(result?.minIntervalSeconds, defaultConfig.minIntervalSeconds);
  assert.equal(h.errors.length, 2);
  assert.match(h.errors[0], /Whole number, 1–1000/);
  assert.equal(h.customs(), 3);
});

test("RPC fallback toggles, choices, all numeric fields, and Save without custom UI", async () => {
  const h = harness();
  h.pick("Automatic reviews");
  h.pick("Staying on track");
  h.pick("Sensitivity");
  h.pick("low");
  h.pick("Display");
  h.pick("silent");
  for (const [prefix, value] of [
    ["Review every", "8"],
    ["Minimum interval", "1.5"],
    ["Session budget", "0.25"],
    ["Maximum input", "2048"],
    ["Maximum output", "512"],
    ["Timeout", "12.5"],
  ]) {
    h.pick(prefix);
    h.inputs.push(value);
  }
  h.pick("Save");
  const result = await editSettings(h.ctx, parseConfig());
  assert.deepEqual(
    result,
    parseConfig({
      enabled: false,
      lenses: ["efficiency", "confusion"],
      sensitivity: "low",
      display: "silent",
      everyTurns: 8,
      minIntervalSeconds: 1.5,
      budgetUsd: 0.25,
      maxInputChars: 2048,
      maxOutputTokens: 512,
      timeoutSeconds: 12.5,
    }),
  );
  assert.equal(h.customs(), 0);
});

test("RPC input cancel and invalid retry preserve earlier draft edits; top-level cancel discards", async () => {
  const h = harness();
  h.pick("Automatic reviews");
  h.pick("Session budget");
  h.inputs.push("Infinity", undefined);
  h.pick("Save");
  const result = await editSettings(h.ctx, parseConfig());
  assert.equal(result?.enabled, false);
  assert.equal(result?.budgetUsd, defaultConfig.budgetUsd);
  assert.equal(h.errors.length, 1);
  for (const explicit of [false, true]) {
    const cancel = harness();
    cancel.pick("Automatic reviews");
    if (explicit) cancel.pick("Cancel");
    else cancel.selections.push(() => undefined);
    assert.equal(await editSettings(cancel.ctx, parseConfig()), undefined);
  }
});

test("model picker includes current, available and original unavailable configuration", async () => {
  const h = harness();
  const current = parseConfig({ model: "old/unavailable" });
  h.pick("Observer model");
  h.selections.push((_title, options) => {
    assert.ok(options.some((option) => option.includes("Current session model")));
    assert.ok(
      options.some((option) => option.includes("old/unavailable (configured; unavailable)")),
    );
    return options.find((option) => option.includes("test/available"));
  });
  h.pick("Observer model");
  h.selections.push((_title, options) =>
    options.find((option) => option.includes("old/unavailable")),
  );
  h.pick("Save");
  assert.equal((await editSettings(h.ctx, current))?.model, "old/unavailable");
  const cancel = harness();
  cancel.pick("Observer model");
  cancel.selections.push(() => undefined);
  cancel.pick("Save");
  assert.equal((await editSettings(cancel.ctx, current))?.model, "old/unavailable");
});

test("reset requires confirmation and remains draft-only until Save", async () => {
  const current = parseConfig({ enabled: false, lenses: [], model: "old/model" });
  for (const confirmed of [false, true]) {
    const h = harness();
    h.pick("Reset");
    h.confirms.push(confirmed);
    h.pick("Save");
    assert.deepEqual(await editSettings(h.ctx, current), confirmed ? defaultConfig : current);
  }
  const h = harness();
  h.pick("Reset");
  h.confirms.push(true);
  h.pick("Cancel");
  assert.equal(await editSettings(h.ctx, current), undefined);
  assert.equal(current.enabled, false);
});

test("non-dialog modes decline without attempting UI", async () => {
  const h = harness();
  const ctx = { ...h.ctx, mode: "print", hasUI: false } as ExtensionCommandContext;
  assert.equal(await editSettings(ctx, parseConfig()), undefined);
  assert.match(h.errors[0], /require TUI or RPC/);
});
