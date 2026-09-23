import type { ModelPricing, ModelRates } from "../types";

export const MODEL_DOCS_URL =
  "https://commandcode.ai/docs/reference/cli/models";
export const PRICING_DOCS_URL =
  "https://commandcode.ai/docs/resources/pricing-limits";

export interface ModelDocsInfo {
  readonly imageInput: boolean;
  readonly thinking: boolean;
  readonly detail: string;
}

interface RawRates {
  input?: number;
  output?: number;
  cacheRead?: number;
  cacheWrite?: number;
}

interface RawTier {
  label?: string;
  context?: string;
  rates?: RawRates;
  listRates?: RawRates | string;
}

interface RawPricingRow {
  id: string;
  name?: string;
  caps?: { text?: boolean; vision?: boolean; reasoning?: boolean };
  tiers?: RawTier[];
  tip?: string;
  deal?: {
    discountPercent?: number;
    expires?: string;
    endsWhen?: string;
    free?: boolean;
  };
  timeOfDay?: {
    peak?: RawRates;
    windows?: string;
    tip?: string;
  };
}

export interface PricingCatalog {
  readonly pricing: ReadonlyMap<string, ModelPricing>;
  readonly pricingByName: ReadonlyMap<string, ModelPricing>;
  readonly docs: ReadonlyMap<string, ModelDocsInfo>;
  readonly docsByName: ReadonlyMap<string, ModelDocsInfo>;
}

export async function fetchModelDocs(): Promise<
  ReadonlyMap<string, ModelDocsInfo> | undefined
> {
  try {
    const records = decodeRscRecords(await fetchText(MODEL_DOCS_URL));
    const root = records.get("a");
    if (!root) return undefined;
    const tree = resolveRsc(JSON.parse(root), records);
    const map = new Map<string, ModelDocsInfo>();
    for (const row of findElements(tree, "tr")) {
      const id = typeof row[2] === "string" ? row[2] : "";
      const cells = (row[3] as { children?: unknown[] } | undefined)?.children;
      if (!id || !Array.isArray(cells) || cells.length < 4) continue;
      const caps = findProps(cells[2], "caps") as
        | { vision?: boolean; reasoning?: boolean }
        | undefined;
      if (
        !caps ||
        typeof caps.vision !== "boolean" ||
        typeof caps.reasoning !== "boolean"
      )
        continue;
      map.set(normalizeDocId(id), {
        imageInput: caps.vision,
        thinking: caps.reasoning,
        detail: firstText(cells[3]),
      });
    }
    return map.size ? map : undefined;
  } catch {
    return undefined;
  }
}

export async function fetchModelPricing(): Promise<PricingCatalog | undefined> {
  try {
    const records = decodeRscRecords(await fetchText(PRICING_DOCS_URL));
    const stream = records.get("30");
    if (!stream) return undefined;
    const props = resolveRsc(JSON.parse(stream), records);
    const rows = findProps(props, "rows") as RawPricingRow[] | undefined;
    if (!rows?.length) return undefined;
    const pricing = new Map<string, ModelPricing>();
    const pricingByName = new Map<string, ModelPricing>();
    const docs = new Map<string, ModelDocsInfo>();
    const docsByName = new Map<string, ModelDocsInfo>();
    for (const row of rows) {
      const price = toModelPricing(row);
      if (row.id && price) {
        pricing.set(row.id.toLowerCase(), price);
        if (row.name) pricingByName.set(normalizeName(row.name), price);
      }
      if (
        row.id &&
        row.caps &&
        typeof row.caps.vision === "boolean" &&
        typeof row.caps.reasoning === "boolean"
      ) {
        const doc = {
          imageInput: row.caps.vision,
          thinking: row.caps.reasoning,
          detail: row.name ?? "",
        };
        docs.set(normalizeDocId(row.id), doc);
        if (row.name) docsByName.set(normalizeName(row.name), doc);
      }
    }
    return pricing.size
      ? { pricing, pricingByName, docs, docsByName }
      : undefined;
  } catch {
    return undefined;
  }
}

async function fetchText(url: string): Promise<string | undefined> {
  const response = await globalThis.fetch(url, {
    headers: { Accept: "text/html" },
  });
  return response.ok ? response.text() : undefined;
}

function decodeRscRecords(html: string | undefined): Map<string, string> {
  const records = new Map<string, string>();
  if (!html) return records;
  for (const match of html.matchAll(
    /self\.__next_f\.push\(\[1,"([\s\S]*?)"\]\)/g,
  )) {
    try {
      const decoded = JSON.parse(`"${match[1]}"`) as string;
      for (const record of decoded.split("\n")) {
        const separator = record.indexOf(":");
        if (separator > 0)
          records.set(record.slice(0, separator), record.slice(separator + 1));
      }
    } catch {
      // Ignore unrelated or malformed Next.js stream chunks.
    }
  }
  return records;
}

function resolveRsc(
  value: unknown,
  records: ReadonlyMap<string, string>,
  seen = new Set<string>(),
): unknown {
  if (typeof value === "string" && /^\$L[\da-f]+$/iu.test(value)) {
    const id = value.slice(2);
    if (seen.has(id)) return undefined;
    const raw = records.get(id);
    if (!raw) return undefined;
    try {
      const nextSeen = new Set(seen);
      nextSeen.add(id);
      return resolveRsc(JSON.parse(raw), records, nextSeen);
    } catch {
      return undefined;
    }
  }
  if (Array.isArray(value))
    return value.map((item) => resolveRsc(item, records, new Set(seen)));
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value).map(([key, item]) => [
        key,
        resolveRsc(item, records, new Set(seen)),
      ]),
    );
  }
  return value;
}

function findElements(value: unknown, type: string): unknown[][] {
  const found: unknown[][] = [];
  if (Array.isArray(value)) {
    if (value[0] === "$" && value[1] === type) found.push(value);
    for (const child of value) found.push(...findElements(child, type));
  } else if (value && typeof value === "object") {
    for (const child of Object.values(value))
      found.push(...findElements(child, type));
  }
  return found;
}

function findProps(value: unknown, property: string): unknown {
  if (Array.isArray(value)) {
    for (const child of value) {
      const result = findProps(child, property);
      if (result !== undefined) return result;
    }
  } else if (value && typeof value === "object") {
    const record = value as Record<string, unknown>;
    if (record[property] !== undefined) return record[property];
    for (const child of Object.values(record)) {
      const result = findProps(child, property);
      if (result !== undefined) return result;
    }
  }
  return undefined;
}

function firstText(value: unknown): string {
  if (typeof value === "string") return value;
  if (Array.isArray(value)) {
    if (value[0] === "$" && typeof value[1] === "string") {
      return firstText(
        (value[3] as { children?: unknown } | undefined)?.children,
      );
    }
    for (const child of value) {
      const text = firstText(child);
      if (text) return text;
    }
  } else if (value && typeof value === "object") {
    const record = value as Record<string, unknown>;
    if (typeof record.children === "string") return record.children;
    for (const child of Object.values(record)) {
      const text = firstText(child);
      if (text) return text;
    }
  }
  return "";
}

function normalizeDocId(id: string): string {
  return id.replace(/-\d{8}$/u, "").toLowerCase();
}

export function normalizeName(name: string): string {
  return name
    .replace(/\([^)]*\)/gu, "")
    .replace(/[^\p{L}\p{N}]+/gu, "")
    .toLowerCase();
}

function toModelPricing(row: RawPricingRow): ModelPricing | undefined {
  const tiers = (row.tiers ?? []).flatMap((tier, index) => {
    const raw = tier.rates;
    if (!raw || typeof raw.input !== "number" || typeof raw.output !== "number")
      return [];
    const rates: ModelRates = {
      input: raw.input,
      output: raw.output,
      ...(typeof raw.cacheRead === "number"
        ? { cacheRead: raw.cacheRead }
        : {}),
      ...(typeof raw.cacheWrite === "number"
        ? { cacheWrite: raw.cacheWrite }
        : {}),
    };
    const rawListRates =
      tier.listRates && typeof tier.listRates === "object"
        ? tier.listRates
        : undefined;
    const listRates =
      rawListRates &&
      typeof rawListRates.input === "number" &&
      typeof rawListRates.output === "number"
        ? {
            input: rawListRates.input,
            output: rawListRates.output,
            ...(typeof rawListRates.cacheRead === "number"
              ? { cacheRead: rawListRates.cacheRead }
              : {}),
            ...(typeof rawListRates.cacheWrite === "number"
              ? { cacheWrite: rawListRates.cacheWrite }
              : {}),
          }
        : undefined;
    return [
      {
        label: tier.label ?? (index === 0 ? "Standard" : "Long context"),
        context: tier.context ?? (index === 0 ? "Default" : "Long context"),
        rates,
        ...(listRates ? { listRates } : {}),
      },
    ];
  });
  if (!tiers.length) return undefined;
  const rawPeak = row.timeOfDay?.peak;
  const peak: ModelRates | undefined =
    rawPeak &&
    typeof rawPeak.input === "number" &&
    typeof rawPeak.output === "number"
      ? {
          input: rawPeak.input,
          output: rawPeak.output,
          ...(typeof rawPeak.cacheRead === "number"
            ? { cacheRead: rawPeak.cacheRead }
            : {}),
          ...(typeof rawPeak.cacheWrite === "number"
            ? { cacheWrite: rawPeak.cacheWrite }
            : {}),
        }
      : undefined;
  const windows = row.timeOfDay?.windows;
  const discount = row.deal?.discountPercent;
  const dealRates = row.deal?.free
    ? zeroRates()
    : discount !== undefined
      ? tiers[0].rates
      : undefined;
  return {
    tiers,
    ...(peak && windows ? { peak: { rates: peak, windows } } : {}),
    ...(row.deal && (row.deal.free || discount !== undefined)
      ? {
          deal: {
            discountPercent: row.deal.free ? 100 : discount!,
            endsAt: row.deal.expires,
            rates: dealRates ?? zeroRates(),
            ...(tiers[0].listRates ? { listRates: tiers[0].listRates } : {}),
          },
        }
      : {}),
  };
}

function zeroRates(): ModelRates {
  return { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 };
}
