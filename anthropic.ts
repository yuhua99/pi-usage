import { execFileSync } from "node:child_process";
import {
  API_TIMEOUT_MS,
  clampPercent,
  createTimeoutController,
  errorMessage,
  formatExpiry,
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

// Reset grants (cedar_ember) are only returned for a recent Claude Code CLI user agent.
const FALLBACK_CLAUDE_VERSION = "2.1.281";

function claudeVersion(): string {
  try {
    const output = execFileSync("claude", ["--version"], {
      encoding: "utf-8",
      stdio: ["ignore", "pipe", "ignore"],
      timeout: 2000,
    });
    return output.match(/^\d+\.\d+\.\d+/)?.[0] ?? FALLBACK_CLAUDE_VERSION;
  } catch {
    return FALLBACK_CLAUDE_VERSION;
  }
}

function claudeUserAgent(): string {
  return `claude-cli/${claudeVersion()} (external, ${process.env.CLAUDE_CODE_ENTRYPOINT ?? "cli"})`;
}

function formatExtraUsageCredits(credits: number): string {
  return (credits / 100).toFixed(2);
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
      const res = await fetch("https://api.anthropic.com/api/oauth/usage?cedar_ember=1", {
        headers: {
          Authorization: `Bearer ${token}`,
          "anthropic-beta": "oauth-2025-04-20",
          "User-Agent": claudeUserAgent(),
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
        cedar_ember?: {
          grants?: { resets_left?: number; ends_at?: string | null }[];
        } | null;
      };

      const windows: RateWindow[] = [];

      if (data.five_hour?.utilization !== undefined) {
        const resetAt = parseDate(data.five_hour.resets_at);
        windows.push({
          label: "5h",
          usedPercent: clampPercent(data.five_hour.utilization),
          resetDescription: resetAt ? formatReset(resetAt) : undefined,
          resetAt: resetAt?.toISOString(),
        });
      }

      if (data.seven_day?.utilization !== undefined) {
        const resetAt = parseDate(data.seven_day.resets_at);
        windows.push({
          label: "Week",
          usedPercent: clampPercent(data.seven_day.utilization),
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
          usedPercent: clampPercent(extra.utilization || 0),
          resetDescription: extraStatus === "active" ? "active" : undefined,
        });
      }

      const grants = (data.cedar_ember?.grants ?? []).filter(
        (grant) => (grant.resets_left ?? 0) > 0,
      );
      const count = grants.reduce((sum, grant) => sum + (grant.resets_left ?? 0), 0);
      const expirations = grants
        .map((grant) => parseDate(grant.ends_at ?? undefined))
        .filter((date): date is Date => Boolean(date))
        .sort((a, b) => a.getTime() - b.getTime())
        .slice(0, 3)
        .map(formatExpiry);
      const resets = count > 0 ? { count, expirations } : undefined;

      return { provider: "anthropic", displayName: "Claude", windows, resets };
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
