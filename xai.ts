import {
  API_TIMEOUT_MS,
  clampPercent,
  createTimeoutController,
  errorMessage,
  formatReset,
  home,
  parseDate,
  readAuth,
  readJson,
} from "./util.js";
import type { RateWindow, UsageProvider, UsageSnapshot } from "./types.js";

const BILLING_BASE = "https://cli-chat-proxy.grok.com/v1/billing";

function loadToken(): string | undefined {
  const auth = readAuth();
  const xai = auth.xai;
  if (xai && typeof xai === "object") {
    const access = (xai as { access?: unknown }).access;
    if (typeof access === "string" && access) return access;
  }

  if (process.env.XAI_OAUTH_TOKEN) return process.env.XAI_OAUTH_TOKEN;
  if (process.env.GROK_CLI_OAUTH_TOKEN) return process.env.GROK_CLI_OAUTH_TOKEN;

  const grokHome = process.env.GROK_HOME || `${home()}/.grok`;
  const data = readJson(`${grokHome}/auth.json`);
  if (!data) return undefined;
  for (const entry of Object.values(data)) {
    if (!entry || typeof entry !== "object") continue;
    const key = (entry as { key?: unknown }).key;
    if (typeof key === "string" && key) return key;
  }
  return undefined;
}

async function fetchJson(
  url: string,
  headers: Record<string, string>,
): Promise<{
  ok: boolean;
  status?: number;
  data?: { config?: Parameters<typeof parseMonthly>[0] & Parameters<typeof parseWeekly>[0] };
  error?: string;
}> {
  const { controller, clear } = createTimeoutController(API_TIMEOUT_MS);
  try {
    const res = await fetch(url, { headers, signal: controller.signal });
    clear();
    if (!res.ok) {
      return { ok: false, status: res.status, error: `HTTP ${res.status}` };
    }
    return {
      ok: true,
      status: res.status,
      data: (await res.json()) as {
        config?: Parameters<typeof parseMonthly>[0] & Parameters<typeof parseWeekly>[0];
      },
    };
  } catch (error) {
    clear();
    return { ok: false, error: errorMessage(error) };
  }
}

function parseMonthly(config: {
  monthlyLimit?: { val?: number };
  used?: { val?: number };
  billingPeriodEnd?: string;
}): RateWindow | undefined {
  const limit = config.monthlyLimit?.val;
  const used = config.used?.val;
  if (typeof limit !== "number" || limit <= 0 || typeof used !== "number" || used < 0)
    return undefined;
  const resetDate = parseDate(config.billingPeriodEnd);
  return {
    label: "Month",
    usedPercent: clampPercent((used / limit) * 100),
    resetDescription: resetDate ? formatReset(resetDate) : undefined,
    resetAt: resetDate?.toISOString(),
  };
}

function parseWeekly(config: {
  currentPeriod?: { type?: string; start?: string; end?: string };
  creditUsagePercent?: number;
  billingPeriodEnd?: string;
}): RateWindow | undefined {
  if (config.currentPeriod?.type !== "USAGE_PERIOD_TYPE_WEEKLY") return undefined;
  const end =
    (typeof config.billingPeriodEnd === "string" && config.billingPeriodEnd) ||
    (typeof config.currentPeriod.end === "string" && config.currentPeriod.end) ||
    undefined;
  const resetDate = parseDate(end);
  const raw = config.creditUsagePercent;
  return {
    label: "Week",
    usedPercent: clampPercent(typeof raw === "number" && Number.isFinite(raw) ? raw : 0),
    resetDescription: resetDate ? formatReset(resetDate) : undefined,
    resetAt: resetDate?.toISOString(),
  };
}

export const xai: UsageProvider = {
  name: "xai",
  displayName: "Grok",

  hasCredentials() {
    return Boolean(loadToken());
  },

  async fetchUsage(): Promise<UsageSnapshot> {
    const accessToken = loadToken();
    if (!accessToken) {
      return { provider: "xai", displayName: "Grok", windows: [], error: "No credentials" };
    }

    const headers = {
      Authorization: `Bearer ${accessToken}`,
      Accept: "application/json",
      "x-xai-token-auth": "xai-grok-cli",
    };

    const [monthlyRes, weeklyRes] = await Promise.all([
      fetchJson(BILLING_BASE, headers),
      fetchJson(`${BILLING_BASE}?format=credits`, headers),
    ]);

    const windows: RateWindow[] = [];
    const monthly =
      monthlyRes.ok && monthlyRes.data?.config ? parseMonthly(monthlyRes.data.config) : undefined;
    const weekly =
      weeklyRes.ok && weeklyRes.data?.config ? parseWeekly(weeklyRes.data.config) : undefined;
    if (monthly) windows.push(monthly);
    if (weekly) windows.push(weekly);

    if (windows.length === 0) {
      const monthlyAuthFailure = monthlyRes.status === 401 || monthlyRes.status === 403;
      const weeklyAuthFailure = weeklyRes.status === 401 || weeklyRes.status === 403;
      if (monthlyAuthFailure && weeklyAuthFailure) {
        return {
          provider: "xai",
          displayName: "Grok",
          windows: [],
          error: `HTTP ${monthlyRes.status}`,
        };
      }
      const result = weeklyAuthFailure ? monthlyRes : weeklyRes;
      const other = weeklyAuthFailure ? weeklyRes : monthlyRes;
      const error = result.error ?? other.error ?? "No usage windows returned";
      return { provider: "xai", displayName: "Grok", windows: [], error };
    }
    return { provider: "xai", displayName: "Grok", windows };
  },
};
