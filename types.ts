export const PROVIDERS = ["anthropic", "codex", "xai"] as const;

export type ProviderName = (typeof PROVIDERS)[number];

export interface RateWindow {
  label: string;
  usedPercent: number;
  resetDescription?: string;
  resetAt?: string;
}

export interface UsageSnapshot {
  provider: ProviderName;
  displayName: string;
  windows: RateWindow[];
  resets?: { count: number; expirations: string[] };
  error?: string;
}

export interface UsageProvider {
  readonly name: ProviderName;
  readonly displayName: string;
  hasCredentials(): boolean;
  fetchUsage(): Promise<UsageSnapshot>;
}
