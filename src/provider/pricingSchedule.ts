/**
 * Peak/off-peak billing window resolution.
 *
 * Command Code publishes the peak windows as a display string such as
 * `01–04 & 06–10 UTC, Mon–Fri`. The strings are UTC-based, so the current
 * period and the next transition are computed in UTC while the transition
 * time itself is formatted in the user's local timezone for display.
 */

const HOUR_MS = 60 * 60 * 1000;
const DAY_MS = 24 * HOUR_MS;

export type PricingPeriod = "peak" | "offPeak";

export interface PricingPeriodSnapshot {
  readonly period: PricingPeriod;
  readonly nextTransitionAt: Date;
}

interface PeakWindows {
  readonly ranges: readonly { readonly start: number; readonly end: number }[];
  readonly weekdaysOnly: boolean;
}

/**
 * Parse a first-party window label into hourly ranges. Returns `undefined`
 * when the label has no usable ranges so callers can fall back to showing the
 * raw string instead of guessing.
 */
export function parsePeakWindows(windows: string): PeakWindows | undefined {
  const ranges = [...windows.matchAll(/(\d{1,2})\s*[–—-]\s*(\d{1,2})/g)]
    .map((match) => ({ start: Number(match[1]), end: Number(match[2]) }))
    .filter(
      (range) =>
        range.start >= 0 &&
        range.start < 24 &&
        range.end > range.start &&
        range.end <= 24,
    );
  if (!ranges.length) {
    return undefined;
  }
  return { ranges, weekdaysOnly: /mon/i.test(windows) && /fri/i.test(windows) };
}

export function getPricingPeriod(
  windows: string,
  now = new Date(),
): PricingPeriodSnapshot | undefined {
  const parsed = parsePeakWindows(windows);
  if (!parsed) {
    return undefined;
  }

  const hour = now.getUTCHours();
  const inPeak = parsed.ranges.some(
    (range) => hour >= range.start && hour < range.end,
  );
  const transitionHours = parsed.ranges.flatMap((range) => [
    range.start,
    range.end,
  ]);

  return {
    period: inPeak && isAllowedDay(now, parsed) ? "peak" : "offPeak",
    nextTransitionAt: findNextTransition(now, parsed, transitionHours),
  };
}

function isAllowedDay(now: Date, parsed: PeakWindows): boolean {
  if (!parsed.weekdaysOnly) {
    return true;
  }
  const day = now.getUTCDay();
  return day >= 1 && day <= 5;
}

/**
 * Scan forward up to a week so Friday evening and weekends resolve to the
 * following Monday rather than throwing.
 */
function findNextTransition(
  now: Date,
  parsed: PeakWindows,
  transitionHours: readonly number[],
): Date {
  const utcDayStart = Date.UTC(
    now.getUTCFullYear(),
    now.getUTCMonth(),
    now.getUTCDate(),
  );
  const nowMs = now.getTime();

  for (let dayOffset = 0; dayOffset <= 7; dayOffset += 1) {
    const dayStartMs = utcDayStart + dayOffset * DAY_MS;
    if (parsed.weekdaysOnly) {
      const day = new Date(dayStartMs).getUTCDay();
      if (day < 1 || day > 5) {
        continue;
      }
    }
    const next = transitionHours
      .map((hour) => dayStartMs + hour * HOUR_MS)
      .find((candidate) => candidate > nowMs);
    if (next !== undefined) {
      return new Date(next);
    }
  }

  // Unreachable for any window with at least one range; keep a non-throwing fallback.
  return new Date(nowMs + DAY_MS);
}
