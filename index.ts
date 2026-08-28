import type { ExtensionAPI, Theme } from "@earendil-works/pi-coding-agent";
import { Box, Text, visibleWidth, wrapTextWithAnsi } from "@earendil-works/pi-tui";
import { anthropic } from "./anthropic.js";
import { codex } from "./codex.js";
import { PROVIDERS, type UsageSnapshot } from "./types.js";
import { clampPercent } from "./util.js";
import { xai } from "./xai.js";

const providers = { anthropic, codex, xai };
const ENTRY_TYPE = "usage";
const CIRCLES = ["○", "◔", "◑", "◕", "●"];

function formatPercent(value: number): string {
  return `${Math.round(value)}%`.padStart(4);
}

function usageColor(usedPercent: number): "success" | "warning" | "error" {
  if (usedPercent < 70) return "success";
  if (usedPercent < 90) return "warning";
  return "error";
}

function renderCircles(percent: number): string {
  const clamped = clampPercent(percent);
  const filled = clamped / 20;
  const fullCircles = Math.floor(filled);
  const remainder = filled - fullCircles;
  const partialCircle = CIRCLES[Math.round(remainder * 4)];
  const circles = "●".repeat(fullCircles) + (partialCircle === "○" ? "" : partialCircle);
  return circles.padEnd(5, "○");
}

function formatWindow(
  window: UsageSnapshot["windows"][number],
  labelWidth: number,
  theme?: Theme,
): string {
  const reset = window.resetDescription ? `  resets ${window.resetDescription}` : "";
  const label = window.label.padEnd(labelWidth + 2);
  const circles = renderCircles(window.usedPercent);
  const suffix = formatPercent(window.usedPercent);
  if (!theme) return `  ${label} ${circles} ${suffix}${reset}`;
  const color = usageColor(window.usedPercent);
  const resetText = window.resetDescription
    ? theme.fg("dim", `  resets ${window.resetDescription}`)
    : "";
  return `  ${theme.fg("muted", label)} ${theme.fg(color, circles)} ${theme.fg(color, suffix)}${resetText}`;
}

function formatResetLine(
  resets: { count: number; expirations: string[] },
  labelWidth: number,
  theme?: Theme,
): string {
  const label = "Reset".padEnd(labelWidth + 2);
  const expires = resets.expirations.length > 0 ? `  expires ${resets.expirations.join(", ")}` : "";
  const count = `\u00d7${resets.count}`;
  if (!theme) return `  ${label} ${count}${expires}`;
  return `  ${theme.fg("muted", label)} ${theme.fg("success", count)}${theme.fg("dim", expires)}`;
}

function formatSnapshot(usage: UsageSnapshot, theme?: Theme): string {
  const lines = [theme ? theme.bold(usage.displayName) : usage.displayName];
  if (usage.error) {
    lines.push(theme ? theme.fg("error", `  ${usage.error}`) : `  ${usage.error}`);
    return lines.join("\n");
  }
  const resets = usage.resets;
  if (usage.windows.length === 0 && !resets) {
    lines.push(theme ? theme.fg("dim", "  no windows") : "  no windows");
    return lines.join("\n");
  }
  const labelWidth = Math.max(
    ...usage.windows.map((w) => w.label.length),
    ...(resets ? ["Reset".length] : []),
  );
  for (const window of usage.windows) lines.push(formatWindow(window, labelWidth, theme));
  if (resets) lines.push(formatResetLine(resets, labelWidth, theme));
  return lines.join("\n");
}

class UsageGrid {
  constructor(private cards: string[]) {}

  render(width: number): string[] {
    if (width <= 0) return [];

    const rows: { lines: string[]; width: number }[][] = [];
    let row: { lines: string[]; width: number }[] = [];
    let rowWidth = 0;
    for (const card of this.cards) {
      let lines = card.split("\n");
      let cardWidth = Math.max(...lines.map(visibleWidth));
      if (cardWidth > width) {
        lines = wrapTextWithAnsi(card, width);
        cardWidth = Math.max(...lines.map(visibleWidth));
      }

      if (row.length > 0 && rowWidth + 2 + cardWidth > width) {
        rows.push(row);
        row = [];
        rowWidth = 0;
      }
      row.push({ lines, width: cardWidth });
      rowWidth += (rowWidth > 0 ? 2 : 0) + cardWidth;
    }
    if (row.length > 0) rows.push(row);

    return rows.flatMap((cards, rowIndex) => [
      ...(rowIndex > 0 ? [""] : []),
      ...Array.from(
        { length: Math.max(...cards.map((card) => card.lines.length)) },
        (_, lineIndex) =>
          cards
            .map((card) => {
              const line = card.lines[lineIndex] ?? "";
              return line + " ".repeat(card.width - visibleWidth(line));
            })
            .join("  "),
      ),
    ]);
  }

  invalidate() {}
}

export default function (pi: ExtensionAPI) {
  pi.registerEntryRenderer<UsageSnapshot[]>("usage", (entry, _opts, theme) => {
    const snapshots = entry.data ?? [];
    const box = new Box(1, 1, (text) => theme.bg("customMessageBg", text));
    if (snapshots.length === 0) {
      box.addChild(new Text(theme.fg("dim", "No logged-in providers"), 0, 0));
      return box;
    }
    const blocks = snapshots.map((snapshot) => formatSnapshot(snapshot, theme));
    box.addChild(new UsageGrid(blocks));
    return box;
  });

  pi.registerCommand("usage", {
    description: "Show subscription usage for logged-in providers",
    handler: async (_args, ctx) => {
      const loggedIn = PROVIDERS.map((name) => providers[name]).filter((provider) =>
        provider.hasCredentials(),
      );
      if (loggedIn.length === 0) {
        ctx.ui.notify("No logged-in providers", "warning");
        return;
      }

      const names = loggedIn.map((provider) => provider.displayName).join(", ");
      ctx.ui.setWidget("usage", (_tui, theme) => ({
        render: () => [theme.fg("dim", `Fetching usage: ${names}`)],
        invalidate: () => {},
      }));
      try {
        const snapshots = await Promise.all(
          loggedIn.map(async (provider) => {
            try {
              return await provider.fetchUsage();
            } catch (error) {
              return {
                provider: provider.name,
                displayName: provider.displayName,
                windows: [],
                error: error instanceof Error ? error.message : String(error),
              } satisfies UsageSnapshot;
            }
          }),
        );
        pi.appendEntry<UsageSnapshot[]>(ENTRY_TYPE, snapshots);

        if (ctx.mode !== "tui") {
          ctx.ui.notify(snapshots.map((snapshot) => formatSnapshot(snapshot)).join("\n\n"), "info");
        }
      } finally {
        ctx.ui.setWidget("usage", undefined);
      }
    },
  });
}
