import type { ProviderQuotaResult, QuotaWindow } from "@paperclipai/adapter-utils";

const MISTRAL_ADMIN_API_KEY_ENV_VAR = "MISTRAL_ADMIN_API_KEY";
const ADMIN_API_BASE_URL = "https://api.mistral.ai/v1/admin";
const QUOTA_FETCH_TIMEOUT_MS = 8000;

/**
 * The adapter-utils `ProviderQuotaResult.errorFamily` is typed as the narrow
 * `AdapterExecutionErrorFamily` union, but the Paperclip server's quota
 * service accepts the wider string families it uses for managed connections
 * (credentials_unavailable, authentication_required, permission_denied,
 * provider_unavailable). These are the values this adapter emits; they match
 * the server's mapping (server/src/services/quota-windows.ts).
 */
type QuotaErrorFamily =
  | "credentials_unavailable"
  | "authentication_required"
  | "permission_denied"
  | "provider_unavailable";

function quotaError(family: QuotaErrorFamily, error: string): Pick<ProviderQuotaResult, "ok" | "errorFamily" | "error"> {
  return { ok: false, errorFamily: family as ProviderQuotaResult["errorFamily"], error };
}

interface AdminUsageResponse {
  start_date?: string;
  end_date?: string;
  currency?: string;
  usage?: Record<string, { amount?: number; cost?: number }>;
}

interface AdminSpendLimitResponse {
  amount?: number | null;
  no_monthly_limit?: boolean;
}

/**
 * Resolve the optional Mistral Admin API key. The Paperclip host calls
 * `getQuotaWindows()` once per adapter type (not per agent), so the key comes
 * from the server process environment, not from an agent's adapter config.
 * A standard Code › Vibe CLI plan key does NOT work on admin endpoints; an
 * Admin API key can only be created on Enterprise plans.
 */
function resolveAdminApiKey(): string | null {
  const value = process.env[MISTRAL_ADMIN_API_KEY_ENV_VAR];
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : null;
}

async function fetchAdminJson(
  path: string,
  adminKey: string,
): Promise<{ status: number; body: unknown }> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), QUOTA_FETCH_TIMEOUT_MS);
  try {
    const response = await fetch(`${ADMIN_API_BASE_URL}${path}`, {
      method: "GET",
      headers: { "x-api-key": adminKey, Accept: "application/json" },
      signal: controller.signal,
    });
    const body: unknown = await response.json().catch(() => null);
    return { status: response.status, body };
  } finally {
    clearTimeout(timer);
  }
}

function asRecord(value: unknown): Record<string, unknown> | null {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return null;
  return value as Record<string, unknown>;
}

function asFiniteNumber(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function clampPercent(value: number): number {
  return Math.min(100, Math.max(0, value));
}

function toIsoDate(value: unknown): string | null {
  if (typeof value !== "string" || value.trim().length === 0) return null;
  const parsed = new Date(value);
  return Number.isNaN(parsed.getTime()) ? null : parsed.toISOString();
}

function monthWindow(now = new Date()): { month: number; year: number } {
  return { month: now.getUTCMonth() + 1, year: now.getUTCFullYear() };
}

/**
 * Live Vibe quota windows for Paperclip's quota dashboard.
 *
 * Opt-in and Enterprise-only: when the Paperclip server process has
 * MISTRAL_ADMIN_API_KEY set (an Admin API key created in the Mistral Admin
 * Panel), the adapter queries the Mistral Admin API:
 *
 * - GET /v1/admin/usage?month=&year= — org consumption broken down by
 *   category, including the dedicated `vibe_usage` category, with the period
 *   (start_date/end_date) and currency.
 * - GET /v1/admin/spend-limit — the org monthly spending limit
 *   ({ amount, no_monthly_limit }).
 *
 * Vibe plan keys draw from the plan's included monthly usage first, so
 * `vibe_usage` spend against the monthly limit is the number that matters for
 * Paperclip agents. Without an Admin API key the hook reports ok=false so the
 * UI simply shows no quota row.
 *
 * The admin key is read from the server process environment only; it is never
 * logged, never returned, and never passed to the vibe-acp process (only the
 * per-agent MISTRAL_API_KEY is forwarded to runs).
 */
export async function getQuotaWindows(): Promise<ProviderQuotaResult> {
  const adminKey = resolveAdminApiKey();
  if (!adminKey) {
    return {
      provider: "mistral",
      source: "mistral-admin-api",
      ...quotaError(
        "credentials_unavailable",
        `No ${MISTRAL_ADMIN_API_KEY_ENV_VAR} set on the Paperclip server. The Admin API requires an Enterprise plan; a Code › Vibe CLI plan key does not work on admin endpoints.`,
      ),
      windows: [],
    };
  }

  const { month, year } = monthWindow();
  let usage: { status: number; body: unknown };
  let spendLimit: { status: number; body: unknown };
  try {
    [usage, spendLimit] = await Promise.all([
      fetchAdminJson(`/usage?month=${month}&year=${year}`, adminKey),
      fetchAdminJson("/spend-limit", adminKey),
    ]);
  } catch (err) {
    return {
      provider: "mistral",
      source: "mistral-admin-api",
      ...quotaError(
        "provider_unavailable",
        `Mistral Admin API unreachable: ${err instanceof Error ? err.message : String(err)}`,
      ),
      windows: [],
    };
  }

  if (usage.status === 401 || usage.status === 403) {
    return {
      provider: "mistral",
      source: "mistral-admin-api",
      ...quotaError(
        usage.status === 401 ? "authentication_required" : "permission_denied",
        `Mistral Admin API rejected the key (HTTP ${usage.status}). Admin endpoints require an Admin API key on an Enterprise plan.`,
      ),
      windows: [],
    };
  }
  if (usage.status !== 200) {
    return {
      provider: "mistral",
      source: "mistral-admin-api",
      ...quotaError("provider_unavailable", `Mistral Admin API returned HTTP ${usage.status} for /usage.`),
      windows: [],
    };
  }

  const usageBody = asRecord(usage.body) as AdminUsageResponse | null;
  const categories = asRecord(usageBody?.usage) ?? {};
  const vibeUsage = asRecord(categories.vibe_usage);
  const vibeSpend = asFiniteNumber(vibeUsage?.cost) ?? asFiniteNumber(vibeUsage?.amount) ?? 0;
  const currency = typeof usageBody?.currency === "string" ? usageBody.currency : "";
  const periodStart = toIsoDate(usageBody?.start_date);
  const periodEnd = toIsoDate(usageBody?.end_date);
  const periodDetail = periodStart && periodEnd
    ? `Billing period ${periodStart.slice(0, 10)} → ${periodEnd.slice(0, 10)}.`
    : null;

  const limitBody = asRecord(spendLimit.body) as AdminSpendLimitResponse | null;
  const limitAmount = asFiniteNumber(limitBody?.amount);
  const noMonthlyLimit = limitBody?.no_monthly_limit === true;

  const windows: QuotaWindow[] = [];
  if (spendLimit.status === 200 && limitAmount !== null && limitAmount > 0 && !noMonthlyLimit) {
    windows.push({
      label: "Vibe monthly spend",
      usedPercent: clampPercent((vibeSpend / limitAmount) * 100),
      resetsAt: periodEnd,
      valueLabel: `${vibeSpend} / ${limitAmount}${currency ? ` ${currency}` : ""} spent`,
      detail: [
        "Organization monthly spending limit; it caps API and Vibe consumption together.",
        "Vibe plan included usage is consumed first; pay-as-you-go applies only if enabled.",
        periodDetail,
      ].filter(Boolean).join(" "),
    });
  } else {
    windows.push({
      label: "Vibe monthly usage",
      usedPercent: null,
      resetsAt: periodEnd,
      valueLabel: `${vibeSpend}${currency ? ` ${currency}` : ""} spent this period`,
      detail: [
        noMonthlyLimit
          ? "No monthly spending limit is set on the organization."
          : "No monthly spending limit reported.",
        "The Vibe plan's included monthly usage applies first, then pay-as-you-go if enabled.",
        periodDetail,
      ].filter(Boolean).join(" "),
    });
  }

  return {
    provider: "mistral",
    source: "mistral-admin-api",
    ok: true,
    windows,
  };
}

export { MISTRAL_ADMIN_API_KEY_ENV_VAR };
