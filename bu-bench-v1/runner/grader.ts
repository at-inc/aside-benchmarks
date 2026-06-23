import { access, readFile } from 'node:fs/promises';

import { z } from 'zod';

import type { BenchmarkConfig, BuBenchTask, GradeResult } from './types.js';

const JUDGE_MODEL = 'gemini-2.5-flash';
const JUDGE_TEXT_SIDE_LENGTH = 40_000;

const JudgementResultSchema = z.object({
  reasoning: z.string().nullable().default(null),
  verdict: z.boolean(),
  failure_reason: z.string().nullable().default(null),
  impossible_task: z.boolean().default(false),
  reached_captcha: z.boolean().default(false),
});

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

type JudgementResult = z.infer<typeof JudgementResultSchema>;

function collectLinesUpToApproxLength(lines: string[], maxLength: number): string[] {
  const collected: string[] = [];
  let length = 0;
  for (const line of lines) {
    collected.push(line);
    length += line.length + 1;
    if (length > maxLength) break;
  }
  return collected;
}

function truncateText(text: string): string {
  if (text.length <= JUDGE_TEXT_SIDE_LENGTH * 2) return text;

  const lines = text.split('\n');
  const headLines = collectLinesUpToApproxLength(lines, JUDGE_TEXT_SIDE_LENGTH);
  const tailLines = collectLinesUpToApproxLength([...lines].reverse(), JUDGE_TEXT_SIDE_LENGTH).reverse();
  const truncatedLineCount = Math.max(0, lines.length - headLines.length - tailLines.length);

  return [
    ...headLines,
    `[...truncated ${truncatedLineCount} lines - agent did actions but truncated...]`,
    ...tailLines,
  ].join('\n');
}

function buildReasoning(judgement: JudgementResult): string {
  const reasoning = judgement.reasoning?.trim();
  const failureReason = judgement.failure_reason?.trim();
  if (reasoning && failureReason) return `${reasoning}\n\nFailure reason: ${failureReason}`;
  return reasoning || failureReason || '';
}

// Aligned with the old BU Bench runner; this port grades Aside CLI stdout/events
// instead of daemon session messages and screenshots.
function buildJudgePrompts(task: BuBenchTask, trajectoryLog: string) {
  const groundTruthSection = task.answer
    ? `
**GROUND TRUTH VALIDATION (HIGHEST PRIORITY):**
The <ground_truth> section contains verified correct information for this task. This can be:
- **Evaluation criteria**: Specific conditions that must be met
- **Factual answers**: The correct answer to a question or information retrieval task
- **Expected outcomes**: What should happen after task completion

The ground truth takes ABSOLUTE precedence over all other evaluation criteria. If the ground truth is not satisfied by the agent's execution and final response, the verdict MUST be false.
`
    : '';

  const systemPrompt = `You are an expert judge evaluating browser automation agent performance.

<evaluation_framework>
${groundTruthSection}
**PRIMARY EVALUATION CRITERIA (in order of importance):**
1. **Task Satisfaction (Most Important)**: Did the agent accomplish what the user asked for?
2. **Output Quality**: Is the final result in the correct format and complete?
3. **Tool Effectiveness**: Did the browser interactions work as expected?
4. **Agent Reasoning**: Quality of decision-making, planning, and problem-solving.
5. **Browser Handling**: Navigation stability, error recovery, and technical execution.

**VERDICT GUIDELINES:**
- true: Task completed as requested, human-like execution, all user criteria were met, and the agent did not make up information.
- false: Task not completed, or only partially completed.

**FAILURE CONDITIONS (automatically set verdict to false):**
- Blocked by captcha or missing authentication
- Output format completely wrong or missing
- Infinite loops or severe technical failures
- Critical user requirements ignored
- Page not loaded
- Browser crashed
- Agent could not interact with required UI elements
- The agent calls done action before completing all key points of the task

**IMPOSSIBLE TASK DETECTION:**
Set \`impossible_task\` to true when the task fundamentally could not be completed due to ambiguous instructions, broken/inaccessible pages, required authentication without credentials, missing site functionality, or other insurmountable external obstacles.

Do NOT mark as impossible if the agent made poor decisions but the task was achievable.

**IMPORTANT EVALUATION NOTES:**
- Evaluate whether attempted actions actually happened.
- Be initially doubtful of the agent's self-reported success.
- This harness provides Aside CLI stdout and raw event summaries instead of daemon-side screenshots. Do not penalize missing screenshots by itself.

</evaluation_framework>

<response_format>
Respond with EXACTLY this JSON structure (no additional text before or after):

{
  "reasoning": "Detailed analysis of task satisfaction, trajectory quality, tool usage, output quality, and overall user satisfaction prediction.",
  "verdict": true or false,
  "failure_reason": "Max 5 sentences explanation of why the task was not completed successfully in case of failure. If verdict is true, use an empty string.",
  "impossible_task": true or false,
  "reached_captcha": true or false
}
</response_format>`;

  const groundTruthPrompt = task.answer
    ? `
<ground_truth>
${task.answer}
</ground_truth>
`
    : '';

  const userPrompt = `
<task>
${truncateText(task.confirmed_task) || 'No task provided'}
</task>
${groundTruthPrompt}
<agent_trajectory>
${truncateText(trajectoryLog) || 'No agent trajectory provided'}
</agent_trajectory>

Evaluate this agent execution given the criteria and respond with the exact JSON structure requested.`;

  return { systemPrompt, userPrompt };
}

async function callGeminiJudge(config: BenchmarkConfig, systemPrompt: string, userPrompt: string): Promise<JudgementResult> {
  const response = await fetch(
    `https://generativelanguage.googleapis.com/v1beta/models/${JUDGE_MODEL}:generateContent?key=${config.googleApiKey}`,
    {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        systemInstruction: { parts: [{ text: systemPrompt }] },
        contents: [{ role: 'user', parts: [{ text: userPrompt }] }],
        generationConfig: {
          temperature: 0,
          responseMimeType: 'application/json',
          responseSchema: {
            type: 'OBJECT',
            properties: {
              reasoning: { type: 'STRING' },
              verdict: { type: 'BOOLEAN' },
              failure_reason: { type: 'STRING' },
              impossible_task: { type: 'BOOLEAN' },
              reached_captcha: { type: 'BOOLEAN' },
            },
            required: ['reasoning', 'verdict', 'failure_reason', 'impossible_task', 'reached_captcha'],
          },
        },
      }),
    },
  );

  const raw = GeminiResponseSchema.parse(await response.json());
  if (!response.ok || raw.error) {
    throw new Error(raw.error?.message ?? `Gemini judge request failed with ${response.status}`);
  }

  const text = raw.candidates?.[0]?.content.parts
    .map((part) => part.text ?? '')
    .join('')
    .trim();
  if (!text) throw new Error('No response from Gemini judge');

  return JudgementResultSchema.parse(JSON.parse(text));
}

export async function gradeTaskResult(
  task: BuBenchTask,
  trajectoryLogPath: string,
  config: BenchmarkConfig,
): Promise<GradeResult> {
  if (!config.grade) return { verdict: 'error', reasoning: 'Grading skipped by --no-grade', durationMs: 0 };
  if (!config.googleApiKey) return { verdict: 'error', reasoning: 'No Google API key configured for grading', durationMs: 0 };

  if (
    !(await access(trajectoryLogPath)
      .then(() => true)
      .catch(() => false))
  ) {
    return { verdict: 'fail', reasoning: 'No trajectory log found', durationMs: 0 };
  }

  const graderStart = Date.now();
  const trajectoryLog = await readFile(trajectoryLogPath, 'utf8');
  const { systemPrompt, userPrompt } = buildJudgePrompts(task, trajectoryLog);

  let lastError: Error | null = null;
  for (let attempt = 0; attempt < 3; attempt += 1) {
    try {
      const judgement = await callGeminiJudge(config, systemPrompt, userPrompt);
      return {
        verdict: judgement.verdict ? 'pass' : judgement.impossible_task ? 'impossible' : 'fail',
        reasoning: buildReasoning(judgement),
        durationMs: Date.now() - graderStart,
      };
    } catch (error) {
      lastError = error instanceof Error ? error : new Error(String(error));
      if (attempt < 2) await new Promise((resolve) => setTimeout(resolve, 1000));
    }
  }

  return {
    verdict: 'error',
    reasoning: lastError ? `Grader error: ${lastError.message}` : 'No response from grader',
    durationMs: Date.now() - graderStart,
  };
}
