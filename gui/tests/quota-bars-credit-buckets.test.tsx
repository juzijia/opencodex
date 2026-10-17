import { describe, expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import type { ReactNode } from "react";
import QuotaBars from "../src/components/QuotaBars";
import { en } from "../src/i18n/en";
import { zh } from "../src/i18n/zh";
import { I18nContext, interpolate, type Locale, type TFn } from "../src/i18n/shared";
import type { AccountQuota } from "../src/codex-quota-utils";

function renderWithLocale(node: ReactNode, locale: Locale = "en"): string {
  const dict = locale === "zh" ? zh : en;
  const t: TFn = (key, vars) => interpolate(dict[key] ?? key, vars);
  return renderToStaticMarkup(
    <I18nContext.Provider value={{ t, locale, setLocale: () => {} }}>
      {node}
    </I18nContext.Provider>,
  );
}

function quota(overrides: Partial<AccountQuota>): AccountQuota {
  return { updatedAt: 1, ...overrides };
}

describe("QuotaBars credit bucket and quota rendering", () => {
  test("0/0 credit bucket renders 'No quota' / '无配额' without a progress bar or limit reached marker", () => {
    const q = quota({
      creditBuckets: [
        { kind: "userQuota", used: 0, limit: 0, remaining: 0, percent: 0 },
      ],
    });

    // Stacked layout (en & zh)
    const stackedEn = renderWithLocale(<QuotaBars quota={q} threshold={80} t={((k, v) => interpolate(en[k], v)) as TFn} layout="stacked" />, "en");
    expect(stackedEn).toContain("No quota");
    expect(stackedEn).not.toContain("bar-fill");
    expect(stackedEn).not.toContain("0% used");
    expect(stackedEn).not.toContain("Limit reached");

    const stackedZh = renderWithLocale(<QuotaBars quota={q} threshold={80} t={((k, v) => interpolate(zh[k], v)) as TFn} layout="stacked" />, "zh");
    expect(stackedZh).toContain("无配额");
    expect(stackedZh).not.toContain("bar-fill");
    expect(stackedZh).not.toContain("已用 0%");
    expect(stackedZh).not.toContain("已达上限");

    // Compact layout (en & zh)
    const compactEn = renderWithLocale(<QuotaBars quota={q} threshold={80} t={((k, v) => interpolate(en[k], v)) as TFn} layout="compact" />, "en");
    expect(compactEn).toContain("No quota");
    expect(compactEn).not.toContain("bar-fill");
    expect(compactEn).not.toContain("0%");
    expect(compactEn).not.toContain("Limit reached");

    const compactZh = renderWithLocale(<QuotaBars quota={q} threshold={80} t={((k, v) => interpolate(zh[k], v)) as TFn} layout="compact" />, "zh");
    expect(compactZh).toContain("无配额");
    expect(compactZh).not.toContain("bar-fill");
    expect(compactZh).not.toContain("已用");
    expect(compactZh).not.toContain("已达上限");
  });

  test("exact 0% credit bucket renders 0% used and zero scale bar", () => {
    const q = quota({
      creditBuckets: [
        { kind: "addOnQuota", used: 0, limit: 1000, remaining: 1000, percent: 0 },
      ],
    });

    const stackedEn = renderWithLocale(<QuotaBars quota={q} threshold={80} t={((k, v) => interpolate(en[k], v)) as TFn} layout="stacked" />, "en");
    expect(stackedEn).toContain("0% used");
    expect(stackedEn).toContain("--bar-scale:0");
    expect(stackedEn).not.toContain("No quota");

    const stackedZh = renderWithLocale(<QuotaBars quota={q} threshold={80} t={((k, v) => interpolate(zh[k], v)) as TFn} layout="stacked" />, "zh");
    expect(stackedZh).toContain("已用 0%");
    expect(stackedZh).toContain("--bar-scale:0");
    expect(stackedZh).not.toContain("无配额");

    const compactZh = renderWithLocale(<QuotaBars quota={q} threshold={80} t={((k, v) => interpolate(zh[k], v)) as TFn} layout="compact" />, "zh");
    expect(compactZh).toContain("0%");
  });

  test("tiny 0.2% credit bucket shows rounded 0% but keeps faithful scale bar (0.002, not forced min 4%)", () => {
    const q = quota({
      creditBuckets: [
        { kind: "addOnQuota", used: 2, limit: 1000, remaining: 998, percent: 0.2 },
      ],
    });

    const stackedZh = renderWithLocale(<QuotaBars quota={q} threshold={80} t={((k, v) => interpolate(zh[k], v)) as TFn} layout="stacked" />, "zh");
    expect(stackedZh).toContain("已用 0%");
    expect(stackedZh).not.toContain("&lt;1%");
    expect(stackedZh).toContain("--bar-scale:0.002");
    expect(stackedZh).not.toContain("--bar-scale:0.04");

    const stackedEn = renderWithLocale(<QuotaBars quota={q} threshold={80} t={((k, v) => interpolate(en[k], v)) as TFn} layout="stacked" />, "en");
    expect(stackedEn).toContain("0% used");
    expect(stackedEn).not.toContain("&lt;1%");
    expect(stackedEn).toContain("--bar-scale:0.002");

    const compactZh = renderWithLocale(<QuotaBars quota={q} threshold={80} t={((k, v) => interpolate(zh[k], v)) as TFn} layout="compact" />, "zh");
    expect(compactZh).toContain("0%");
    expect(compactZh).not.toContain("&lt;1%");
    expect(compactZh).toContain("--bar-scale:0.002");
  });

  test("regular quotas below 1% also show 0%, retaining their existing minimum bar width", () => {
    const q = quota({ fiveHourPercent: 0.8 });
    const t = ((k, v) => interpolate(en[k], v)) as TFn;
    const stacked = renderWithLocale(<QuotaBars quota={q} threshold={80} t={t} layout="stacked" />);
    const compact = renderWithLocale(<QuotaBars quota={q} threshold={80} t={t} layout="compact" />);
    expect(stacked).toContain("0% used");
    expect(compact).toContain("0%");
    expect(stacked).toContain("--bar-scale:0.04");
    expect(compact).toContain("--bar-scale:0.04");
    expect(stacked).not.toContain("&lt;1%");
    expect(compact).not.toContain("&lt;1%");
  });

  test("normal non-zero percent (50%) renders standard percentage and scale", () => {
    const q = quota({
      creditBuckets: [
        { kind: "userQuota", used: 500, limit: 1000, remaining: 500, percent: 50 },
      ],
    });

    const stackedZh = renderWithLocale(<QuotaBars quota={q} threshold={80} t={((k, v) => interpolate(zh[k], v)) as TFn} layout="stacked" />, "zh");
    expect(stackedZh).toContain("已用 50%");
    expect(stackedZh).toContain("--bar-scale:0.5");

    const stackedEn = renderWithLocale(<QuotaBars quota={q} threshold={80} t={((k, v) => interpolate(en[k], v)) as TFn} layout="stacked" />, "en");
    expect(stackedEn).toContain("50% used");
    expect(stackedEn).toContain("--bar-scale:0.5");

    const compactZh = renderWithLocale(<QuotaBars quota={q} threshold={80} t={((k, v) => interpolate(zh[k], v)) as TFn} layout="compact" />, "zh");
    expect(compactZh).toContain("50%");
  });

  test("missing percent fallback renders 'used / limit' without bar or invented percentage", () => {
    const q = quota({
      creditBuckets: [
        { kind: "addOnQuota", used: 250, limit: 1000, remaining: 750 },
      ],
    });

    const stackedZh = renderWithLocale(<QuotaBars quota={q} threshold={80} t={((k, v) => interpolate(zh[k], v)) as TFn} layout="stacked" />, "zh");
    expect(stackedZh).toContain("250 / 1,000");
    expect(stackedZh).not.toContain("bar-fill");
    expect(stackedZh).not.toContain("%");

    const compactZh = renderWithLocale(<QuotaBars quota={q} threshold={80} t={((k, v) => interpolate(zh[k], v)) as TFn} layout="compact" />, "zh");
    expect(compactZh).toContain("250 / 1,000");
    expect(compactZh).not.toContain("bar-fill");
    expect(compactZh).not.toContain("%");
  });

  test("regular rate-limit row (1%) retains existing 4% min-width floor and normal text", () => {
    const q = quota({
      fiveHourPercent: 1,
    });

    const stackedZh = renderWithLocale(<QuotaBars quota={q} threshold={80} t={((k, v) => interpolate(zh[k], v)) as TFn} layout="stacked" />, "zh");
    expect(stackedZh).toContain("已用 1%");
    expect(stackedZh).toContain("--bar-scale:0.04"); // 4% floor preserved for regular quota!

    const stackedEn = renderWithLocale(<QuotaBars quota={q} threshold={80} t={((k, v) => interpolate(en[k], v)) as TFn} layout="stacked" />, "en");
    expect(stackedEn).toContain("1% used");
    expect(stackedEn).toContain("--bar-scale:0.04");

    const compactZh = renderWithLocale(<QuotaBars quota={q} threshold={80} t={((k, v) => interpolate(zh[k], v)) as TFn} layout="compact" />, "zh");
    expect(compactZh).toContain("1%");
    expect(compactZh).toContain("--bar-scale:0.04");
  });
});
