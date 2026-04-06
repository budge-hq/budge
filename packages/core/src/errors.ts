import type { Trace } from "./types.ts";

export class SourceResolutionError extends Error {
  readonly sourceId: string;
  readonly cause: unknown;
  trace?: Trace;

  constructor(sourceId: string, windowId: string, cause: unknown) {
    super(
      `Source "${sourceId}" threw during resolution in context window "${windowId}": ${String(cause)}`,
    );
    this.name = "SourceResolutionError";
    this.sourceId = sourceId;
    this.cause = cause;
  }
}

export class RequiredSourceValueError extends Error {
  readonly sourceId: string;
  trace?: Trace;

  constructor(sourceId: string, windowId: string) {
    super(
      `Source "${sourceId}" resolved to null or undefined in context window "${windowId}". ` +
        "Use a nullable source shape or wait for optional() if this value is not required.",
    );
    this.name = "RequiredSourceValueError";
    this.sourceId = sourceId;
  }
}

export class BudgetExceededError extends Error {
  readonly windowId: string;
  readonly maxTokens: number;
  readonly actualTokens: number;
  trace?: Trace;

  constructor(windowId: string, maxTokens: number, actualTokens: number) {
    super(
      `Context window "${windowId}" exceeded its max token budget (${actualTokens} > ${maxTokens}).`,
    );
    this.name = "BudgetExceededError";
    this.windowId = windowId;
    this.maxTokens = maxTokens;
    this.actualTokens = actualTokens;
  }
}
