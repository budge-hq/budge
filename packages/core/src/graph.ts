import { DepGraph, DepGraphCycleError } from "dependency-graph";
import {
  CircularSourceDependencyError,
  MissingSourceDependencyError,
  SourceResolutionError,
} from "./errors.ts";
import type {
  AnyInput,
  AnySource,
  ExecutionPlan,
  InputSource,
  ResolverSource,
  SourceDependencyRef,
} from "./types.ts";
import type { SourceTiming } from "./trace.ts";

function isInputSource(source: unknown): source is InputSource<string> {
  return (
    typeof source === "object" &&
    source !== null &&
    "_type" in source &&
    (source as { _type?: unknown })._type === "input"
  );
}

function isResolverSource(source: unknown): source is ResolverSource<unknown> {
  return (
    typeof source === "object" &&
    source !== null &&
    "resolve" in source &&
    typeof (source as { resolve?: unknown }).resolve === "function"
  );
}

function isValidSource(source: unknown): source is AnySource {
  return isInputSource(source) || isResolverSource(source);
}

function getSourceTags(source: AnySource): string[] {
  return isInputSource(source) ? source._tags : (source.tags ?? []);
}

function getDependencyRefs(
  key: string,
  source: AnySource,
  sourceKeysById: Map<string, string>,
  ownerLabel: string,
): SourceDependencyRef[] {
  if (!isResolverSource(source)) {
    return [];
  }

  return Object.entries(source._dependencySources).map(([alias, dependencySource]) => {
    const dependencyId = dependencySource._internalId;
    const dependencyKey = sourceKeysById.get(dependencyId);

    if (!dependencyKey) {
      throw new MissingSourceDependencyError(key, alias, ownerLabel);
    }

    return {
      alias,
      sourceId: dependencyId,
      sourceKey: dependencyKey,
    };
  });
}

function indexSourceKeysById<TSourceMap extends Record<string, unknown>>(
  sourceMap: TSourceMap,
  ownerLabel: string,
): Map<string, string> {
  const sourceKeysById = new Map<string, string>();

  for (const [key, source] of Object.entries(sourceMap)) {
    if (!isValidSource(source)) {
      throw new TypeError(`Invalid source definition for "${key}" in ${ownerLabel}.`);
    }

    const existingKey = sourceKeysById.get(source._internalId);
    if (existingKey && existingKey !== key) {
      throw new Error(
        `Source handle selected multiple times in ${ownerLabel}: "${existingKey}" and "${key}".`,
      );
    }

    sourceKeysById.set(source._internalId, key);
  }

  return sourceKeysById;
}

function buildDependencyGraph<TSourceMap extends Record<string, unknown>>(
  sourceMap: TSourceMap,
  dependenciesBySourceKey: Map<string, SourceDependencyRef[]>,
): DepGraph<string> {
  const graph = new DepGraph<string>();

  for (const key of Object.keys(sourceMap)) {
    graph.addNode(key);
  }

  for (const [key, dependencies] of dependenciesBySourceKey) {
    for (const dependency of dependencies) {
      graph.addDependency(key, dependency.sourceKey);
    }
  }

  return graph;
}

function computeWaveLevels(graph: DepGraph<string>): ExecutionPlan["waves"] {
  const order = graph.overallOrder();
  const levels = new Map<string, number>();

  for (const key of order) {
    const directDependencies = graph.directDependenciesOf(key);
    const level = directDependencies.length
      ? Math.max(...directDependencies.map((dependency) => levels.get(dependency) ?? 0)) + 1
      : 0;
    levels.set(key, level);
  }

  const wavesByLevel = new Map<number, string[]>();
  for (const key of order) {
    const level = levels.get(key) ?? 0;
    const existing = wavesByLevel.get(level);

    if (existing) {
      existing.push(key);
    } else {
      wavesByLevel.set(level, [key]);
    }
  }

  return [...wavesByLevel.entries()]
    .sort(([left], [right]) => left - right)
    .map(([, keys]) => ({ keys }));
}

export function buildExecutionPlan<TSourceMap extends Record<string, unknown>>(
  sourceMap: TSourceMap,
  ownerLabel = "source map",
): ExecutionPlan {
  const sourceKeysById = indexSourceKeysById(sourceMap, ownerLabel);
  const dependenciesBySourceKey = new Map<string, SourceDependencyRef[]>();

  for (const key of Object.keys(sourceMap)) {
    const source = sourceMap[key];
    if (!isValidSource(source)) {
      throw new TypeError(`Invalid source definition for "${key}" in ${ownerLabel}.`);
    }

    dependenciesBySourceKey.set(key, getDependencyRefs(key, source, sourceKeysById, ownerLabel));
  }

  try {
    return {
      waves: computeWaveLevels(buildDependencyGraph(sourceMap, dependenciesBySourceKey)),
      dependenciesBySourceKey,
    };
  } catch (error) {
    if (error instanceof DepGraphCycleError) {
      throw new CircularSourceDependencyError(error.cyclePath, ownerLabel);
    }

    throw error;
  }
}

export async function executeWaves<TSourceMap extends Record<string, unknown>>(
  sourceMap: TSourceMap,
  input: AnyInput,
  plan: ExecutionPlan,
  windowId: string,
  onTiming: (timing: SourceTiming) => void,
): Promise<Map<string, unknown>> {
  const resolved = new Map<string, unknown>();

  for (const wave of plan.waves) {
    const results = await Promise.allSettled(
      wave.keys.map(async (key) => {
        const source = sourceMap[key];
        if (!isValidSource(source)) {
          throw new TypeError(
            `Invalid source definition for "${key}" in context window "${windowId}".`,
          );
        }

        const startedAt = Date.now();
        const dependsOn = (plan.dependenciesBySourceKey.get(key) ?? []).map(
          (dependency) => dependency.sourceKey,
        );

        try {
          const value = isInputSource(source)
            ? input[source._key]
            : await source.resolve(
                input,
                Object.fromEntries(
                  (plan.dependenciesBySourceKey.get(key) ?? []).map((dependency) => [
                    dependency.alias,
                    resolved.get(dependency.sourceKey),
                  ]),
                ),
              );

          const completedAt = new Date();
          const durationMs = Date.now() - startedAt;

          resolved.set(key, value);
          onTiming({
            key,
            sourceId: source._internalId,
            kind: source._sourceKind,
            tags: getSourceTags(source),
            dependsOn,
            completedAt,
            durationMs,
            status: "resolved",
            ...(Array.isArray(value) && source._sourceKind === "rag"
              ? { itemCount: value.length }
              : {}),
          });

          return value;
        } catch (error) {
          onTiming({
            key,
            sourceId: source._internalId,
            kind: source._sourceKind,
            tags: getSourceTags(source),
            dependsOn,
            completedAt: new Date(),
            durationMs: Date.now() - startedAt,
            status: "failed",
          });

          throw new SourceResolutionError(key, windowId, error);
        }
      }),
    );

    const failures = results.filter(
      (result): result is PromiseRejectedResult => result.status === "rejected",
    );
    if (failures.length === 1) {
      throw failures[0].reason;
    }
    if (failures.length > 1) {
      throw new AggregateError(
        failures.map((failure) => failure.reason),
        `Multiple sources failed while resolving a wave in context window "${windowId}".`,
      );
    }
  }

  return resolved;
}
