import { access, readFile } from 'node:fs/promises';

import { z } from 'zod';

import type { OdysseysTrajectoryScreenshot } from './trajectory.js';
import type { BenchmarkConfig, GradeResult, OdysseysTask, RubricResult } from './types.js';

const FINAL_JUDGMENT_MAX_COMPLETION_TOKENS = 8192;
const GRADER_MAX_ATTEMPTS = 5;
const GRADER_MAX_RATE_LIMIT_RETRIES = 120;
const GRADER_REQUEST_GAP_MS = 5_000;
let nextGeminiRequestAt = 0;
let geminiRequestQueue = Promise.resolve();

const FULL_TRAJ_JUDGMENT_SYSTEM = `You are an expert evaluator of web-navigation agent trajectories.

You will receive:
- The user task (for context).
- ONE specific rubric item with a requirement and a verification description.
- The agent's full action history (one line per step).
- Every screenshot from the trajectory, in chronological order.

Your goal is to decide whether this single rubric item is satisfied by the trajectory.

Evaluation rules:
- Judge ONLY the one rubric item you are given; ignore all other implicit requirements.
- Ground your judgment in what the screenshots and actions actually show. Do not invent state.
- Filtering / sorting / form requirements must be applied and confirmed to count as satisfied.
- If the agent was blocked (captcha, access denied, etc.) and therefore could not satisfy the rubric, report failure.

Respond in exactly this format:

Thoughts: <your reasoning, citing specific steps/screenshots>
Status: "success" or "failure"
`;

const GeminiResponseSchema = z.object({
  candidates: z
    .array(
      z.object({
        content: z.object({
          parts: z.array(z.object({ text: z.string().optional() }).passthrough()),
        }),
      }),
    )
    .optional(),
  error: z.object({ message: z.string() }).optional(),
});

interface RubricJudgement {
  success: boolean;
  reasoning: string;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function parseRetryDelayMs(message: string): number {
  const seconds = Number(message.match(/retry in\s+([\d.]+)s/i)?.[1] ?? NaN);
  return Number.isFinite(seconds) && seconds > 0 ? Math.ceil(seconds * 1000) : 0;
}

function buildRubricPrompt(
  task: OdysseysTask,
  rubricId: string,
  rubric: OdysseysTask['rubrics'][string],
  trajectoryLog: string,
  screenshots: OdysseysTrajectoryScreenshot[],
): string {
  const actionHistory = trajectoryLog.trim() || 'No actions recorded.';
  const stepCount = actionHistory === 'No actions recorded.' ? 0 : actionHistory.split('\n').filter(Boolean).length;

  return `User Task (context only): ${task.confirmed_task.trim()}

Evaluate ONLY this rubric item:
Rubric ID: ${rubricId}
Requirement: ${rubric.requirement.trim()}
Verification: ${rubric.verification.trim()}

Full Action History:
${actionHistory}

Screenshots attached below: ${screenshots.length} (trajectory had ${stepCount} total step(s)).

Decide whether the rubric (${rubricId}) is satisfied. Use the required 'Thoughts:' / 'Status:' format.`;
}

function parseJudgement(rawText: string): RubricJudgement {
  const status = rawText.match(/Status:\s*["']?(success|failure)["']?/i)?.[1]?.toLowerCase();
  const thoughts = rawText.match(/Thoughts:\s*(.+?)(?:Status:|$)/is)?.[1]?.trim();

  return {
    success: status === 'success',
    reasoning: thoughts || rawText.trim() || 'Empty judge response.',
  };
}

async function withGeminiRequestGap<T>(fn: () => Promise<T>): Promise<T> {
  const run = geminiRequestQueue
    .catch(() => undefined)
    .then(async () => {
      const waitMs = Math.max(0, nextGeminiRequestAt - Date.now());
      if (waitMs > 0) await sleep(waitMs);
      return await fn();
    });
  geminiRequestQueue = run.then(() => undefined, () => undefined);
  return await run;
}

async function callGeminiJudge(
  config: BenchmarkConfig,
  userPrompt: string,
  screenshots: OdysseysTrajectoryScreenshot[],
): Promise<RubricJudgement> {
  return await withGeminiRequestGap(async () => {
    const response = await fetch(
      `https://generativelanguage.googleapis.com/v1beta/models/${config.graderModel}:generateContent?key=${config.googleApiKey}`,
      {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          systemInstruction: { parts: [{ text: FULL_TRAJ_JUDGMENT_SYSTEM }] },
          contents: [
            {
              role: 'user',
              parts: [
                { text: userPrompt },
                ...screenshots.map((shot) => ({
                  inlineData: {
                    mimeType: shot.mimeType,
                    data: shot.data,
                  },
                })),
              ],
            },
          ],
          generationConfig: {
            temperature: 0,
            maxOutputTokens: FINAL_JUDGMENT_MAX_COMPLETION_TOKENS,
          },
        }),
      },
    );
    nextGeminiRequestAt = Date.now() + GRADER_REQUEST_GAP_MS;

    const raw = GeminiResponseSchema.parse(await response.json());
    if (!response.ok || raw.error) {
      const retryDelayMs = parseRetryDelayMs(raw.error?.message ?? '');
      if (retryDelayMs > 0) nextGeminiRequestAt = Math.max(nextGeminiRequestAt, Date.now() + retryDelayMs);
      throw new Error(raw.error?.message ?? `Gemini judge request failed with ${response.status}`);
    }

    const text = raw.candidates?.[0]?.content.parts
      .map((part) => part.text ?? '')
      .join('')
      .trim();
    if (!text) throw new Error('No response from Gemini judge');

    return parseJudgement(text);
  });
}

function errorGrade(task: OdysseysTask, reasoning: string, durationMs: number): GradeResult {
  const rubricResults = Object.entries(task.rubrics).map(
    ([rubricId, rubric]): RubricResult => ({
      rubric_id: rubricId,
      requirement: rubric.requirement,
      verification: rubric.verification,
      score: 0,
      success: false,
      final_reasoning: reasoning,
    }),
  );

  return {
    verdict: 'error',
    reasoning,
    durationMs,
    rubricScores: Object.fromEntries(rubricResults.map((result) => [result.rubric_id, result.score])),
    rubricResults,
    averageRubricScore: 0,
    perfect: false,
    error: reasoning,
  };
}

export async function gradeTaskResult(
  task: OdysseysTask,
  trajectoryLogPath: string,
  config: BenchmarkConfig,
  screenshots: OdysseysTrajectoryScreenshot[] = [],
): Promise<GradeResult> {
  if (!config.grade) return errorGrade(task, 'Grading skipped by --no-grade', 0);
  if (!config.googleApiKey) return errorGrade(task, 'No Google API key configured for grading', 0);

  const graderStart = Date.now();
  if (
    !(await access(trajectoryLogPath)
      .then(() => true)
      .catch(() => false))
  ) {
    return errorGrade(task, 'No trajectory log found', Date.now() - graderStart);
  }

  const trajectoryLog = await readFile(trajectoryLogPath, 'utf8');
  const rubricResults: RubricResult[] = [];

  for (const [rubricId, rubric] of Object.entries(task.rubrics)) {
    const userPrompt = buildRubricPrompt(task, rubricId, rubric, trajectoryLog, screenshots);
    let lastError: Error | null = null;
    let rateLimitRetries = 0;

    for (let attempt = 0; attempt < GRADER_MAX_ATTEMPTS; attempt += 1) {
      try {
        const judgement = await callGeminiJudge(config, userPrompt, screenshots);
        rubricResults.push({
          rubric_id: rubricId,
          requirement: rubric.requirement,
          verification: rubric.verification,
          score: judgement.success ? 1 : 0,
          success: judgement.success,
          final_reasoning: judgement.reasoning,
        });
        lastError = null;
        break;
      } catch (error) {
        lastError = error instanceof Error ? error : new Error(String(error));
        const isRateLimit = /quota|rate.?limit/i.test(lastError.message);
        if (isRateLimit) {
          rateLimitRetries += 1;
          console.error(`[odysseys-grader] rate limit response for ${task.task_id}/${rubricId}:\n${lastError.message}`);
          if (rateLimitRetries <= GRADER_MAX_RATE_LIMIT_RETRIES) {
            await sleep(Math.max(1000, Math.min(parseRetryDelayMs(lastError.message), 60_000)));
            attempt -= 1;
            continue;
          }
        }
        if (attempt < GRADER_MAX_ATTEMPTS - 1) await sleep(1000);
      }
    }

    if (lastError) {
      rubricResults.push({
        rubric_id: rubricId,
        requirement: rubric.requirement,
        verification: rubric.verification,
        score: 0,
        success: false,
        final_reasoning: `Error judging rubric ${rubricId}: ${lastError.message}`,
      });
    }
  }

  const rubricScores = Object.fromEntries(rubricResults.map((result) => [result.rubric_id, result.score]));
  const averageRubricScore =
    rubricResults.length > 0 ? rubricResults.reduce((sum, result) => sum + result.score, 0) / rubricResults.length : 0;
  const perfect = rubricResults.length > 0 && rubricResults.every((result) => result.success);
  const hadJudgeError = rubricResults.some((result) => result.final_reasoning.startsWith('Error judging rubric '));

  return {
    verdict: hadJudgeError ? 'error' : perfect ? 'pass' : 'fail',
    reasoning: rubricResults
      .map((result) => `${result.rubric_id}: ${result.success ? 'success' : 'failure'} - ${result.final_reasoning}`)
      .join('\n\n'),
    durationMs: Date.now() - graderStart,
    rubricScores,
    rubricResults,
    averageRubricScore: Math.round(averageRubricScore * 10_000) / 10_000,
    perfect,
    ...(hadJudgeError && { error: 'One or more rubrics failed to grade.' }),
  };
}
