import type { AnyInput, AnyResolverSource, InputSource } from "./types.ts";
import { DepGraph, DepGraphCycleError } from "dependency-graph";
import { isRagItems } from "./rag.ts";
import {
  CircularSourceDependencyError,
  MissingSourceDependencyError,
  SourceResolutionError,
} from "./errors.ts";

function isInputSource(source: unknown): source is InputSource<string> {
  return (
    typeof source === "object" &&
    source !== null &&
    "_type" in source &&
    (source as { _type?: unknown })._type === "input"
  );
}

function isResolverSource(source: unknown): source is AnyResolverSource {
  return (
    typeof source === "object" &&
    source !== null &&
    "resolve" in source &&
    typeof (source as { resolve?: unknown }).resolve === "function"
  );
}

function getDependencyIds(source: unknown): string[] {
  if (!isResolverSource(source)) {
    return [];
  }

  return source._dependencyRefs?.map((dependency) => dependency.internalId) ?? [];
}

function getDependencyRefs(source: unknown) {
  if (!isResolverSource(source)) {
    return [];
  }

  return [...(source._dependencyRefs ?? [])];
}

function materializeDependencyValue(value: unknown): unknown {
  return isRagItems(value) ? value.items : value;
}

function hydrateSelectedSourceMetadata<TSourceMap extends Record<string, unknown>>(
  sourceMap: TSourceMap,
  ownerLabel: string,
): void {
  for (const [selectedKey, source] of Object.entries(sourceMap)) {
    if (!isResolverSource(source)) {
      continue;
    }

    if (!source._internalId) {
      throw new Error(`Source "${selectedKey}" is missing an internal id in ${ownerLabel}.`);
    }
  }

  for (const [selectedKey, source] of Object.entries(sourceMap)) {
    if (!isResolverSource(source)) {
      continue;
    }

    const dependencySources = source._dependencySources ?? {};
    if (Object.keys(dependencySources).length === 0) {
      source._dependencyRefs = source._dependencyRefs ?? [];
      continue;
    }

    source._dependencyRefs = Object.entries(dependencySources).map(([alias, dependencySource]) => {
      const dependencyId = dependencySource._internalId;
      if (!dependencyId) {
        throw new Error(
          `Source "${selectedKey}" references an unresolved dependency in ${ownerLabel}.`,
        );
      }

      return {
        alias,
        internalId: dependencyId,
        registeredId: dependencySource._registeredId,
      };
    });
  }
}

function indexSelectedSourcesById<TSourceMap extends Record<string, unknown>>(
  sourceMap: TSourceMap,
  ownerLabel: string,
): Map<string, string> {
  hydrateSelectedSourceMetadata(sourceMap, ownerLabel);
  const sourceKeysById = new Map<string, string>();

  for (const [selectedKey, source] of Object.entries(sourceMap)) {
    if (!isResolverSource(source)) {
      continue;
    }

    const sourceId = source._internalId;
    if (!sourceId) {
      throw new Error(`Source "${selectedKey}" is missing an internal id in ${ownerLabel}.`);
    }

    const existingKey = sourceKeysById.get(sourceId);
    if (existingKey && existingKey !== selectedKey) {
      throw new Error(
        `Source "${sourceId}" is selected multiple times in ${ownerLabel}: "${existingKey}" and "${selectedKey}".`,
      );
    }

    sourceKeysById.set(sourceId, selectedKey);
  }

  return sourceKeysById;
}

export function validateSourceDependencies<TSourceMap extends Record<string, unknown>>(
  sourceMap: TSourceMap,
  ownerLabel: string,
): Map<string, string> {
  const sourceKeysById = indexSelectedSourcesById(sourceMap, ownerLabel);

  for (const [key, source] of Object.entries(sourceMap)) {
    if (!isResolverSource(source)) {
      continue;
    }

    for (const dependencyId of getDependencyIds(source)) {
      if (!sourceKeysById.has(dependencyId)) {
        const dependencyRef = getDependencyRefs(source).find(
          (candidate) => candidate.internalId === dependencyId,
        );
        throw new MissingSourceDependencyError(
          key,
          dependencyRef?.registeredId ?? dependencyRef?.alias ?? dependencyId,
          ownerLabel,
        );
      }
    }
  }

  return sourceKeysById;
}

interface Wave {
  keys: string[];
}

function buildDependencyGraph<TSourceMap extends Record<string, unknown>>(
  sourceMap: TSourceMap,
  sourceKeysById: Map<string, string>,
): DepGraph<string> {
  const graph = new DepGraph<string>();

  for (const key of Object.keys(sourceMap)) {
    graph.addNode(key);
  }

  for (const [key, source] of Object.entries(sourceMap)) {
    for (const dependencyId of getDependencyIds(source)) {
      graph.addDependency(key, sourceKeysById.get(dependencyId)!);
    }
  }

  return graph;
}

function computeWaveLevels(graph: DepGraph<string>): Wave[] {
  const order = graph.overallOrder();
  const levels = new Map<string, number>();

  for (const key of order) {
    const directDeps = graph.directDependenciesOf(key);
    const level = directDeps.length
      ? Math.max(...directDeps.map((dep) => levels.get(dep) ?? 0)) + 1
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

  return [...wavesByLevel.entries()].sort(([a], [b]) => a - b).map(([, keys]) => ({ keys }));
}

/**
 * Build an ordered list of execution waves from the source map.
 * Sources in the same wave can be resolved in parallel.
 */
export function buildWaves<TSourceMap extends Record<string, unknown>>(
  sourceMap: TSourceMap,
  ownerLabel = "source map",
  sourceKeysById?: Map<string, string>,
): Wave[] {
  const validatedSourceKeysById =
    sourceKeysById ?? validateSourceDependencies(sourceMap, ownerLabel);

  const graph = buildDependencyGraph(sourceMap, validatedSourceKeysById);

  try {
    return computeWaveLevels(graph);
  } catch (error) {
    if (error instanceof DepGraphCycleError) {
      throw new CircularSourceDependencyError(error.cyclePath, ownerLabel);
    }

    throw error;
  }
}

/**
 * Execute sources wave by wave.
 * Sources within a wave resolve in parallel.
 * Returns a map of key -> resolved value.
 */
export async function executeWaves<TSourceMap extends Record<string, unknown>>(
  sourceMap: TSourceMap,
  input: AnyInput,
  waves: Wave[],
  sourceKeysById: Map<string, string>,
  windowId: string,
  onResolved: (key: string, value: unknown, durationMs: number) => void,
): Promise<Map<string, unknown>> {
  const resolved = new Map<string, unknown>();

  for (const wave of waves) {
    await Promise.all(
      wave.keys.map(async (key) => {
        const source = sourceMap[key];
        const start = Date.now();

        try {
          let value: unknown;

          if (isInputSource(source)) {
            value = input[source._key];
          } else if (isResolverSource(source)) {
            const dependencyContext = Object.fromEntries(
              getDependencyRefs(source).map((dependency) => [
                dependency.alias,
                materializeDependencyValue(
                  resolved.get(sourceKeysById.get(dependency.internalId)!),
                ),
              ]),
            );
            value = await source.resolve(input, dependencyContext);
          } else {
            throw new TypeError(`Invalid source definition for "${key}".`);
          }

          const durationMs = Date.now() - start;
          resolved.set(key, value);
          onResolved(key, value, durationMs);
        } catch (error) {
          throw new SourceResolutionError(key, windowId, error);
        }
      }),
    );
  }

  return resolved;
}
