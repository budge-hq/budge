import { executeWaves } from "./graph.ts";
import { buildTrace } from "./trace.ts";
import type { SourceTiming } from "./trace.ts";
import type { AnyInput, AnySource, InferSources, ResolveResult, WindowSpec } from "./types.ts";

async function validateInput<TResolveInput extends AnyInput, TInput extends AnyInput>(
  schema: WindowSpec<TInput, TResolveInput>["_inputSchema"],
  input: TResolveInput,
  windowId: string,
): Promise<TInput> {
  const result = await schema["~standard"].validate(input);
  if (result.issues !== undefined) {
    const details = result.issues.map((issue) => issue.message).join("; ");
    throw new Error(`Input validation failed for context window "${windowId}": ${details}`);
  }

  return result.value;
}

function attachTraces(error: unknown, traces: ResolveResult["traces"]): void {
  if (typeof error === "object" && error !== null) {
    (error as { traces?: ResolveResult["traces"] }).traces = traces;
  }
}

export async function resolveWindowSpec<
  TInput extends AnyInput,
  TResolveInput extends AnyInput = TInput,
  TSourceMap extends Record<string, AnySource> = Record<string, AnySource>,
>(
  windowSpec: WindowSpec<TInput, TResolveInput, TSourceMap>,
  payload: { input: TResolveInput },
): Promise<ResolveResult<InferSources<TInput, TSourceMap>>> {
  const startedAt = new Date();
  const sourceTimings: SourceTiming[] = [];

  try {
    const normalizedInput = await validateInput(
      windowSpec._inputSchema,
      payload.input,
      windowSpec._id,
    );
    const resolved = await executeWaves(
      windowSpec._sources,
      normalizedInput,
      windowSpec._plan,
      windowSpec._id,
      (timing) => {
        sourceTimings.push(timing);
      },
    );
    const completedAt = new Date();

    return {
      context: Object.fromEntries(resolved) as InferSources<TInput, TSourceMap>,
      traces: buildTrace({
        windowId: windowSpec._id,
        startedAt,
        completedAt,
        sourceTimings,
      }),
    };
  } catch (error) {
    const trace = buildTrace({
      windowId: windowSpec._id,
      startedAt,
      completedAt: new Date(),
      sourceTimings,
    });
    attachTraces(error, trace);
    throw error;
  }
}
