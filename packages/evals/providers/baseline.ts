/**
 * evals/providers/baseline.ts
 *
 * Baseline provider: reads the entire codebase into a single prompt
 * and sends it directly to the model with no orchestration.
 *
 * Must be a class — promptfoo calls `new Provider(options)` for file:// providers.
 */

import path from "node:path";
import fs from "node:fs";
import type { CallApiContextParams, ProviderOptions, ProviderResponse } from "promptfoo";

interface BaselineProviderConfig {
  root?: string;
  include?: string[];
  exclude?: string[];
  model?: string;
  provider?: string;
}

interface FsOptions {
  include?: string[];
  exclude?: string[];
}

function collectFiles(dir: string, options: FsOptions = {}): string[] {
  const exclude = options.exclude ?? [
    "node_modules",
    ".git",
    "dist",
    ".next",
    ".turbo",
    "coverage",
    ".cache",
  ];
  const include = options.include ?? null;
  const results: string[] = [];

  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return results;
  }

  for (const entry of entries) {
    if (exclude.includes(entry.name)) continue;
    const fullPath = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      results.push(...collectFiles(fullPath, options));
    } else if (entry.isFile()) {
      if (include && !include.some((ext) => entry.name.endsWith(ext))) continue;
      results.push(fullPath);
    }
  }

  return results;
}

function buildFullContext(
  files: string[],
  sourceRoot: string,
  maxFileSize = 128 * 1024,
): { context: string; totalBytes: number } {
  const parts: string[] = [];
  let totalBytes = 0;

  for (const filePath of files) {
    const rel = path.relative(sourceRoot, filePath);
    try {
      const stat = fs.statSync(filePath);
      if (stat.size > maxFileSize) {
        parts.push(`--- ${rel} ---\n[File too large: ${(stat.size / 1024).toFixed(1)} KiB]`);
        continue;
      }
      const content = fs.readFileSync(filePath, "utf8");
      parts.push(`--- ${rel} ---\n${content}`);
      totalBytes += stat.size;
    } catch {
      parts.push(`--- ${rel} ---\n[Could not read file]`);
    }
  }

  return { context: parts.join("\n\n"), totalBytes };
}

export default class BaselineProvider {
  private readonly config: BaselineProviderConfig;
  private readonly providerId: string;

  constructor(options: ProviderOptions) {
    this.config = (options.config ?? {}) as BaselineProviderConfig;
    this.providerId = options.id ?? "baseline";
  }

  id(): string {
    return this.providerId;
  }

  async callApi(prompt: string, _context?: CallApiContextParams): Promise<ProviderResponse> {
    const { config } = this;

    const evalDir = path.dirname(new URL(import.meta.url).pathname);
    const repoRoot = path.resolve(evalDir, "../../..");
    const sourceRoot = config.root
      ? path.resolve(evalDir, config.root)
      : path.resolve(repoRoot, "packages/core");

    const model = config.model ?? process.env.BASELINE_MODEL ?? "claude-sonnet-4-6";
    const providerName = config.provider ?? process.env.BUDGE_PROVIDER ?? "anthropic";

    const files = collectFiles(sourceRoot, {
      include: config.include,
      exclude: config.exclude,
    });
    const { context: fullContext, totalBytes } = buildFullContext(files, sourceRoot);

    const systemPrompt = [
      "You are an expert software engineer.",
      "You have been given the complete contents of a codebase below.",
      "Answer the user's question directly and precisely based only on the provided code.",
      "",
      "## Codebase",
      "",
      fullContext,
    ].join("\n");

    const { generateText } = await import("ai");

    let llmModel: Parameters<typeof generateText>[0]["model"];

    if (providerName === "anthropic") {
      const { anthropic } = await import("@ai-sdk/anthropic");
      llmModel = anthropic(model);
    } else {
      const { openai } = await import("@ai-sdk/openai");
      llmModel = openai(model);
    }

    const startMs = Date.now();

    try {
      const result = await generateText({
        model: llmModel,
        system: systemPrompt,
        messages: [{ role: "user", content: prompt }],
      });

      const wallMs = Date.now() - startMs;
      const totalTokens = (result.usage?.inputTokens ?? 0) + (result.usage?.outputTokens ?? 0);

      return {
        output: result.text,
        latencyMs: wallMs,
        tokenUsage: {
          total: totalTokens,
          prompt: result.usage?.inputTokens ?? 0,
          completion: result.usage?.outputTokens ?? 0,
        },
        metadata: {
          totalTokens,
          filesRead: files.length,
          totalBytes,
          durationMs: wallMs,
          approach: "full-context-dump",
        },
      };
    } catch (err) {
      return {
        error: err instanceof Error ? err.message : String(err),
      };
    }
  }
}
