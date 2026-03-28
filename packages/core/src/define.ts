import type { AnyInput, Definition, DefinitionConfig, InferSources, InputSchema } from "./types.ts";
import { buildWaves } from "./graph.ts";

export function createDefinition<
  TInput extends AnyInput,
  const TSourceMap extends Record<string, unknown>,
  TDerived extends Record<string, unknown> = Record<string, never>,
  const TRequired extends readonly Extract<keyof InferSources<TInput, TSourceMap>, string>[] = [],
  const TPrefer extends readonly Extract<keyof InferSources<TInput, TSourceMap>, string>[] = [],
  TResolveInput extends AnyInput = TInput,
>(
  input: InputSchema<TResolveInput, TInput>,
  config: DefinitionConfig<TInput, TSourceMap, TDerived, TRequired, TPrefer>,
): Definition<TInput, TSourceMap, TDerived, TRequired, TPrefer, TResolveInput> {
  buildWaves(config.sources, `task "${config.id}"`);

  return {
    _id: config.id,
    _inputSchema: input,
    _sources: config.sources,
    _derive: config.derive,
    _policies: config.policies ?? {},
    _template: config.template,
  };
}
