import type { ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import {
  SettingsList,
  stripTerminalSequences,
  truncateToWidth,
  type SettingItem,
} from "@earendil-works/pi-tui";
import { defaultConfig, parseConfig, type Config, type Lens } from "./core.ts";

export type NumericField =
  | "everyTurns"
  | "minIntervalSeconds"
  | "budgetUsd"
  | "maxInputChars"
  | "maxOutputTokens"
  | "timeoutSeconds";
const numericFields: Record<NumericField, { label: string; hint: string }> = {
  everyTurns: {
    label: "Review every N turns",
    hint: "Whole number, 1–1000 completed assistant turns.",
  },
  minIntervalSeconds: {
    label: "Minimum interval (seconds)",
    hint: "Number, 0–86400 seconds between automatic reviews.",
  },
  budgetUsd: {
    label: "Session budget (USD)",
    hint: "Number, 0–10000 USD. Zero disables new reviews; unknown prices cannot guarantee a cap.",
  },
  maxInputChars: {
    label: "Maximum input characters",
    hint: "Whole number, 1024–1000000 characters forwarded per review.",
  },
  maxOutputTokens: {
    label: "Maximum output tokens",
    hint: "Whole number, 128–32000 tokens per review.",
  },
  timeoutSeconds: { label: "Timeout (seconds)", hint: "Number, 1–600 seconds per review." },
};
const lensLabels: Record<Lens, string> = {
  efficiency: "Efficiency",
  confusion: "Confusion",
  alignment: "Staying on track",
};
const lensNames = Object.keys(lensLabels) as Lens[];
const choices = {
  sensitivity: ["low", "balanced", "high"],
  display: ["status", "widget", "silent"],
} as const;

/** Parse the entire decimal input, then let the policy own all range/integer checks. */
export function parseNumericSetting(config: Config, field: NumericField, input: string): Config {
  const text = input.trim();
  if (
    !/^[+-]?(?:\d+(?:\.\d*)?|\.\d+)(?:[eE][+-]?\d+)?$/.test(text) ||
    !Number.isFinite(Number(text))
  ) {
    throw new Error(
      `${numericFields[field].label}: enter a finite decimal number. ${numericFields[field].hint}`,
    );
  }
  try {
    return parseConfig({ ...config, [field]: Number(text) });
  } catch {
    throw new Error(`${numericFields[field].label}: ${numericFields[field].hint}`);
  }
}

// Configured model IDs are data, not terminal markup. Keep raw values for selection.
function label(text: string): string {
  return stripTerminalSequences(text).replace(/[\u0000-\u001f\u007f-\u009f]/g, " ");
}

function fields(config: Config): SettingItem[] {
  return [
    {
      id: "enabled",
      label: "Automatic reviews",
      currentValue: config.enabled ? "on" : "off",
      values: ["on", "off"],
      description: "Enable automatic reviews for this session. Manual reviews remain available.",
    },
    ...lensNames.map((lens) => ({
      id: `lens:${lens}`,
      label: lensLabels[lens],
      currentValue: config.lenses.includes(lens) ? "on" : "off",
      values: ["on", "off"],
      description: `Include ${lensLabels[lens].toLowerCase()} checks in reviews.`,
    })),
    {
      id: "sensitivity",
      label: "Sensitivity",
      currentValue: config.sensitivity,
      values: [...choices.sensitivity],
      description: "Low: fewer concerns. Balanced: normal scrutiny. High: more sensitive checks.",
    },
    {
      id: "display",
      label: "Display",
      currentValue: config.display,
      values: [...choices.display],
      description:
        "Status: footer summary. Widget: expanded summary. Silent: no persistent display.",
    },
    {
      id: "model",
      label: "Observer model",
      currentValue: label(config.model),
      description:
        "Use the current session model or choose an available model. An unavailable configured model is preserved until changed.",
    },
    ...Object.entries(numericFields).map(([id, field]) => ({
      id,
      label: field.label,
      currentValue: String(config[id as NumericField]),
      description: field.hint,
    })),
    {
      id: "save",
      label: "Save",
      currentValue: "",
      description: "Apply this draft to this session only.",
    },
    {
      id: "cancel",
      label: "Cancel",
      currentValue: "",
      description: "Discard all changes made in this editor.",
    },
    {
      id: "reset",
      label: "Reset to defaults…",
      currentValue: "",
      description: "Reset this draft after confirmation. Save is still required.",
    },
  ];
}

function changeChoice(config: Config, id: string, value: string): Config {
  if (id === "enabled") return parseConfig({ ...config, enabled: value === "on" });
  if (id.startsWith("lens:")) {
    const lens = id.slice(5) as Lens;
    const selected = new Set(config.lenses);
    if (value === "on") selected.add(lens);
    else selected.delete(lens);
    return parseConfig({ ...config, lenses: lensNames.filter((item) => selected.has(item)) });
  }
  return parseConfig({ ...config, [id]: value });
}

/** Draft-only editor: no persistence, context injection, or model calls. */
export async function editSettings(
  ctx: ExtensionCommandContext,
  current: Config,
): Promise<Config | undefined> {
  if (!ctx.hasUI || (ctx.mode !== "tui" && ctx.mode !== "rpc")) {
    ctx.ui.notify("Observer settings require TUI or RPC dialogs.", "warning");
    return undefined;
  }
  let draft = parseConfig(current);
  let selectedId = "enabled";
  while (true) {
    const items = fields(draft);
    let action: string | undefined;
    if (ctx.mode === "tui") {
      action = await ctx.ui.custom<string | undefined>(
        (tui, theme, keybindings, done) => {
          // End this custom interaction BEFORE opening input/select/confirm dialogs.
          // Awaiting a second dialog inside a custom component can deadlock the UI.
          const settingsTheme = {
            label: (text: string, selected: boolean) =>
              selected ? theme.fg("accent", text) : text,
            value: (text: string, selected: boolean) =>
              theme.fg(selected ? "accent" : "muted", text),
            description: (text: string) => theme.fg("dim", text),
            cursor: theme.fg("accent", "→ "),
            hint: (text: string) => theme.fg("dim", text),
          };
          const list = new SettingsList(
            items.map((item) => ({ ...item, values: item.values ?? [item.currentValue] })),
            Math.max(3, Math.min(items.length, tui.terminal.rows - 10)),
            settingsTheme,
            (id, value) => {
              selectedId = id;
              if (items.find((item) => item.id === id)?.values)
                draft = changeChoice(draft, id, value);
              else done(id);
            },
            () => done(undefined),
          );
          list.selectItem(selectedId);
          return {
            capturesViewportInput: list.capturesViewportInput,
            render(width) {
              // SettingsList reserves columns for descriptions. Give it a safe minimum
              // and clip the final result even on exceptionally narrow terminals.
              const lines = list.render(Math.max(8, width));
              lines[lines.length - 1] = theme.fg(
                "dim",
                `  ${keybindings.getKeys("tui.select.confirm").join("/")} / Space: change · ${keybindings.getKeys("tui.select.cancel").join("/")}: discard`,
              );
              return [
                theme.fg("accent", theme.bold("Pi Observer · Session settings")),
                theme.fg("dim", "Draft only · Save applies · Cancel discards"),
                "",
                ...lines,
              ].map((line) => truncateToWidth(line, Math.max(0, width)));
            },
            invalidate() {
              settingsTheme.cursor = theme.fg("accent", "→ ");
              list.invalidate();
            },
            handleInput(data) {
              if (keybindings.matches(data, "tui.select.cancel")) done(undefined);
              else list.handleInput(data);
              tui.requestRender();
            },
          };
        },
        { blocked: { kind: "question", message: "Edit Observer session settings" } },
      );
    } else {
      const options = items.map(
        (item) => `${item.label}${item.currentValue ? `: ${item.currentValue}` : ""}`,
      );
      const selected = await ctx.ui.select(
        "Pi Observer · Session settings (draft; Save to apply)",
        options,
      );
      const item = items[options.indexOf(selected ?? "")];
      if (!item) return undefined;
      selectedId = item.id;
      if (item.values) {
        // Toggles flip directly; multi-value fields get an explicit picker.
        const value =
          item.values.length === 2
            ? item.values.find((value) => value !== item.currentValue)
            : await ctx.ui.select(`${item.label} · ${item.description}`, item.values);
        if (value !== undefined) draft = changeChoice(draft, item.id, value);
        continue;
      }
      action = item.id;
    }
    if (action === undefined || action === "cancel") return undefined;
    if (action === "save") return parseConfig(draft);
    if (action === "reset") {
      if (
        await ctx.ui.confirm(
          "Reset session settings?",
          "Replace the draft with defaults? Nothing is applied until Save.",
        )
      )
        draft = parseConfig(defaultConfig);
    } else if (action === "model") {
      const available = ctx.modelRegistry
        .getAvailable()
        .map((model) => `${model.provider}/${model.id}`);
      const ids = [...new Set(["current", draft.model, current.model, ...available])];
      const options = ids.map(
        (id, index) =>
          `${index + 1}. ${id === "current" ? "Current session model" : label(id)}${id !== "current" && !available.includes(id) ? " (configured; unavailable)" : ""}`,
      );
      const selected = await ctx.ui.select(
        "Observer model · Cancel keeps the draft value",
        options,
      );
      const index = options.indexOf(selected ?? "");
      if (index !== -1) draft = parseConfig({ ...draft, model: ids[index] });
    } else if (Object.hasOwn(numericFields, action)) {
      const field = action as NumericField;
      while (true) {
        const input = await ctx.ui.input(
          `${numericFields[field].label} · ${numericFields[field].hint} Current: ${draft[field]}`,
          String(draft[field]),
        );
        if (input === undefined) break;
        try {
          draft = parseNumericSetting(draft, field, input);
          break;
        } catch (error) {
          ctx.ui.notify((error as Error).message, "error");
        }
      }
    }
  }
}
