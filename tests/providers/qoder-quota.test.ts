import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { clearProviderQuotaCache, fetchProviderApiKeyQuotas, fetchProviderQuotaReports } from "../../src/providers/quota";
import {
  fetchQoderQuota,
  isCanonicalQoderBaseUrl,
  keyQuotaReaderForProvider,
  providerApiKeyQuotaMode,
} from "../../src/providers/quota/vendor-probes-key";
import { TERMINAL_QUOTA_FAILURE } from "../../src/providers/quota/report-cache";
import type { OcxConfig, OcxProviderConfig } from "../../src/types";
import { removeTreeWithRetry } from "../helpers/remove-tree";

const originalFetch = globalThis.fetch;
const previousOpencodexHome = process.env.OPENCODEX_HOME;
let opencodexHome: string;

function qoderConfig(overrides?: Partial<OcxProviderConfig>): OcxConfig {
  return {
    defaultProvider: "qoder",
    providers: {
      qoder: {
        adapter: "qoder",
        authMode: "key",
        baseUrl: "https://qoder.com",
        apiKey: "pat_test_secret_123",
        ...overrides,
      },
    },
  } as unknown as OcxConfig;
}

beforeEach(() => {
  opencodexHome = mkdtempSync(join(tmpdir(), "ocx-qoder-quota-"));
  process.env.OPENCODEX_HOME = opencodexHome;
  clearProviderQuotaCache();
});

afterEach(() => {
  globalThis.fetch = originalFetch;
  clearProviderQuotaCache();
  if (previousOpencodexHome === undefined) delete process.env.OPENCODEX_HOME;
  else process.env.OPENCODEX_HOME = previousOpencodexHome;
  removeTreeWithRetry(opencodexHome);
});

describe("Qoder provider quota probe", () => {
  test("canonical URL guards admit https://qoder.com and reject CN or lookalikes", () => {
    expect(isCanonicalQoderBaseUrl("https://qoder.com")).toBe(true);
    expect(isCanonicalQoderBaseUrl("https://qoder.com/")).toBe(true);
    expect(isCanonicalQoderBaseUrl("https://qoder.cn")).toBe(false);
    expect(isCanonicalQoderBaseUrl("https://evil.qoder.com")).toBe(false);
    expect(isCanonicalQoderBaseUrl("https://qoder.com.fake.org")).toBe(false);
    expect(isCanonicalQoderBaseUrl(undefined)).toBe(false);

    const configGlobal = qoderConfig().providers.qoder!;
    expect(keyQuotaReaderForProvider("qoder", configGlobal)).toBe(fetchQoderQuota);
    expect(providerApiKeyQuotaMode("qoder", configGlobal)).toBe("probe");

    const configCn: OcxProviderConfig = {
      adapter: "qoder",
      authMode: "key",
      baseUrl: "https://qoder.cn",
      apiKey: "pat_cn",
    };
    expect(keyQuotaReaderForProvider("qoder-cn", configCn)).toBeNull();
    expect(providerApiKeyQuotaMode("qoder-cn", configCn)).toBe("unsupported");
  });

  test("exchanges PAT for bearer token and maps userQuota + addOnQuota to creditBuckets", async () => {
    const requests: Array<{ url: string; method: string; auth?: string; body?: unknown }> = [];

    globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      const headers = init?.headers as Record<string, string> | undefined;
      let body: unknown;
      if (typeof init?.body === "string") {
        try { body = JSON.parse(init.body); } catch { body = init.body; }
      }
      requests.push({
        url,
        method: init?.method ?? "GET",
        auth: headers?.Authorization,
        body,
      });

      if (url === "https://openapi.qoder.sh/api/v1/jobToken/exchange") {
        return new Response(JSON.stringify({
          code: 0,
          data: { token: "temp_job_token_xyz" },
        }), { status: 200, headers: { "Content-Type": "application/json" } });
      }

      if (url === "https://openapi.qoder.sh/api/v2/quota/usage") {
        return new Response(JSON.stringify({
          userQuota: {
            total: 1000,
            used: 200,
            remaining: 800,
            percentage: "20%",
            unit: "credits",
            isQuotaExceeded: false,
          },
          addOnQuota: {
            total: 1800,
            used: 323,
            remaining: 1477,
            percentage: 0.24, // fractional and inconsistent; used / total is authoritative
            unit: "credits",
            isQuotaExceeded: false,
          },
        }), { status: 200, headers: { "Content-Type": "application/json" } });
      }

      return new Response("Not found", { status: 404 });
    }) as unknown as typeof fetch;

    const config = qoderConfig();
    const result = await fetchQoderQuota("qoder", config.providers.qoder!);
    expect(result).not.toBeNull();
    expect(result).not.toBe(TERMINAL_QUOTA_FAILURE);

    expect(requests).toHaveLength(2);
    // 1. Exchange
    expect(requests[0]?.url).toBe("https://openapi.qoder.sh/api/v1/jobToken/exchange");
    expect(requests[0]?.method).toBe("POST");
    expect(requests[0]?.body).toEqual({ personal_token: "pat_test_secret_123" });
    expect(requests[0]?.auth).toBeUndefined();

    // 2. Usage
    expect(requests[1]?.url).toBe("https://openapi.qoder.sh/api/v2/quota/usage");
    expect(requests[1]?.method).toBe("GET");
    expect(requests[1]?.auth).toBe("Bearer temp_job_token_xyz");

    // Output shape
    const report = result as { quota: { creditBuckets: unknown[] } };
    expect(report.quota.creditBuckets).toEqual([
      {
        kind: "userQuota",
        used: 200,
        limit: 1000,
        remaining: 800,
        percent: 20,
      },
      {
        kind: "addOnQuota",
        used: 323,
        limit: 1800,
        remaining: 1477,
        percent: 17.94,
      },
    ]);
  });

  test("correctly parses boundary cases like 0/0 and percent absent without NaN", async () => {
    globalThis.fetch = (async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.includes("/jobToken/exchange")) {
        return new Response(JSON.stringify({ token: "t1" }), { status: 200 });
      }
      return new Response(JSON.stringify({
        data: {
          userQuota: {
            total: 0,
            used: 0,
            remaining: 0,
            percentage: 0,
          },
          addOnQuota: {
            total: 500,
            used: 100,
            remaining: 400,
            // percentage absent
          },
        },
      }), { status: 200 });
    }) as unknown as typeof fetch;

    const result = await fetchQoderQuota("qoder", qoderConfig().providers.qoder!);
    expect(result).not.toBeNull();
    const report = result as { quota: { creditBuckets: Array<{ kind: string; used: number; limit: number; remaining?: number; percent?: number }> } };
    expect(report.quota.creditBuckets).toHaveLength(2);

    const user = report.quota.creditBuckets.find(b => b.kind === "userQuota")!;
    expect(user.used).toBe(0);
    expect(user.limit).toBe(0);
    expect(user.remaining).toBe(0);
    expect(user.percent).toBe(0);

    const addOn = report.quota.creditBuckets.find(b => b.kind === "addOnQuota")!;
    expect(addOn.used).toBe(100);
    expect(addOn.limit).toBe(500);
    expect(addOn.remaining).toBe(400);
    expect(addOn.percent).toBe(20);
  });

  test("handles missing fields, derivations, and unreliable data without forging 0", async () => {
    // 1. used missing: derives total - remaining
    // 2. total missing: derives used + remaining
    globalThis.fetch = (async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.includes("/jobToken/exchange")) {
        return new Response(JSON.stringify({ token: "t1" }), { status: 200 });
      }
      return new Response(JSON.stringify({
        data: {
          userQuota: {
            total: 1000,
            remaining: 750,
          },
          addOnQuota: {
            used: 300,
            remaining: 700,
          },
        },
      }), { status: 200 });
    }) as unknown as typeof fetch;

    const result = await fetchQoderQuota("qoder", qoderConfig().providers.qoder!);
    expect(result).not.toBeNull();
    const report = result as { quota: { creditBuckets: Array<{ kind: string; used: number; limit: number; remaining?: number }> } };
    expect(report.quota.creditBuckets).toHaveLength(2);

    const user = report.quota.creditBuckets.find(b => b.kind === "userQuota")!;
    expect(user.used).toBe(250); // derived: 1000 - 750
    expect(user.limit).toBe(1000);
    expect(user.remaining).toBe(750);

    const addOn = report.quota.creditBuckets.find(b => b.kind === "addOnQuota")!;
    expect(addOn.used).toBe(300);
    expect(addOn.limit).toBe(1000); // derived: 300 + 700
    expect(addOn.remaining).toBe(700);

    // 3. Unreliable missing fields: cannot forge 0 (including remaining > total anomaly)
    globalThis.fetch = (async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.includes("/jobToken/exchange")) {
        return new Response(JSON.stringify({ token: "t1" }), { status: 200 });
      }
      return new Response(JSON.stringify({
        data: {
          userQuota: {
            used: 500, // no total, no remaining: cannot reliably determine total or forge 0
          },
          addOnQuota: {
            total: 1000, // no used, no remaining: cannot reliably determine used or forge 0
          },
        },
      }), { status: 200 });
    }) as unknown as typeof fetch;

    expect(await fetchQoderQuota("qoder", qoderConfig().providers.qoder!)).toBeNull();

    // 3b. remaining > total with missing used must not forge 0 (Math.max(0, neg) defect avoided)
    globalThis.fetch = (async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.includes("/jobToken/exchange")) {
        return new Response(JSON.stringify({ token: "t1" }), { status: 200 });
      }
      return new Response(JSON.stringify({
        data: {
          userQuota: {
            total: 500,
            remaining: 600, // remaining > total, cannot reliably determine used -> must not forge 0
          },
        },
      }), { status: 200 });
    }) as unknown as typeof fetch;

    expect(await fetchQoderQuota("qoder", qoderConfig().providers.qoder!)).toBeNull();

    // 4. One bucket valid, one bucket invalid: keeps only the valid bucket
    globalThis.fetch = (async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.includes("/jobToken/exchange")) {
        return new Response(JSON.stringify({ token: "t1" }), { status: 200 });
      }
      return new Response(JSON.stringify({
        data: {
          userQuota: {
            total: 500,
            remaining: 500, // used missing, derived as 500 - 500 = 0 (legitimate zero)
          },
          addOnQuota: {
            remaining: 200, // cannot determine used or total -> dropped
          },
        },
      }), { status: 200 });
    }) as unknown as typeof fetch;

    const partialResult = await fetchQoderQuota("qoder", qoderConfig().providers.qoder!);
    expect(partialResult).not.toBeNull();
    const partialReport = partialResult as { quota: { creditBuckets: Array<{ kind: string; used: number; limit: number; remaining?: number }> } };
    expect(partialReport.quota.creditBuckets).toEqual([
      { kind: "userQuota", used: 0, limit: 500, remaining: 500, percent: 0 },
    ]);
  });

  test("returns TERMINAL_QUOTA_FAILURE on 401 and null on transient errors", async () => {
    // 401 on exchange -> terminal
    globalThis.fetch = (async () => new Response("Unauthorized", { status: 401 })) as unknown as typeof fetch;
    expect(await fetchQoderQuota("qoder", qoderConfig().providers.qoder!)).toBe(TERMINAL_QUOTA_FAILURE);

    // 401 on usage -> terminal
    globalThis.fetch = (async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.includes("/jobToken/exchange")) {
        return new Response(JSON.stringify({ token: "t1" }), { status: 200 });
      }
      return new Response("Unauthorized", { status: 401 });
    }) as unknown as typeof fetch;
    expect(await fetchQoderQuota("qoder", qoderConfig().providers.qoder!)).toBe(TERMINAL_QUOTA_FAILURE);

    // 429 on exchange -> null (transient)
    globalThis.fetch = (async () => new Response("Too Many Requests", { status: 429 })) as unknown as typeof fetch;
    expect(await fetchQoderQuota("qoder", qoderConfig().providers.qoder!)).toBeNull();

    // 500 on usage -> null (transient)
    globalThis.fetch = (async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.includes("/jobToken/exchange")) {
        return new Response(JSON.stringify({ token: "t1" }), { status: 200 });
      }
      return new Response("Server error", { status: 500 });
    }) as unknown as typeof fetch;
    expect(await fetchQoderQuota("qoder", qoderConfig().providers.qoder!)).toBeNull();

    // Malformed JSON -> null
    globalThis.fetch = (async () => new Response("not-json", { status: 200 })) as unknown as typeof fetch;
    expect(await fetchQoderQuota("qoder", qoderConfig().providers.qoder!)).toBeNull();
  });

  test("multi-PAT key pools query and cache independently without cross-talk", async () => {
    const exchangeCalls: string[] = [];
    globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (url.includes("/jobToken/exchange")) {
        const body = JSON.parse(init?.body as string);
        exchangeCalls.push(body.personal_token);
        const token = body.personal_token === "pat_A" ? "token_A" : "token_B";
        return new Response(JSON.stringify({ token }), { status: 200 });
      }
      if (url.includes("/quota/usage")) {
        const auth = (init?.headers as Record<string, string>)?.Authorization;
        if (auth === "Bearer token_A") {
          return new Response(JSON.stringify({
            userQuota: { total: 1000, used: 100, remaining: 900, percentage: 10 },
          }), { status: 200 });
        }
        if (auth === "Bearer token_B") {
          return new Response(JSON.stringify({
            userQuota: { total: 2000, used: 800, remaining: 1200, percentage: 40 },
          }), { status: 200 });
        }
      }
      return new Response("Not found", { status: 404 });
    }) as unknown as typeof fetch;

    const poolConfig: OcxConfig = {
      defaultProvider: "qoder",
      providers: {
        qoder: {
          adapter: "qoder",
          authMode: "key",
          baseUrl: "https://qoder.com",
          apiKeyPool: [
            { id: "key-1", key: "pat_A" },
            { id: "key-2", key: "pat_B" },
          ],
        },
      },
    } as unknown as OcxConfig;

    const keyQuotas = await fetchProviderApiKeyQuotas(poolConfig, "qoder", true);
    expect(keyQuotas).toHaveLength(2);

    expect(keyQuotas[0]?.keyId).toBe("key-1");
    expect(keyQuotas[0]?.quota?.creditBuckets?.[0]?.remaining).toBe(900);
    expect(keyQuotas[0]?.quota?.creditBuckets?.[0]?.used).toBe(100);

    expect(keyQuotas[1]?.keyId).toBe("key-2");
    expect(keyQuotas[1]?.quota?.creditBuckets?.[0]?.remaining).toBe(1200);
    expect(keyQuotas[1]?.quota?.creditBuckets?.[0]?.used).toBe(800);

    expect(exchangeCalls).toEqual(["pat_A", "pat_B"]);
  });

  test("quota report is display-only and attaches no routing evidence", async () => {
    globalThis.fetch = (async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.includes("/jobToken/exchange")) {
        return new Response(JSON.stringify({ token: "tok" }), { status: 200 });
      }
      return new Response(JSON.stringify({
        userQuota: { total: 1000, used: 1000, remaining: 0, percentage: 100, isQuotaExceeded: true },
      }), { status: 200 });
    }) as unknown as typeof fetch;

    const config = qoderConfig();
    const reports = await fetchProviderQuotaReports(config, true);
    expect(reports.reports).toHaveLength(1);
    const report = reports.reports[0]!;
    expect(report.provider).toBe("qoder");
    expect(report.source).toBe("qoder:quota");
    expect(report.quota.creditBuckets?.[0]?.percent).toBe(100);

    // Verify keyReport did not pass inferenceQuota:
    // Display-only reports do not register routingEvidence
    const { routingEvidence } = await import("../../src/providers/quota/report-cache");
    expect(routingEvidence.has(report)).toBe(false);
  });

  test("handles POST jobToken/exchange timeout gracefully with null degradation and no usage call", async () => {
    let exchangeCalls = 0;
    let usageCalls = 0;
    let observedExchangeSignal: AbortSignal | undefined;

    globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (url.includes("/jobToken/exchange")) {
        exchangeCalls++;
        expect(init?.method).toBe("POST");
        observedExchangeSignal = init?.signal as AbortSignal | undefined;
        expect(observedExchangeSignal).toBeInstanceOf(AbortSignal);
        // Simulate fetch abort/timeout semantics via TimeoutError DOMException
        throw new DOMException("The operation was aborted due to timeout", "TimeoutError");
      }
      if (url.includes("/quota/usage")) {
        usageCalls++;
        return new Response("{}", { status: 200 });
      }
      return new Response("Not found", { status: 404 });
    }) as unknown as typeof fetch;

    const config = qoderConfig({ apiKey: "pat_test_exchange_timeout_mock" });
    const result = await fetchQoderQuota("qoder", config.providers.qoder!);

    // Assert safe degradation to null on exchange timeout
    expect(result).toBeNull();
    expect(exchangeCalls).toBe(1);
    expect(observedExchangeSignal).toBeInstanceOf(AbortSignal);
    // Usage endpoint must not be invoked if exchange timed out
    expect(usageCalls).toBe(0);

    // Verify no routing authorization side effect
    const reports = await fetchProviderQuotaReports(config, true);
    expect(reports.reports).toHaveLength(0);
    const { routingEvidence } = await import("../../src/providers/quota/report-cache");
    expect(reports.reports.some(r => routingEvidence.has(r))).toBe(false);
  });

  test("handles GET quota/usage timeout after successful exchange with null degradation and bearer auth", async () => {
    let exchangeCalls = 0;
    let usageCalls = 0;
    let usageAuthHeader: string | undefined;
    let observedUsageSignal: AbortSignal | undefined;

    const mockPat = "pat_test_usage_timeout_mock";
    const mockBearer = "mock_bearer_exchange_success_token";

    globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (url.includes("/jobToken/exchange")) {
        exchangeCalls++;
        expect(init?.method).toBe("POST");
        const body = JSON.parse(init?.body as string);
        expect(body.personal_token).toBe(mockPat);
        return new Response(JSON.stringify({ token: mockBearer }), { status: 200 });
      }
      if (url.includes("/quota/usage")) {
        usageCalls++;
        usageAuthHeader = (init?.headers as Record<string, string>)?.Authorization;
        observedUsageSignal = init?.signal as AbortSignal | undefined;
        expect(observedUsageSignal).toBeInstanceOf(AbortSignal);
        // Simulate fetch abort/timeout semantics via TimeoutError DOMException
        throw new DOMException("The operation was aborted due to timeout", "TimeoutError");
      }
      return new Response("Not found", { status: 404 });
    }) as unknown as typeof fetch;

    const config = qoderConfig({ apiKey: mockPat });
    const result = await fetchQoderQuota("qoder", config.providers.qoder!);

    // Assert safe degradation to null on usage timeout
    expect(result).toBeNull();
    expect(exchangeCalls).toBe(1);
    expect(usageCalls).toBe(1);
    // Verify usage request used the exchanged bearer token
    expect(usageAuthHeader).toBe(`Bearer ${mockBearer}`);
    expect(observedUsageSignal).toBeInstanceOf(AbortSignal);

    // Verify no routing authorization side effect
    const reports = await fetchProviderQuotaReports(config, true);
    expect(reports.reports).toHaveLength(0);
    const { routingEvidence } = await import("../../src/providers/quota/report-cache");
    expect(reports.reports.some(r => routingEvidence.has(r))).toBe(false);
  });
});
