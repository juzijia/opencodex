import { DICTS, I18nContext, interpolate, type Locale, type TFn, type TKey, type Vars } from "../src/i18n/shared";
import { expect, test } from "bun:test";
import type { ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import QoderCreditQuota from "../src/components/provider-workspace/QoderCreditQuota";
import ProviderAuthPanel from "../src/components/provider-workspace/ProviderAuthPanel";
import ProviderOverview from "../src/components/provider-workspace/ProviderOverview";
import ProviderUsage from "../src/components/provider-workspace/ProviderUsage";
import ProviderOverviewDashboard from "../src/components/provider-workspace/ProviderOverviewDashboard";
import { LanguageProvider } from "../src/i18n/provider";

const html = (node: ReactNode) => renderToStaticMarkup(<LanguageProvider>{node}</LanguageProvider>);
const item = (name: string) => ({ name, adapter: name, baseUrl: "https://example.org", authMode: "key" as const });
const quota = {
  updatedAt: 1,
  creditBuckets: [
    { kind: "addOnQuota", used: 400, limit: 2000, remaining: 1600, percent: 20 },
    { kind: "userQuota", used: 0, limit: 0, remaining: 0, percent: 0 },
  ],
};

test("Qoder compact rows sort plan before add-on and show balances without USD", () => {
  const markup = html(<QoderCreditQuota quotaMode="probe" quota={{
    ...quota, creditBuckets: [{ kind: "addOnQuota", used: 627, limit: 2700, remaining: 2073, percent: 23.22 }, quota.creditBuckets[1]!],
  }} />);
  expect(markup).toContain("quota-compact");
  expect(markup).toContain("qoder-credit-quota");
  expect(markup.indexOf("Plan Credits")).toBeLessThan(markup.indexOf("Add-on Pack"));
  for (const text of ["No quota", "0 / 0", "627 / 2,700", "2,073 remaining", "--bar-scale:0.2322"]) {
    expect(markup).toContain(text);
  }
  expect(markup).not.toContain("remaining 2,073");
  expect(markup).not.toContain("pws-capacity-details");
  expect(markup).not.toContain("USD");
});

test("Dashboard routes credit buckets to Qoder only", () => {
  const markup = html(<ProviderOverviewDashboard
    sections={{ ready: [{ ...item("qoder") }], needsSetup: [], disabled: [] }}
    quotaReports={{ qoder: { updatedAt: Date.now(), quota: {
      creditBuckets: [{ kind: "addOnQuota", used: 1, limit: 1000, remaining: 999, percent: 0.1 }],
    } } }}
    usageTotals={{}}
    onSelectProvider={() => {}}
  />);
  for (const text of ["0%", "1 / 1,000", "999", "pws-dashboard-row-bars", "quota-compact", "qoder-credit-quota"]) {
    expect(markup).toContain(text);
  }
  expect(markup).not.toContain("pws-capacity-details");
  expect(markup).not.toContain("&lt;1%");

  const other = html(<ProviderOverviewDashboard
    sections={{ ready: [item("other-provider")], needsSetup: [], disabled: [] }}
    quotaReports={{ "other-provider": { updatedAt: Date.now(), quota } }}
    usageTotals={{}}
    onSelectProvider={() => {}}
  />);
  expect(other).not.toContain("qoder-credit-quota");
  expect(other).toContain("pws-capacity-details");
});

test("unavailable Qoder quota keeps shared failure state", () => {
  const markup = html(<QoderCreditQuota quotaMode="probe" quotaUnavailable />);
  expect(markup).toContain('data-quota-state="unavailable"');
  expect(markup).not.toContain("quota-compact");
});

test("Overview respects selected account, refresh, age and non-Qoder fallback", () => {
  const render = (name: string, reading: Parameters<typeof ProviderOverview>[0]["currentQuotaReading"] = { quotaMode: "probe", quota }) =>
    html(<ProviderOverview
      item={item(name)}
      quotaReport={{ quota: { weeklyPercent: 99, updatedAt: quota.updatedAt } }}
      currentQuotaReading={reading}
      onRefreshQuota={async () => true}
    />);
  const qoder = render("qoder");
  for (const text of ["qoder-credit-quota", "quota-compact", "400 / 2,000", "1,600 remaining", "pws-quota-refresh", "pws-usage-meta", "Quota updated"]) {
    expect(qoder).toContain(text);
  }
  expect(qoder).not.toContain("remaining 1,600");
  expect(qoder.indexOf("Plan Credits")).toBeLessThan(qoder.indexOf("Add-on Pack"));
  expect(qoder.match(/1,600/g)).toHaveLength(1);
  expect(qoder).not.toContain("99%");
  expect(qoder).not.toContain("pws-capacity-details");
  const other = render("other-provider");
  expect(other).not.toContain("qoder-credit-quota");
  expect(other).toContain("pws-capacity-details");
  const missing = render("qoder", { quotaMode: "probe" });
  expect(missing).not.toContain("99%");
  expect(missing).not.toContain("qoder-credit-quota");
});

test("Usage picks Qoder renderer only for Qoder", () => {
  const render = (name: string) => html(<ProviderUsage item={item(name)} quotaReport={{ quota, updatedAt: quota.updatedAt }} />);
  const qoder = render("qoder");
  expect(qoder).toContain("qoder-credit-quota");
  expect(qoder).not.toContain("pws-capacity-details");
  const other = render("other-provider");
  expect(other).not.toContain("qoder-credit-quota");
  expect(other).toContain("pws-capacity-details");
});

test("API key cards keep separate PAT balances and only one active-key marker", () => {
  const render = (name: string) => html(<ProviderAuthPanel
    item={{ ...item(name), hasApiKey: true }}
    apiBase=""
    authHandlers={{} as Parameters<typeof ProviderAuthPanel>[0]["authHandlers"]}
    keys={[
      { id: "active", masked: "active-key", active: true, quotaMode: "probe", quota },
      { id: "inactive", masked: "inactive-key", active: false, quotaMode: "probe", quota: {
        updatedAt: 1, creditBuckets: [{ kind: "addOnQuota", used: 100, limit: 1000, remaining: 900, percent: 10 }],
      } },
    ]}
  />);
  const qoder = render("qoder");
  for (const text of ["qoder-credit-quota", "No quota", "0 / 0", "400 / 2,000", "1,600 remaining", "900 remaining"]) {
    expect(qoder).toContain(text);
  }
  expect(qoder).not.toContain("remaining 1,600");
  expect(qoder).not.toContain("remaining 900");
  const cards = Array.from(qoder.matchAll(/<li class="([^"]*pwi-auth-acct[^"]*)"/g), match => match[1]);
  expect(cards).toHaveLength(2);
  expect(cards[0]).toContain("pwi-auth-acct--qoder");
  expect(cards[0]).toContain("pwi-auth-acct--active");
  expect(cards[1]).toContain("pwi-auth-acct--qoder");
  expect(cards[1]).not.toContain("pwi-auth-acct--active");
  const other = render("other-provider");
  expect(other).not.toContain("pwi-auth-acct--qoder");
  expect(other).not.toContain("qoder-credit-quota");
});

test("Qoder remaining credits renders localized natural word order across locales", () => {
  const renderIn = (locale: Locale) => {
    const dict = DICTS[locale];
    const t = ((key: TKey, vars?: Vars) => interpolate(dict[key] ?? key, vars)) as TFn;
    return renderToStaticMarkup(
      <I18nContext.Provider value={{ t, locale, setLocale: () => {} }}>
        <QoderCreditQuota quotaMode="probe" quota={{
          updatedAt: 1,
          creditBuckets: [{ kind: "addOnQuota", used: 100, limit: 1000, remaining: 900, percent: 10 }],
        }} />
      </I18nContext.Provider>,
    );
  };
  const enMarkup = renderIn("en");
  expect(enMarkup).toContain("900 remaining");
  expect(enMarkup).not.toContain("remaining 900");

  const zhMarkup = renderIn("zh");
  expect(zhMarkup).toContain("剩余 900");

  const jaMarkup = renderIn("ja");
  expect(jaMarkup).toContain("残り 900");

  const deMarkup = renderIn("de");
  expect(deMarkup).toContain("900 verbleibend");

  const ptMarkup = renderIn("pt");
  expect(ptMarkup).toContain("Saldo restante: 900");
  expect(ptMarkup).not.toContain("restantes");
});

test("missing remaining vs zero remaining semantics are strictly differentiated", () => {
  const withZero = html(<QoderCreditQuota quotaMode="probe" quota={{
    updatedAt: 1,
    creditBuckets: [{ kind: "addOnQuota", used: 1000, limit: 1000, remaining: 0, percent: 100 }],
  }} />);
  expect(withZero).toContain("0 remaining");

  const withoutRemaining = html(<QoderCreditQuota quotaMode="probe" quota={{
    updatedAt: 1,
    creditBuckets: [{ kind: "addOnQuota", used: 500, limit: 1000, percent: 50 }],
  }} />);
  expect(withoutRemaining).toContain("500 / 1,000");
  expect(withoutRemaining).not.toContain("remaining");
});

test("Qoder remaining credits in Portuguese formats balance neutrally for 1, 0, and 1781", () => {
  const dict = DICTS.pt;
  const t = ((key: TKey, vars?: Vars) => interpolate(dict[key] ?? key, vars)) as TFn;
  const format = new Intl.NumberFormat("pt");
  for (const remaining of [1, 0, 1781]) {
    const markup = renderToStaticMarkup(
      <I18nContext.Provider value={{ t, locale: "pt", setLocale: () => {} }}>
        <QoderCreditQuota quotaMode="probe" quota={{
          updatedAt: 1,
          creditBuckets: [{ kind: "addOnQuota", used: 100, limit: 2000, remaining, percent: 5 }],
        }} />
      </I18nContext.Provider>,
    );
    expect(markup).toContain(`Saldo restante: ${format.format(remaining)}`);
    expect(markup).not.toContain("restantes");
  }
});
