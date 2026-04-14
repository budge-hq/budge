import { wrapLanguageModel } from "ai";
import type { LanguageModel, LanguageModelMiddleware } from "ai";

// ---------------------------------------------------------------------------
// Public export: wrap a model with prompt caching
// ---------------------------------------------------------------------------

/**
 * Wraps a language model with provider-agnostic prompt-caching markers.
 *
 * Attaches cache markers in multiple provider namespaces simultaneously.
 * Providers that recognise a namespace use it; providers that don't, ignore it.
 * Providers that cache implicitly (OpenAI, Google, DeepSeek) continue doing so
 * and report hits via their usage metadata.
 *
 * Wrapping is idempotent — double-wrapping produces identical behaviour, not
 * double-tagging.
 *
 * @public
 */
export function withPromptCaching(model: LanguageModel): LanguageModel {
  // GlobalProviderModelId (string) — Vercel gateway handles caching automatically.
  if (typeof model === "string") {
    return model;
  }
  // LanguageModelV2 — skip caching, return unchanged.
  if (model.specificationVersion !== "v3") {
    console.debug("budge: withPromptCaching received a non-v3 model, caching will not be applied");
    return model;
  }
  return wrapLanguageModel({ model, middleware: createCachingMiddleware() });
}

// ---------------------------------------------------------------------------
// Internal middleware
// ---------------------------------------------------------------------------

/**
 * Creates the V3 caching middleware.
 *
 * The middleware attaches `providerOptions` to the system message before every
 * model invocation. Providers that recognise the namespace use it; others
 * silently ignore it. If the transform throws for any reason the original
 * params are returned unchanged — caching is an optimisation, not a
 * dependency.
 *
 * @internal
 */
function createCachingMiddleware(): LanguageModelMiddleware {
  return {
    specificationVersion: "v3",

    async transformParams({ params }) {
      try {
        const prompt = params.prompt;
        const sysIdx = prompt.findIndex((m) => m.role === "system");
        if (sysIdx === -1) {
          // No system message — nothing to annotate.
          return params;
        }

        const sysMsg = prompt[sysIdx]!;

        // Idempotency: if the anthropic cache marker is already present, skip.
        // This covers the case where the caller pre-wrapped their own model
        // and already set the marker, or where transformParams is called twice
        // on the same params object.
        const existingOptions = sysMsg.providerOptions as
          | Record<string, Record<string, unknown>>
          | undefined;
        if (existingOptions?.anthropic?.cacheControl !== undefined) {
          return params;
        }

        // Merge cache markers into the system message's providerOptions.
        // We spread existing values first so nothing is clobbered.
        const updatedMsg = {
          ...sysMsg,
          providerOptions: {
            ...existingOptions,
            anthropic: {
              ...(existingOptions?.anthropic as Record<string, unknown> | undefined),
              cacheControl: { type: "ephemeral" },
            },
            gateway: {
              ...(existingOptions?.gateway as Record<string, unknown> | undefined),
              caching: "auto",
            },
          },
        };

        const newPrompt = [...prompt];
        newPrompt[sysIdx] = updatedMsg as typeof sysMsg;

        return { ...params, prompt: newPrompt };
      } catch (err) {
        console.debug("budge: prompt caching transform failed, falling back:", err);
        return params;
      }
    },
  };
}

// ---------------------------------------------------------------------------
// Cached-token extraction helper
// ---------------------------------------------------------------------------

/**
 * Normalises cached-token counts across provider shapes.
 *
 * Resolution order:
 * 1. `usage.inputTokenDetails.cacheReadTokens` — AI SDK canonical field (ai@6+)
 * 2. `usage.cachedInputTokens` — deprecated top-level field, kept for back-compat
 * 3. `providerMetadata.anthropic.cacheReadInputTokens` — Anthropic raw metadata
 * 4. `providerMetadata.openai.cachedPromptTokens` — OpenAI raw metadata
 * 5. `providerMetadata.google.cachedContentTokenCount` — Google raw metadata
 * 6. `providerMetadata.openrouter.cache_read_input_tokens` — OpenRouter (snake_case)
 * 7. Returns 0 when nothing matches.
 *
 * @internal — used by agent.ts and subcall.ts; not exported from index.ts.
 */
export function extractCachedTokens(
  providerMetadata: Record<string, unknown> | undefined,
  usage:
    | {
        inputTokenDetails?: { cacheReadTokens?: number | undefined } | undefined;
        cachedInputTokens?: number | undefined;
      }
    | undefined,
): number {
  // 1. AI SDK canonical field (ai@6)
  if (typeof usage?.inputTokenDetails?.cacheReadTokens === "number") {
    return usage.inputTokenDetails.cacheReadTokens;
  }
  // 2. Deprecated top-level field
  if (typeof usage?.cachedInputTokens === "number") {
    return usage.cachedInputTokens;
  }
  // 3. Anthropic provider metadata
  const anthropic = providerMetadata?.anthropic as Record<string, unknown> | undefined;
  if (typeof anthropic?.cacheReadInputTokens === "number") {
    return anthropic.cacheReadInputTokens;
  }
  // 4. OpenAI provider metadata
  const openai = providerMetadata?.openai as Record<string, unknown> | undefined;
  if (typeof openai?.cachedPromptTokens === "number") {
    return openai.cachedPromptTokens;
  }
  // 5. Google provider metadata
  const google = providerMetadata?.google as Record<string, unknown> | undefined;
  if (typeof google?.cachedContentTokenCount === "number") {
    return google.cachedContentTokenCount;
  }
  // 6. OpenRouter provider metadata (snake_case)
  const openrouter = providerMetadata?.openrouter as Record<string, unknown> | undefined;
  if (typeof openrouter?.cache_read_input_tokens === "number") {
    return openrouter.cache_read_input_tokens;
  }
  return 0;
}
