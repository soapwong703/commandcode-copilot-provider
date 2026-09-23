import vscode from "vscode";
import { t } from "../i18n";
import type { ModelPricing, ModelRates } from "../types";
import { getPricingPeriod } from "./pricingSchedule";

/**
 * Model-picker pricing metadata.
 *
 * These fields are not in `@types/vscode` yet, but VS Code's extension host
 * forwards them from a chat provider (`extHostLanguageModels.ts`) so the model
 * picker can render a pricing table, a price-category tag, and info banners.
 *
 * Costs must be numbers in credits per 1M tokens — the picker renders a
 * non-numeric value as "Unknown", so formatted currency strings are never sent.
 * Long-context costs are only emitted when the long-context tier is actually
 * surcharged, so single-tier models keep a compact table.
 */
export interface ModelPricingInformation {
  readonly infoText?: Readonly<Record<string, string>>;
  readonly priceCategory?: string;
  readonly inputCost?: number;
  readonly cacheCost?: number;
  readonly cacheWriteCost?: number;
  readonly outputCost?: number;
  readonly longContextInputCost?: number;
  readonly longContextCacheCost?: number;
  readonly longContextCacheWriteCost?: number;
  readonly longContextOutputCost?: number;
}

/** Credit thresholds per 1M output tokens, matching the picker's price buckets. */
const LOW_COST_MAX_OUTPUT = 1;
const MEDIUM_COST_MAX_OUTPUT = 5;
const HIGH_COST_MAX_OUTPUT = 15;

export function toModelPricingInfo(
  pricing: ModelPricing | undefined,
  now = new Date(),
): ModelPricingInformation {
  if (!pricing) {
    return {};
  }

  const [standard, longContext] = pricing.tiers;
  const infoText = formatPricingNotice(pricing, now);
  return {
    ...(standard
      ? {
          inputCost: standard.rates.input,
          outputCost: standard.rates.output,
          ...(standard.rates.cacheRead !== undefined
            ? { cacheCost: standard.rates.cacheRead }
            : {}),
          ...(standard.rates.cacheWrite !== undefined
            ? { cacheWriteCost: standard.rates.cacheWrite }
            : {}),
        }
      : {}),
    ...(longContext && isSurcharged(standard?.rates, longContext.rates)
      ? {
          longContextInputCost: longContext.rates.input,
          longContextOutputCost: longContext.rates.output,
          ...(longContext.rates.cacheRead !== undefined
            ? { longContextCacheCost: longContext.rates.cacheRead }
            : {}),
          ...(longContext.rates.cacheWrite !== undefined
            ? { longContextCacheWriteCost: longContext.rates.cacheWrite }
            : {}),
        }
      : {}),
    ...(standard
      ? { priceCategory: resolvePriceCategory(standard.rates.output) }
      : {}),
    ...(infoText ? { infoText: { pricing: infoText } } : {}),
  };
}

function isSurcharged(
  standard: ModelRates | undefined,
  longContext: ModelRates,
): boolean {
  if (!standard) {
    return false;
  }
  return (
    standard.input !== longContext.input ||
    standard.output !== longContext.output ||
    standard.cacheRead !== longContext.cacheRead ||
    standard.cacheWrite !== longContext.cacheWrite
  );
}

function resolvePriceCategory(outputCost: number): string {
  if (outputCost <= LOW_COST_MAX_OUTPUT) {
    return "low";
  }
  if (outputCost <= MEDIUM_COST_MAX_OUTPUT) {
    return "medium";
  }
  if (outputCost <= HIGH_COST_MAX_OUTPUT) {
    return "high";
  }
  return "very_high";
}

/**
 * Build the info banner shown in the picker hover: the active billing period
 * (plus when it changes) and the currently effective rates, or the active
 * discount when one applies. Returns `undefined` when neither is known, so the
 * banner is omitted rather than rendered empty.
 */
function formatPricingNotice(
  pricing: ModelPricing,
  now: Date,
): string | undefined {
  if (pricing.deal) {
    return formatDealNotice(pricing.deal);
  }
  if (!pricing.peak) {
    return undefined;
  }

  const period = getPricingPeriod(pricing.peak.windows, now);
  const rates =
    period?.period === "peak" ? pricing.peak.rates : pricing.tiers[0]?.rates;
  if (!rates) {
    return undefined;
  }

  const periodLabel = t(
    period?.period === "peak"
      ? "pricing.currentPeak"
      : "pricing.currentOffPeak",
  );
  const nextLabel = t(
    period?.period === "peak"
      ? "pricing.currentOffPeak"
      : "pricing.currentPeak",
  );
  const transition = period
    ? formatTransitionTime(now, period.nextTransitionAt)
    : undefined;
  const header = transition
    ? `**${periodLabel}** · ${t("pricing.periodStarts", nextLabel, transition)}`
    : `**${periodLabel}**`;
  return [header, formatRatesBlock(rates)].join("\n");
}

function formatDealNotice(deal: NonNullable<ModelPricing["deal"]>): string {
  const ends = deal.endsAt ? ` · ${deal.endsAt.slice(0, 10)}` : "";
  const header = `**${t("pricing.deal", deal.discountPercent)}${ends}**`;
  const rows = deal.listRates
    ? [header, formatRatesBlock(deal.rates, deal.listRates)].join("\n")
    : [header, formatRatesBlock(deal.rates)].join("\n");
  return rows;
}

function formatRatesBlock(rates: ModelRates, listRates?: ModelRates): string {
  const suffix = t("pricing.perMillion");
  const line = (label: string, value: number, list?: number): string => {
    const was =
      list !== undefined ? ` (${t("pricing.list", formatPrice(list))})` : "";
    return `${label}: ${formatPrice(value)}${suffix}${was}`;
  };
  const rows = [line(t("pricing.input"), rates.input, listRates?.input)];
  if (rates.cacheRead !== undefined) {
    rows.push(
      line(t("pricing.cacheRead"), rates.cacheRead, listRates?.cacheRead),
    );
  }
  if (rates.cacheWrite !== undefined && rates.cacheWrite > 0) {
    rows.push(
      line(t("pricing.cacheWrite"), rates.cacheWrite, listRates?.cacheWrite),
    );
  }
  rows.push(line(t("pricing.output"), rates.output, listRates?.output));
  // Fenced block so the picker's markdown renderer keeps one rate per line.
  return ["```bash", rows.join("\n"), "```"].join("\n");
}

function formatPrice(value: number): string {
  return `$${Number(value.toPrecision(4))}`;
}

/**
 * Pick the next peak/off-peak boundary in the user's local timezone, naming the
 * day only when it is not today.
 */
function formatTransitionTime(now: Date, nextTransitionAt: Date): string {
  const time = new Intl.DateTimeFormat(getPricingLocale(), {
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
  }).format(nextTransitionAt);
  const dayDifference =
    getLocalDayNumber(nextTransitionAt) - getLocalDayNumber(now);

  if (dayDifference === 0) {
    return t("pricing.transitionTime.today", time);
  }
  if (dayDifference === 1) {
    return t("pricing.transitionTime.tomorrow", time);
  }
  const weekday = new Intl.DateTimeFormat(getPricingLocale(), {
    weekday: "short",
  }).format(nextTransitionAt);
  return t("pricing.transitionTime.weekday", weekday, time);
}

function getLocalDayNumber(date: Date): number {
  return (
    Date.UTC(date.getFullYear(), date.getMonth(), date.getDate()) /
    (24 * 60 * 60 * 1000)
  );
}

function getPricingLocale(): "en-US" | "zh-CN" {
  return vscode.env.language.toLowerCase() === "zh-cn" ? "zh-CN" : "en-US";
}
