import {
  API_TIMEOUT_MS,
  clampPercent,
  createTimeoutController,
  errorMessage,
  formatExpiry,
  formatReset,
  home,
  parseDate,
  readAuth,
  readJson,
} from "./util.js";
import type { RateWindow, UsageProvider, UsageSnapshot } from "./types.js";

function loadCredentials(): { accessToken?: string; accountId?: string } {
  const auth = readAuth();
  const entry = auth["openai-codex"];
  if (entry && typeof entry === "object") {
    const access = (entry as { access?: unknown }).access;
    if (typeof access === "string" && access) {
      const accountId = (entry as { accountId?: unknown }).accountId;
      return {
        accessToken: access,
        accountId: typeof accountId === "string" ? accountId : undefined,
      };
    }
  }

  const codexHome = process.env.CODEX_HOME || `${home()}/.codex`;
  const data = readJson(`${codexHome}/auth.json`);
  if (!data) return {};
  if (typeof data.OPENAI_API_KEY === "string") return { accessToken: data.OPENAI_API_KEY };

  const tokens = data.tokens as { access_token?: string; account_id?: string } | undefined;
  if (tokens?.access_token) {
    return { accessToken: tokens.access_token, accountId: tokens.account_id };
  }
  return {};
}

function windowLabel(hours: number): string {
  if (hours >= 144) return "Week";
  if (hours >= 24) return "Day";
  return `${hours}h`;
}

function toWindow(
  window: { reset_at?: number; limit_window_seconds?: number; used_percent?: number },
  fallbackSeconds: number,
): RateWindow {
  const resetDate = window.reset_at ? new Date(window.reset_at * 1000) : undefined;
  const hours = Math.round((window.limit_window_seconds || fallbackSeconds) / 3600);
  return {
    label: windowLabel(hours),
    usedPercent: clampPercent(window.used_percent || 0),
    resetDescription: resetDate ? formatReset(resetDate) : undefined,
    resetAt: resetDate?.toISOString(),
  };
}

async function fetchResets(
  headers: Record<string, string>,
): Promise<{ count: number; expirations: string[] } | undefined> {
  const { controller, clear } = createTimeoutController(API_TIMEOUT_MS);
  try {
    const res = await fetch("https://chatgpt.com/backend-api/wham/rate-limit-reset-credits", {
      headers,
      signal: controller.signal,
    });
    if (!res.ok) return undefined;
    const data = (await res.json()) as {
      credits?: { status?: string; expires_at?: string }[];
      available_count?: number;
    };
    const dates = (data.credits ?? [])
      .filter((credit) => credit.status === "available")
      .map((credit) => parseDate(credit.expires_at))
      .filter((date): date is Date => Boolean(date))
      .sort((a, b) => a.getTime() - b.getTime());
    const count = data.available_count ?? dates.length;
    if (count === 0) return undefined;
    return { count, expirations: dates.slice(0, 3).map(formatExpiry) };
  } catch {
    return undefined;
  } finally {
    clear();
  }
}

export const codex: UsageProvider = {
  name: "codex",
  displayName: "Codex",

  hasCredentials() {
    return Boolean(loadCredentials().accessToken);
  },

  async fetchUsage(): Promise<UsageSnapshot> {
    const { accessToken, accountId } = loadCredentials();
    if (!accessToken) {
      return { provider: "codex", displayName: "Codex", windows: [], error: "No credentials" };
    }

    const { controller, clear } = createTimeoutController(API_TIMEOUT_MS);
    try {
      const headers: Record<string, string> = {
        Authorization: `Bearer ${accessToken}`,
        "User-Agent": "codex-cli",
      };
      if (accountId) headers["ChatGPT-Account-Id"] = accountId;

      const [res, resets] = await Promise.all([
        fetch("https://chatgpt.com/backend-api/wham/usage", {
          headers,
          signal: controller.signal,
        }),
        fetchResets(headers),
      ]);
      clear();

      if (!res.ok) {
        return {
          provider: "codex",
          displayName: "Codex",
          windows: [],
          error: `HTTP ${res.status}`,
        };
      }

      const data = (await res.json()) as {
        rate_limit?: {
          primary_window?: {
            reset_at?: number;
            limit_window_seconds?: number;
            used_percent?: number;
          };
          secondary_window?: {
            reset_at?: number;
            limit_window_seconds?: number;
            used_percent?: number;
          };
        };
      };

      const windows: RateWindow[] = [];

      if (data.rate_limit?.primary_window) {
        windows.push(toWindow(data.rate_limit.primary_window, 10800));
      }

      if (data.rate_limit?.secondary_window) {
        windows.push(toWindow(data.rate_limit.secondary_window, 86400));
      }

      return { provider: "codex", displayName: "Codex", windows, resets };
    } catch (error) {
      clear();
      return {
        provider: "codex",
        displayName: "Codex",
        windows: [],
        error: errorMessage(error),
      };
    }
  },
};
