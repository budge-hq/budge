export class RequiredSourceMissingError extends Error {
  readonly sourceKey: string;

  constructor(sourceKey: string, taskId: string) {
    super(
      `Required source "${sourceKey}" resolved to null or undefined in task "${taskId}". ` +
        `Mark it as "prefer" if it is optional, or ensure the source always resolves.`,
    );
    this.name = "RequiredSourceMissingError";
    this.sourceKey = sourceKey;
  }
}

export class MissingSourceDependencyError extends Error {
  readonly sourceKey: string;
  readonly dependencyKey: string;

  constructor(sourceKey: string, dependencyKey: string, ownerLabel: string) {
    super(
      `Source "${sourceKey}" requires source "${dependencyKey}", but it is missing from ${ownerLabel}.`,
    );
    this.name = "MissingSourceDependencyError";
    this.sourceKey = sourceKey;
    this.dependencyKey = dependencyKey;
  }
}

export class CircularSourceDependencyError extends Error {
  readonly sourceKeys: string[];

  constructor(sourceKeys: string[], ownerLabel: string) {
    super(`Circular source dependencies detected in ${ownerLabel}: ${sourceKeys.join(", ")}.`);
    this.name = "CircularSourceDependencyError";
    this.sourceKeys = sourceKeys;
  }
}

export class SourceResolutionError extends Error {
  readonly sourceKey: string;
  readonly cause: unknown;

  constructor(sourceKey: string, taskId: string, cause: unknown) {
    super(`Source "${sourceKey}" threw during resolution in task "${taskId}": ${String(cause)}`);
    this.name = "SourceResolutionError";
    this.sourceKey = sourceKey;
    this.cause = cause;
  }
}
