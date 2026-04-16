import path from "node:path";
import { pathToFileURL } from "node:url";
import { generateText } from "ai";
import type { CallApiContextParams, ProviderOptions, ProviderResponse } from "promptfoo";
import type { createBudge as CreateBudge, source as Source, ToolCallEvent } from "@budge/core";
import {
  getLongBenchTaskType,
  normalizeProviderOutput,
  parseLongBenchPayload,
  renderBudgeTask,
} from "../lib/longbench.ts";
import {
  getLanguageModel,
  normalizeUsage,
  repoRootFromImport,
  summarizeWarnings,
  toPromptfooResponse,
} from "./shared.ts";
import { writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { mkdirSync } from "node:fs";

interface LongBenchBudgeProviderConfig {
  orchestratorModel?: string;
  workerModel?: string;
  actionModel?: string;
  provider?: string;
  maxSteps?: number;
}

const traceDir = path.join(homedir(), ".budge", "traces", "longbench");
mkdirSync(traceDir, { recursive: true });

export default class LongBenchBudgeProvider {
  private readonly config: LongBenchBudgeProviderConfig;
  private readonly providerId: string;

  constructor(options: ProviderOptions) {
    this.config = (options.config ?? {}) as LongBenchBudgeProviderConfig;
    this.providerId = options.id ?? "longbench-budge";
  }

  id(): string {
    return this.providerId;
  }

  async callApi(prompt: string, _context?: CallApiContextParams): Promise<ProviderResponse> {
    const payload = parseLongBenchPayload(prompt);
    const taskType = getLongBenchTaskType(payload);
    const repoRoot = repoRootFromImport(import.meta.url);
    const mod = await import(
      pathToFileURL(path.resolve(repoRoot, "packages/core/src/index.ts")).href
    );
    const createBudge = mod.createBudge as typeof CreateBudge;
    const source = mod.source as typeof Source;
    const providerName = this.config.provider ?? process.env.BUDGE_PROVIDER ?? "openai";
    const orchestratorModelName =
      this.config.orchestratorModel ?? process.env.BUDGE_ORCHESTRATOR ?? "openai/gpt-5.4-mini";
    const workerModelName =
      this.config.workerModel ?? process.env.BUDGE_WORKER ?? "openai/gpt-5.4-mini";
    const actionModelName =
      this.config.actionModel ?? process.env.BUDGE_ACTION ?? "openai/gpt-5.4-mini";
    const orchestrator = await getLanguageModel(providerName, orchestratorModelName);
    const worker = await getLanguageModel(providerName, workerModelName);
    const actionModel = await getLanguageModel(providerName, actionModelName);
    const budge = createBudge({ orchestrator, worker });

    let toolCallCount = 0;
    const toolCallLog: string[] = [];
    const onToolCall = (event: ToolCallEvent) => {
      toolCallCount += 1;
      toolCallLog.push(event.tool);
    };

    const prepStart = Date.now();
    const prepared = await budge.prepare({
      task: renderBudgeTask(payload),
      sources: { document: source.text(payload.context) },
      maxSteps: this.config.maxSteps ?? 20,
      onToolCall,
    });

    await writeFile(
      path.join(traceDir, `${payload._id}-budge.json`),
      JSON.stringify(
        {
          finishReason: prepared.finishReason,
          answer: prepared.answer,
          handoff: prepared.handoff,
          trace: prepared.trace,
          question: payload.question,
          choices: payload.choices,
        },
        null,
        2,
      ),
    );

    const prepMs = Date.now() - prepStart;
    const directAnswer = normalizeProviderOutput(prepared.answer);

    const actionStart = Date.now();
    const result = await generateText({
      model: actionModel,
      system: prepared.handoff,
      messages: [
        {
          role: "user",
          content: `${payload.question}\n\nA) ${payload.choices.A}\nB) ${payload.choices.B}\nC) ${payload.choices.C}\nD) ${payload.choices.D}\n\nAnswer with just the letter: A, B, C, or D.`,
        },
      ],
    });
    const actionMs = Date.now() - actionStart;
    const predicted = normalizeProviderOutput(result.text);

    return toPromptfooResponse({
      output: predicted,
      prepTokens: prepared.trace.totalTokens,
      actionUsage: normalizeUsage(result.usage),
      prepMs,
      actionMs,
      metadata: {
        providerKind: "budge",
        itemId: payload._id,
        predicted,
        correctAnswer: payload.answer,
        domain: payload.domain,
        subDomain: payload.sub_domain,
        taskType,
        difficulty: payload.difficulty,
        length: payload.length,
        directAnswer,
        handoffAnswer: predicted,
        budgeAnswer: prepared.answer,
        finishReason: prepared.finishReason,
        totalSubcalls: prepared.trace.totalSubcalls,
        handoffFailed: prepared.handoffFailed,
        toolCallCount,
        toolCallLog,
        rawOutput: result.text,
        warnings: summarizeWarnings(result.warnings),
      },
    });
  }
}
