import { expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import QoderCreditQuota from "../src/components/provider-workspace/QoderCreditQuota";
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

test("unavailable Qoder key quota retains the existing shared failure message", () => {
  const markup = renderToStaticMarkup(
    <LanguageProvider>
      <QoderCreditQuota quotaMode="probe" quotaUnavailable />
    </LanguageProvider>,
  );
  expect(markup).toContain("data-quota-state=\"unavailable\"");
  expect(markup).not.toContain("quota-compact");
});
