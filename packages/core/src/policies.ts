import type { Policies, PolicyRecord } from "./types.ts";
import { RequiredSourceMissingError } from "./errors.ts";

interface PolicyResult {
  allowed: Set<string>;
  records: PolicyRecord[];
}

/**
 * Apply policies to the resolved source map.
 * Returns the set of allowed source keys and a list of policy records for trace.
 */
export function applyPolicies<
  TSources extends Record<string, unknown>,
  TDerived extends Record<string, unknown>,
  TRequired extends readonly Extract<keyof TSources, string>[] = [],
  TPrefer extends readonly Extract<keyof TSources, string>[] = [],
>(
  resolvedSources: Map<string, unknown>,
  derived: TDerived,
  policies: Policies<TSources, TDerived, TRequired, TPrefer>,
  windowId: string,
): PolicyResult {
  const records: PolicyRecord[] = [];
  const sourceKeys = [...resolvedSources.keys()];
  const allowed = new Set(sourceKeys);
  const requiredKeys = new Set((policies.require ?? []).map(String));

  // Build merged context for exclude fn evaluation
  const mergedContext = Object.fromEntries(resolvedSources) as TSources & TDerived;
  Object.assign(mergedContext, derived);

  // --- require ---
  for (const key of policies.require ?? []) {
    const keyStr = String(key);
    const value = resolvedSources.get(keyStr);
    if (value === null || value === undefined) {
      throw new RequiredSourceMissingError(keyStr, windowId);
    }
    records.push({
      source: keyStr,
      action: "required",
      reason: "required by policy",
    });
  }

  // --- prefer ---
  for (const key of policies.prefer ?? []) {
    const keyStr = String(key);
    if (resolvedSources.has(keyStr)) {
      records.push({
        source: keyStr,
        action: "preferred",
        reason: "preferred for grounding",
      });
    }
  }

  // --- exclude ---
  const excludedKeys: string[] = [];
  for (const excludeFn of policies.exclude ?? []) {
    const decision = excludeFn(mergedContext);
    if (decision !== false) {
      const { source, reason } = decision;

      if (requiredKeys.has(source)) {
        throw new Error(`Required source "${source}" cannot be excluded.`);
      }

      allowed.delete(source);
      excludedKeys.push(source);
      records.push({
        source,
        action: "excluded",
        reason,
      });
    }
  }

  // Mark all non-excluded, non-required, non-preferred sources as included
  const explicitKeys = new Set([
    ...requiredKeys,
    ...(policies.prefer ?? []).map(String),
    ...excludedKeys.map(String),
  ]);

  for (const key of sourceKeys) {
    if (allowed.has(key) && !explicitKeys.has(key)) {
      records.push({
        source: key,
        action: "included",
        reason: "included by default",
      });
    }
  }

  return { allowed, records };
}
