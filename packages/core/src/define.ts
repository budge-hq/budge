import type { AnyInput, ComposeFn, Definition, InputSchema } from "./types.ts";

export function createDefinition<
  TResolveInput extends AnyInput,
  TInput extends AnyInput,
  TSchema extends InputSchema<TResolveInput, TInput>,
>(
  input: TSchema,
  config: {
    id: string;
    maxTokens: number;
    compose: ComposeFn<TInput>;
  },
): Definition<TInput, TResolveInput> {
  return {
    _id: config.id,
    _inputSchema: input,
    _maxTokens: config.maxTokens,
    _compose: config.compose,
  };
}
