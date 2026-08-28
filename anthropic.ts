import {
  API_TIMEOUT_MS,
  clampPercent,
  createTimeoutController,
  errorMessage,
  formatReset,
  home,
  keychainPassword,
  parseDate,
  readAuth,
  readJson,
} from "./util.js";
import type { RateWindow, UsageProvider, UsageSnapshot } from "./types.js";

function loadToken(): string | undefined {
  const auth = readAuth();
  const anthropic = auth.anthropic;
  if (anthropic && typeof anthropic === "object" && "access" in anthropic) {
    const access = (anthropic as { access?: unknown }).access;
    if (typeof access === "string" && access) return access;
  }

  const keychain = keychainPassword("Claude Code-credentials");
  if (keychain) {
    try {
      const parsed = JSON.parse(keychain) as {
        claudeAiOauth?: { scopes?: string[]; accessToken?: string };
      };
      if (
        parsed.claudeAiOauth?.scopes?.includes("user:profile") &&
        parsed.claudeAiOauth.accessToken
      ) {
        return parsed.claudeAiOauth.accessToken;
      }
    } catch {
      // ignore
    }
  }

  const creds = readJson(`${home()}/.claude/.credentials.json`);
  const oauth = creds?.claudeAiOauth as { scopes?: string[]; accessToken?: string } | undefined;
  if (oauth?.scopes?.includes("user:profile") && oauth.accessToken) return oauth.accessToken;

  return undefined;
}

function formatExtraUsageCredits(credits: number): string {
  return (credits / 100).toFixed(2);
}

function toPercent(value: number): number {
  if (!Number.isFinite(value) || value < 0) return 0;
  return clampPercent(value <= 1 ? value * 100 : value);
}

export const anthropic: UsageProvider = {
  name: "anthropic",
  displayName: "Claude",

  hasCredentials() {
    return Boolean(loadToken());
  },

  async fetchUsage(): Promise<UsageSnapshot> {
    const token = loadToken();
    if (!token)
      return { provider: "anthropic", displayName: "Claude", windows: [], error: "No credentials" };

    const { controller, clear } = createTimeoutController(API_TIMEOUT_MS);
    try {
      const res = await fetch("https://api.anthropic.com/api/oauth/usage", {
        headers: {
          Authorization: `Bearer ${token}`,
          "anthropic-beta": "oauth-2025-04-20",
        },
        signal: controller.signal,
      });
      clear();

      if (!res.ok) {
        return {
          provider: "anthropic",
          displayName: "Claude",
          windows: [],
          error: `HTTP ${res.status}`,
        };
      }

      const data = (await res.json()) as {
        five_hour?: { utilization?: number; resets_at?: string };
        seven_day?: { utilization?: number; resets_at?: string };
        limits?: unknown;
        extra_usage?: {
          is_enabled?: boolean;
          used_credits?: number;
          monthly_limit?: number;
          utilization?: number;
        };
      };

      const windows: RateWindow[] = [];

      if (data.five_hour?.utilization !== undefined) {
        const resetAt = parseDate(data.five_hour.resets_at);
        windows.push({
          label: "5h",
          usedPercent: toPercent(data.five_hour.utilization),
          resetDescription: resetAt ? formatReset(resetAt) : undefined,
          resetAt: resetAt?.toISOString(),
        });
      }

      if (data.seven_day?.utilization !== undefined) {
        const resetAt = parseDate(data.seven_day.resets_at);
        windows.push({
          label: "Week",
          usedPercent: toPercent(data.seven_day.utilization),
          resetDescription: resetAt ? formatReset(resetAt) : undefined,
          resetAt: resetAt?.toISOString(),
        });
      }

      const fableLimit = Array.isArray(data.limits)
        ? data.limits.find((limit): limit is { percent: number; resets_at?: unknown } => {
            if (!limit || typeof limit !== "object") return false;
            const entry = limit as {
              kind?: unknown;
              percent?: unknown;
              scope?: { model?: { display_name?: unknown } | null } | null;
            };
            return (
              entry.kind === "weekly_scoped" &&
              entry.scope?.model?.display_name === "Fable" &&
              typeof entry.percent === "number" &&
              Number.isFinite(entry.percent)
            );
          })
        : undefined;
      if (fableLimit) {
        const resetAt =
          typeof fableLimit.resets_at === "string" ? parseDate(fableLimit.resets_at) : undefined;
        windows.push({
          label: "WeekF",
          usedPercent: clampPercent(fableLimit.percent),
          resetDescription: resetAt ? formatReset(resetAt) : undefined,
          resetAt: resetAt?.toISOString(),
        });
      }

      if (data.extra_usage?.is_enabled === true) {
        const extra = data.extra_usage;
        const usedCredits = extra.used_credits || 0;
        const monthlyLimit = extra.monthly_limit;
        const extraStatus = (data.five_hour?.utilization ?? 0) >= 99 ? "active" : "on";
        const label =
          monthlyLimit && monthlyLimit > 0
            ? `Extra [${extraStatus}] ${formatExtraUsageCredits(usedCredits)}/${formatExtraUsageCredits(monthlyLimit)}`
            : `Extra [${extraStatus}] ${formatExtraUsageCredits(usedCredits)}`;
        windows.push({
          label,
          usedPercent: toPercent(extra.utilization || 0),
          resetDescription: extraStatus === "active" ? "active" : undefined,
        });
      }

      return { provider: "anthropic", displayName: "Claude", windows };
    } catch (error) {
      clear();
      return {
        provider: "anthropic",
        displayName: "Claude",
        windows: [],
        error: errorMessage(error),
      };
    }
  },
};
