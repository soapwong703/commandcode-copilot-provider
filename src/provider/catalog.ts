import type { CancellationToken, Memento } from "vscode";
import { CommandCodeClient } from "../client";
import { getBaseUrl } from "../config";
import { FAMILY, TOOLS_LIMIT } from "../consts";
import { logger } from "../logger";
import type {
  ApiModelInfo,
  ModelDefinition,
  ModelPricing,
  ThinkingCapability,
} from "../types";
import {
  fetchModelDocs,
  fetchModelPricing,
  normalizeName,
  type ModelDocsInfo,
} from "./docsCatalog";

const CATALOG_STATE_VERSION = "v3";
const CATALOG_STATE_KEY_PREFIX = "commandcode-copilot.liveCatalog";
const CATALOG_TTL_MS = 24 * 60 * 60 * 1000;
const MIN_DEFAULT_OUTPUT_TOKENS = 4096;
const MAX_DEFAULT_OUTPUT_TOKENS = 131072;
const DEFAULT_THINKING: ThinkingCapability = {
  supportedEfforts: ["low", "medium", "high"] as const,
  defaultEffort: "medium",
  canDisable: true,
};
const NO_THINKING = false;

export interface LiveModelInfo {
  readonly name: string;
  readonly contextLength: number;
  readonly supportedEndpoints: readonly string[];
  readonly docs?: ModelDocsInfo;
  readonly pricing?: ModelPricing;
}

interface Snapshot {
  fetchedAt: number;
  models: Record<string, LiveModelInfo>;
}

let sessionCache: { key: string; snapshot: Snapshot } | undefined;

function stateKey(): string {
  return `${CATALOG_STATE_KEY_PREFIX}:${CATALOG_STATE_VERSION}:${getBaseUrl()}`;
}

function readPersisted(globalState: Memento): Snapshot | undefined {
  const raw = globalState.get<Snapshot>(stateKey());
  if (
    !raw ||
    typeof raw.fetchedAt !== "number" ||
    !raw.models ||
    typeof raw.models !== "object"
  )
    return undefined;
  const models: Record<string, LiveModelInfo> = {};
  for (const [id, info] of Object.entries(raw.models)) {
    if (
      id &&
      info &&
      typeof info.contextLength === "number" &&
      info.contextLength > 0
    ) {
      models[id] = {
        name: typeof info.name === "string" && info.name ? info.name : id,
        contextLength: info.contextLength,
        supportedEndpoints: Array.isArray(info.supportedEndpoints)
          ? info.supportedEndpoints
          : [],
        ...(info.docs ? { docs: info.docs } : {}),
        ...(info.pricing ? { pricing: info.pricing } : {}),
      };
    }
  }
  return Object.keys(models).length
    ? { fetchedAt: raw.fetchedAt, models }
    : undefined;
}

async function persist(
  globalState: Memento,
  snapshot: Snapshot,
): Promise<void> {
  try {
    await globalState.update(stateKey(), snapshot);
  } catch (error) {
    logger.warn("Failed to persist live model catalog", error);
  }
}

export function defaultOutputTokensForContext(contextLength: number): number {
  return Math.max(
    MIN_DEFAULT_OUTPUT_TOKENS,
    Math.min(MAX_DEFAULT_OUTPUT_TOKENS, Math.round(contextLength / 8)),
  );
}

export function isFreeModelId(id: string): boolean {
  return /[-:]free$/i.test(id);
}

export function normalizeModelId(id: string): string {
  return id.replace(/-\d{8}$/u, "").toLowerCase();
}

function docsFor(
  id: string,
  docs: ReadonlyMap<string, ModelDocsInfo>,
): ModelDocsInfo | undefined {
  return docs.get(id) ?? docs.get(normalizeModelId(id));
}

function pricingFor(
  id: string,
  pricing: ReadonlyMap<string, ModelPricing>,
): ModelPricing | undefined {
  const normalized = normalizeModelId(id);
  const baseId = normalized.slice(normalized.lastIndexOf("/") + 1);
  return (
    pricing.get(id.toLowerCase()) ??
    pricing.get(normalized) ??
    pricing.get(baseId)
  );
}

function docsForModel(
  id: string,
  name: string,
  modelDocs: ReadonlyMap<string, ModelDocsInfo> | undefined,
  pricingDocs: ReadonlyMap<string, ModelDocsInfo> | undefined,
  pricingDocsByName: ReadonlyMap<string, ModelDocsInfo> | undefined,
): ModelDocsInfo | undefined {
  return (
    (modelDocs ? docsFor(id, modelDocs) : undefined) ??
    (pricingDocs ? docsFor(id, pricingDocs) : undefined) ??
    pricingDocsByName?.get(normalizeName(name))
  );
}

function createModelDefinition(
  id: string,
  info: LiveModelInfo,
): ModelDefinition {
  const maxOutputTokens = defaultOutputTokensForContext(info.contextLength);
  const doc = info.docs;
  const suffix = [
    !doc ? "unverified" : "",
    isFreeModelId(id) && !/\bfree\b/i.test(info.name) ? "free" : "",
  ]
    .filter(Boolean)
    .join(", ");
  const name = suffix ? `${info.name} (${suffix})` : info.name;
  return {
    id,
    name,
    family: FAMILY,
    version: id.slice(id.lastIndexOf("/") + 1) || id,
    detail: doc?.detail ?? "",
    maxInputTokens: Math.max(1, info.contextLength - maxOutputTokens),
    maxOutputTokens,
    capabilities: {
      toolCalling: TOOLS_LIMIT,
      imageInput: doc?.imageInput ?? false,
      thinking: doc?.thinking ? DEFAULT_THINKING : NO_THINKING,
    },
    pricing: info.pricing,
    fetched: !doc,
  };
}

async function fetchApiModels(
  token?: CancellationToken,
): Promise<ApiModelInfo[] | undefined> {
  try {
    const client = new CommandCodeClient(getBaseUrl(), "", { auth: false });
    const response = await client.listModels(token);
    const data = response.data?.filter(
      (model) =>
        model?.id &&
        typeof model.context_length === "number" &&
        model.context_length > 0,
    );
    return data?.length ? data : undefined;
  } catch (error) {
    logger.warn("Command Code model API sync failed", error);
    return undefined;
  }
}

async function fetchSnapshot(
  token: CancellationToken | undefined,
  fallback?: Snapshot,
): Promise<Snapshot | undefined> {
  const [apiModels, modelDocs, pricingCatalog] = await Promise.all([
    fetchApiModels(token),
    fetchModelDocs(),
    fetchModelPricing(),
  ]);
  if (!apiModels) return undefined;
  const pricing = pricingCatalog?.pricing;

  const models: Record<string, LiveModelInfo> = {};
  let docsMatches = 0;
  const unmatched: string[] = [];
  for (const model of apiModels) {
    const id = model.id;
    const previous = fallback?.models[id];
    const doc =
      docsForModel(
        id,
        model.name ?? id,
        modelDocs,
        pricingCatalog?.docs,
        pricingCatalog?.docsByName,
      ) ?? previous?.docs;
    if (doc) docsMatches++;
    else unmatched.push(id);
    const price =
      (pricing ? pricingFor(id, pricing) : undefined) ??
      pricingCatalog?.pricingByName.get(normalizeName(model.name ?? id)) ??
      previous?.pricing;
    models[id] = {
      name: typeof model.name === "string" && model.name ? model.name : id,
      contextLength: model.context_length!,
      supportedEndpoints: model.supported_endpoints ?? [],
      ...(doc ? { docs: doc } : {}),
      ...(price ? { pricing: price } : {}),
    };
  }
  logger.info(
    `Catalog sync: api=${apiModels.length} docs=${modelDocs?.size ?? 0} pricing=${pricing?.size ?? 0} capabilityMatches=${docsMatches} unmatched=[${unmatched.join(", ")}]`,
  );
  return { fetchedAt: Date.now(), models };
}

export async function getLiveCatalog(
  globalState: Memento,
  token?: CancellationToken,
  forceRefresh = false,
  onRefresh?: (success: boolean, count: number) => void,
): Promise<ReadonlyMap<string, LiveModelInfo>> {
  const key = stateKey();
  const cached =
    sessionCache?.key === key
      ? sessionCache.snapshot
      : readPersisted(globalState);
  if (
    !forceRefresh &&
    cached &&
    Date.now() - cached.fetchedAt < CATALOG_TTL_MS
  ) {
    sessionCache = { key, snapshot: cached };
    return new Map(Object.entries(cached.models));
  }

  const fetched = await fetchSnapshot(token, cached);
  if (fetched && !token?.isCancellationRequested) {
    sessionCache = { key, snapshot: fetched };
    await persist(globalState, fetched);
    const models = new Map(Object.entries(fetched.models));
    onRefresh?.(true, models.size);
    return models;
  }
  if (forceRefresh)
    onRefresh?.(false, cached ? Object.keys(cached.models).length : 0);
  if (cached) {
    sessionCache = { key, snapshot: cached };
    return new Map(Object.entries(cached.models));
  }
  return new Map();
}

export function liveModelToDefinition(
  id: string,
  info: LiveModelInfo,
): ModelDefinition {
  return createModelDefinition(id, info);
}
