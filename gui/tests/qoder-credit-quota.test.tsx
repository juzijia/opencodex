import { expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import QoderCreditQuota from "../src/components/provider-workspace/QoderCreditQuota";
import ProviderOverviewDashboard from "../src/components/provider-workspace/ProviderOverviewDashboard";
import { LanguageProvider } from "../src/i18n/provider";

test("Qoder key quota reuses compact bars, orders plan before add-on, and shows one balance per bucket", () => {
  const markup = renderToStaticMarkup(
    <LanguageProvider>
      <QoderCreditQuota quotaMode="probe" quota={{
        updatedAt: 1,
        creditBuckets: [
          { kind: "addOnQuota", used: 627, limit: 2700, remaining: 2073, percent: 23.22 },
          { kind: "userQuota", used: 0, limit: 0, remaining: 0, percent: 0 },
        ],
      }} />
    </LanguageProvider>,
  );
  expect(markup).toContain("quota-compact");
  expect(markup).toContain("qoder-credit-quota");
  expect(markup).not.toContain("pws-capacity-details");
  expect(markup.indexOf("Plan Credits")).toBeLessThan(markup.indexOf("Add-on Pack"));
  expect(markup).toContain("No quota");
  expect(markup).toContain("0 / 0");
  expect(markup).toContain("627 / 2,700");
  expect(markup).toContain("remaining");
  expect(markup).toContain("2,073");
  expect(markup).toContain("--bar-scale:0.2322");
  expect(markup).not.toContain("USD");
});

test("Qoder displays usage below 1% as 0%, not <1%", () => {
  const markup = renderToStaticMarkup(
    <LanguageProvider>
      <QoderCreditQuota quotaMode="probe" quota={{
        updatedAt: 1,
        creditBuckets: [{ kind: "addOnQuota", used: 1, limit: 1000, remaining: 999, percent: 0.1 }],
      }} />
    </LanguageProvider>,
  );
  expect(markup).toContain("0%");
  expect(markup).not.toContain("&lt;1%");
  expect(markup).toContain("1 / 1,000");
  expect(markup).toContain("999");
});

test("Qoder provider dashboard routes credits to the compact renderer", () => {
  const markup = renderToStaticMarkup(
    <LanguageProvider>
      <ProviderOverviewDashboard
        sections={{
          ready: [{ name: "qoder", adapter: "qoder", baseUrl: "https://qoder.com", authMode: "key" }],
          needsSetup: [],
          disabled: [],
        }}
        quotaReports={{
          qoder: {
            updatedAt: Date.now(),
            quota: { creditBuckets: [{ kind: "addOnQuota", used: 1, limit: 1000, remaining: 999, percent: 0.1 }] },
          },
        }}
        usageTotals={{}}
        onSelectProvider={() => {}}
      />
    </LanguageProvider>,
  );
  expect(markup).toContain("pws-dashboard-row-bars");
  expect(markup).toContain("quota-compact");
  expect(markup).toContain("qoder-credit-quota");
  expect(markup).not.toContain("pws-capacity-details");
  expect(markup).not.toContain("&lt;1%");
});

test("unavailable Qoder key quota retains the existing shared failure message", () => {
  const markup = renderToStaticMarkup(
    <LanguageProvider>
      <QoderCreditQuota quotaMode="probe" quotaUnavailable />
    </LanguageProvider>,
  );
  expect(markup).toContain("data-quota-state=\"unavailable\"");
  expect(markup).not.toContain("quota-compact");
});
