import type {
  AnyInput,
  AnySource,
  InferSchemaInputObject,
  InferSchemaOutputObject,
  InputSchema,
  WindowSpec,
} from "./types.ts";
import { buildExecutionPlan } from "./graph.ts";

export function createWindowSpec<
  TSchema extends InputSchema<AnyInput, AnyInput>,
  const TSourceMap extends Record<string, AnySource>,
>(
  input: TSchema,
  config: {
    id: string;
    sources: TSourceMap;
  },
): WindowSpec<InferSchemaOutputObject<TSchema>, InferSchemaInputObject<TSchema>, TSourceMap> {
  return {
    _id: config.id,
    _inputSchema: input as unknown as InputSchema<
      InferSchemaInputObject<TSchema>,
      InferSchemaOutputObject<TSchema>
    >,
    _sources: config.sources,
    _plan: buildExecutionPlan(config.sources, `context window "${config.id}"`),
  };
}
