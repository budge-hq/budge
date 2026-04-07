import type { Trace } from "./types.ts";

export class SourceResolutionError extends Error {
  readonly sourceKey: string;
  declare readonly cause: unknown;
  traces?: Trace;

  constructor(sourceKey: string, windowId: string, cause: unknown) {
    super(
      `Source "${sourceKey}" threw during resolution in context window "${windowId}": ${String(cause)}`,
      { cause },
    );
    this.name = "SourceResolutionError";
    this.sourceKey = sourceKey;
  }
}

export class MissingSourceDependencyError extends Error {
  readonly sourceKey: string;
  readonly dependencyKey: string;

  constructor(sourceKey: string, dependencyKey: string, ownerLabel: string) {
    super(
      `Source "${sourceKey}" depends on "${dependencyKey}", but it is not selected in ${ownerLabel}.`,
    );
    this.name = "MissingSourceDependencyError";
    this.sourceKey = sourceKey;
    this.dependencyKey = dependencyKey;
  }
}

export class CircularSourceDependencyError extends Error {
  readonly sourceKeys: string[];

  constructor(sourceKeys: string[], ownerLabel: string) {
    super(`Circular source dependency detected in ${ownerLabel}: ${sourceKeys.join(", ")}.`);
    this.name = "CircularSourceDependencyError";
    this.sourceKeys = sourceKeys;
  }
}
