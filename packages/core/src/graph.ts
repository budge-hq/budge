import type { AnyInput, AnyResolverSource, InputSource } from "./types.ts";
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

function hydrateSelectedSourceMetadata<TSourceMap extends Record<string, unknown>>(
  sourceMap: TSourceMap,
  ownerLabel: string,
): void {
  const selectedKeysByInternalId = new Map<string, string>();

  for (const [selectedKey, source] of Object.entries(sourceMap)) {
    if (!isResolverSource(source)) {
      continue;
    }

    if (!source._internalId) {
      throw new Error(`Source "${selectedKey}" is missing an internal id in ${ownerLabel}.`);
    }

    selectedKeysByInternalId.set(source._internalId, selectedKey);
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

      const expectedDependencyKey =
        dependencySource._registeredId ?? selectedKeysByInternalId.get(dependencyId);

      if (expectedDependencyKey && alias !== expectedDependencyKey) {
        throw new Error(
          `Dependency aliases are not supported yet. Source "${selectedKey}" must reference dependency "${expectedDependencyKey}" under its own key.`,
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

  const keys = Object.keys(sourceMap);
  const deps = new Map<string, Set<string>>();

  for (const key of keys) {
    deps.set(
      key,
      new Set(
        getDependencyIds(sourceMap[key]).map(
          (dependencyId) => validatedSourceKeysById.get(dependencyId)!,
        ),
      ),
    );
  }

  const waves: Wave[] = [];
  const resolved = new Set<string>();

  while (resolved.size < keys.length) {
    const wave: string[] = [];

    for (const key of keys) {
      if (resolved.has(key)) continue;
      const keyDeps = deps.get(key) ?? new Set();
      const allResolved = [...keyDeps].every((dep) => resolved.has(dep));
      if (allResolved) {
        wave.push(key);
      }
    }

    if (wave.length === 0) {
      const unresolved = keys.filter((key) => !resolved.has(key));
      throw new CircularSourceDependencyError(unresolved, ownerLabel);
    }

    waves.push({ keys: wave });
    for (const key of wave) {
      resolved.add(key);
    }
  }

  return waves;
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
  taskId: string,
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
                resolved.get(sourceKeysById.get(dependency.internalId)!),
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
          throw new SourceResolutionError(key, taskId, error);
        }
      }),
    );
  }

  return resolved;
}
