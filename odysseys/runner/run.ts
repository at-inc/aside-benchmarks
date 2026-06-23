import { spawn } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';

import { z } from 'zod';

import { gradeTaskResult } from './grader.js';
import {
  formatOdysseysActionHistory,
  generateOdysseysTrajectory,
  serializeOdysseysStepsJsonl,
  writeScreenshots,
} from './trajectory.js';
import {
  THINKING_LEVELS,
  VALID_LEVELS,
  type BenchmarkConfig,
  type LevelSummary,
  type OdysseysEvalTaskResult,
  type OdysseysLevel,
  type OdysseysTask,
  type RunSummary,
  type TaskResult,
  type ThinkingLevel,
} from './types.js';

const DATASET_PATH = resolve(import.meta.dirname, 'Odysseys-dataset.json.enc');
const DEFAULT_GRADER_MODEL = 'gemini-3.1-flash-lite';
const DEFAULT_MAX_STEPS = 200;
const DEFAULT_TIMEOUT_MS = 30 * 60_000;

const RubricSchema = z.object({
  requirement: z.string(),
  verification: z.string(),
});

const OdysseysTaskSchema = z.object({
  task_id: z.string(),
  confirmed_task: z.string(),
  website: z.string(),
  reference_length: z.number(),
  level: z.enum(VALID_LEVELS),
  rubrics: z.record(z.string(), RubricSchema),
  categories: z.array(z.string()).default([]),
  num_categories: z.number().default(0),
});

function printHelp(): never {
  console.log(`Odysseys Aside CLI Runner

Usage: pnpm run run -- [options]

Options:
  --provider <name>          Model provider (default: openai)
  --model <name>             Model ID (default: gpt-5.5)
  --thinking <level>         Thinking level: ${THINKING_LEVELS.join(', ')} (default: high)
  --concurrency <n>          Parallel task count (default: 6)
  --limit <n>                Run first N tasks only
  --level <easy|medium|hard> Filter by difficulty
  --task <id>                Run single task by ID
  --task-list-json <path>    Run only task IDs listed in a JSON array file
  --output-dir <path>        Output directory (default: results/{timestamp})
  --resume                   Skip tasks with existing results
  --dataset <path>           Path to encoded dataset (default: Odysseys-dataset.json.enc)
  --grader-model <name>      Gemini grader model (default: ${DEFAULT_GRADER_MODEL})
  --max-steps <n>            Max generated trajectory steps for grading (default: ${DEFAULT_MAX_STEPS})
  --timeout-minutes <n>      Per-task timeout (default: 30)
  --no-grade                 Skip Gemini grading
  --aside-command <command>  Aside CLI executable (default: aside)
  --aside-args <args>        Whitespace-separated args inserted before "exec"
  --help                     Show this help`);
  process.exit(0);
}

function assertNumber(name: string, value: number): number {
  if (!Number.isFinite(value) || value <= 0) throw new Error(`${name} must be a positive number`);
  return value;
}

function parseThinkingLevel(value: string): ThinkingLevel {
  if (THINKING_LEVELS.includes(value as ThinkingLevel)) return value as ThinkingLevel;
  throw new Error(`Invalid thinking level: ${value}`);
}

function parseLevel(value: string): OdysseysLevel {
  if (VALID_LEVELS.includes(value as OdysseysLevel)) return value as OdysseysLevel;
  throw new Error(`Invalid level: ${value}. Expected one of: ${VALID_LEVELS.join(', ')}`);
}

function splitArgs(value: string | undefined): string[] {
  return value?.trim() ? value.trim().split(/\s+/) : [];
}

function loadDotEnvValue(key: string): string | undefined {
  const envPath = join(import.meta.dirname, '.env');
  if (!existsSync(envPath)) return undefined;

  const line = readFileSync(envPath, 'utf8')
    .split('\n')
    .find((candidate) => candidate.match(new RegExp(`^${key}=`)));
  const value = line?.slice(key.length + 1).trim();
  return value?.replace(/^["']|["']$/g, '') || undefined;
}

function loadGoogleApiKey(): string | undefined {
  return (
    process.env.GEMINI_API_KEY ??
    process.env.GOOGLE_API_KEY ??
    process.env.GOOGLE_GENERATIVE_AI_API_KEY ??
    loadDotEnvValue('GEMINI_API_KEY') ??
    loadDotEnvValue('GOOGLE_API_KEY') ??
    loadDotEnvValue('GOOGLE_GENERATIVE_AI_API_KEY')
  );
}

function parseConfig(argv: string[]): BenchmarkConfig {
  if (argv.includes('--help') || argv.includes('-h')) printHelp();

  const timestamp = new Date().toISOString().slice(0, 19).replace(/:/g, '-');
  const config: BenchmarkConfig = {
    provider: 'openai',
    modelId: 'gpt-5.5',
    thinkingLevel: 'high',
    concurrency: 6,
    outputDir: resolve(import.meta.dirname, '..', 'results', timestamp),
    datasetPath: DATASET_PATH,
    googleApiKey: loadGoogleApiKey(),
    graderModel: DEFAULT_GRADER_MODEL,
    maxSteps: DEFAULT_MAX_STEPS,
    resume: false,
    grade: true,
    asideCommand: process.env.ASIDE_CLI_COMMAND ?? 'aside',
    asideArgs: splitArgs(process.env.ASIDE_CLI_ARGS),
    timeoutMs: DEFAULT_TIMEOUT_MS,
  };

  let hasExplicitOutputDir = false;

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    const next = argv[i + 1];
    if (!arg) continue;

    switch (arg) {
      case '--provider':
        if (!next) throw new Error('Missing value for --provider');
        config.provider = next;
        i += 1;
        break;
      case '--model':
        if (!next) throw new Error('Missing value for --model');
        config.modelId = next;
        i += 1;
        break;
      case '--thinking':
        if (!next) throw new Error('Missing value for --thinking');
        config.thinkingLevel = parseThinkingLevel(next);
        i += 1;
        break;
      case '--concurrency':
        if (!next) throw new Error('Missing value for --concurrency');
        config.concurrency = assertNumber('--concurrency', Number.parseInt(next, 10));
        i += 1;
        break;
      case '--limit':
        if (!next) throw new Error('Missing value for --limit');
        config.limit = assertNumber('--limit', Number.parseInt(next, 10));
        i += 1;
        break;
      case '--level':
        if (!next) throw new Error('Missing value for --level');
        config.level = parseLevel(next);
        i += 1;
        break;
      case '--task':
        if (!next) throw new Error('Missing value for --task');
        config.taskId = next;
        i += 1;
        break;
      case '--task-list-json':
        if (!next) throw new Error('Missing value for --task-list-json');
        config.taskListJsonPath = next;
        i += 1;
        break;
      case '--output-dir':
        if (!next) throw new Error('Missing value for --output-dir');
        config.outputDir = resolve(next);
        hasExplicitOutputDir = true;
        i += 1;
        break;
      case '--resume':
        config.resume = true;
        break;
      case '--dataset':
        if (!next) throw new Error('Missing value for --dataset');
        config.datasetPath = resolve(next);
        i += 1;
        break;
      case '--grader-model':
        if (!next) throw new Error('Missing value for --grader-model');
        config.graderModel = next;
        i += 1;
        break;
      case '--max-steps':
        if (!next) throw new Error('Missing value for --max-steps');
        config.maxSteps = assertNumber('--max-steps', Number.parseInt(next, 10));
        i += 1;
        break;
      case '--timeout-minutes':
        if (!next) throw new Error('Missing value for --timeout-minutes');
        config.timeoutMs = assertNumber('--timeout-minutes', Number.parseFloat(next)) * 60_000;
        i += 1;
        break;
      case '--no-grade':
        config.grade = false;
        break;
      case '--aside-command':
        if (!next) throw new Error('Missing value for --aside-command');
        config.asideCommand = next;
        i += 1;
        break;
      case '--aside-args':
        if (!next) throw new Error('Missing value for --aside-args');
        config.asideArgs = splitArgs(next);
        i += 1;
        break;
      default:
        throw new Error(`Unknown option: ${arg}`);
    }
  }

  if (!hasExplicitOutputDir && config.taskListJsonPath) {
    const stem = config.taskListJsonPath
      .split('/')
      .pop()!
      .replace(/\.json$/, '');
    config.outputDir = resolve(import.meta.dirname, '..', 'results', `${stem}-${timestamp}`);
  }

  return config;
}

function loadTaskListJson(filePath: string): string[] {
  if (!existsSync(filePath)) throw new Error(`Task list file not found: ${filePath}`);

  const parsed = JSON.parse(readFileSync(filePath, 'utf8'));
  if (!Array.isArray(parsed) || !parsed.every((value) => typeof value === 'string')) {
    throw new Error(`Task list file must be a JSON array of task IDs: ${filePath}`);
  }
  return parsed;
}

function loadTasks(config: BenchmarkConfig): OdysseysTask[] {
  // Store the dataset as base64 to prevent AI from training the data.
  const rawDataset = Buffer.from(readFileSync(config.datasetPath, 'utf8'), 'base64').toString('utf8');
  let tasks = z.array(OdysseysTaskSchema).parse(JSON.parse(rawDataset));

  if (config.taskListJsonPath) {
    const taskIds = new Set(loadTaskListJson(config.taskListJsonPath));
    tasks = tasks.filter((task) => taskIds.has(task.task_id));
  }
  if (config.taskId) tasks = tasks.filter((task) => task.task_id === config.taskId);
  if (config.level) tasks = tasks.filter((task) => task.level === config.level);
  if (config.limit !== undefined) tasks = tasks.slice(0, config.limit);

  if (config.resume) {
    const before = tasks.length;
    tasks = tasks.filter((task) => !existsSync(join(config.outputDir, task.task_id, 'result.json')));
    if (before !== tasks.length) console.log(`Resuming: skipped ${before - tasks.length} already-completed tasks`);
  }

  return tasks;
}

async function runWithConcurrency<T, R>(
  items: T[],
  concurrency: number,
  fn: (item: T, index: number) => Promise<R>,
): Promise<R[]> {
  const results: R[] = [];
  let nextIndex = 0;

  async function worker(): Promise<void> {
    while (nextIndex < items.length) {
      const index = nextIndex;
      nextIndex += 1;
      const item = items[index];
      if (!item) continue;

      try {
        results.push(await fn(item, index));
      } catch (error) {
        console.error(`Task ${index} failed:`, error instanceof Error ? error.message : String(error));
      }
    }
  }

  await Promise.all(Array.from({ length: Math.min(concurrency, items.length) }, () => worker()));
  return results;
}

function stripAnsi(text: string): string {
  return text.replace(/\u001B\[[0-9;]*m/g, '');
}

interface AsideCliResult {
  stdout: string;
  stderr: string;
  exitCode: number | null;
  timedOut: boolean;
}

async function runAsideCli(task: OdysseysTask, config: BenchmarkConfig, taskDir: string): Promise<AsideCliResult> {
  const prompt = `Go to ${task.website}, ${task.confirmed_task}`;
  const args = [
    ...config.asideArgs,
    'exec',
    '--model',
    `${config.provider}/${config.modelId}`,
    '--thinking',
    config.thinkingLevel,
    '--log-dump',
    join(taskDir, 'events.jsonl'),
    prompt,
  ];

  return await new Promise((resolvePromise, reject) => {
    const child = spawn(config.asideCommand, args, {
      env: process.env,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    const stdoutChunks: Buffer[] = [];
    const stderrChunks: Buffer[] = [];
    let timedOut = false;

    const timeout = setTimeout(() => {
      timedOut = true;
      child.kill('SIGTERM');
      setTimeout(() => child.kill('SIGKILL'), 10_000).unref();
    }, config.timeoutMs);

    child.stdout.on('data', (chunk: Buffer) => stdoutChunks.push(chunk));
    child.stderr.on('data', (chunk: Buffer) => stderrChunks.push(chunk));
    child.on('error', reject);
    child.on('close', (exitCode) => {
      clearTimeout(timeout);
      resolvePromise({
        stdout: Buffer.concat(stdoutChunks).toString('utf8'),
        stderr: Buffer.concat(stderrChunks).toString('utf8'),
        exitCode,
        timedOut,
      });
    });
  });
}

function emptyTaskResult(task: OdysseysTask, config: BenchmarkConfig, taskDir: string, durationMs: number, reason: string): TaskResult {
  return {
    run_dir: taskDir,
    task_id: task.task_id,
    level: task.level,
    task: task.confirmed_task,
    website: task.website,
    duration_ms: durationMs,
    outcome: 'error',
    grader_verdict: 'error',
    grader_reasoning: reason,
    grader_duration_ms: 0,
    session_id: '',
    provider: config.provider,
    tab_count: 0,
    message_count: 0,
    num_steps: 0,
    num_screenshots_sent: 0,
    rubric_scores: {},
    rubric_results: [],
    average_rubric_score: 0,
    perfect: false,
    error: reason,
    artifacts: {
      stdout: 'stdout.txt',
      stderr: 'stderr.txt',
      cliEvents: 'events.jsonl',
      trajectory: 'trajectory.txt',
      stepsJsonl: 'steps.jsonl',
      odysseysTrajectory: 'odysseys-trajectory.txt',
      result: 'result.json',
    },
  };
}

async function runTask(task: OdysseysTask, config: BenchmarkConfig): Promise<TaskResult> {
  const startTime = Date.now();
  const taskDir = join(config.outputDir, task.task_id);
  await mkdir(taskDir, { recursive: true });

  try {
    const cliResult = await runAsideCli(task, config, taskDir);
    await Promise.all([
      writeFile(join(taskDir, 'stdout.txt'), cliResult.stdout),
      writeFile(join(taskDir, 'stderr.txt'), cliResult.stderr),
      existsSync(join(taskDir, 'events.jsonl'))
        ? Promise.resolve()
        : writeFile(join(taskDir, 'events.jsonl'), ''),
    ]);

    const eventsText = await readFile(join(taskDir, 'events.jsonl'), 'utf8');
    const { steps, screenshots, screenshotFilenames } = generateOdysseysTrajectory(eventsText, config.maxSteps);
    const actionHistory = formatOdysseysActionHistory(steps);
    const trajectory = [
      `Task ID: ${task.task_id}`,
      `Level: ${task.level}`,
      `Website: ${task.website}`,
      '',
      '<task>',
      task.confirmed_task,
      '</task>',
      '',
      '<action_history>',
      actionHistory,
      '</action_history>',
      '',
      '<aside_cli_stdout>',
      stripAnsi(cliResult.stdout) || 'No stdout captured.',
      '</aside_cli_stdout>',
      '',
      stripAnsi(cliResult.stderr).trim()
        ? `<aside_cli_stderr>\n${stripAnsi(cliResult.stderr)}\n</aside_cli_stderr>`
        : '',
    ]
      .filter(Boolean)
      .join('\n');

    await Promise.all([
      writeFile(join(taskDir, 'steps.jsonl'), serializeOdysseysStepsJsonl(steps)),
      writeFile(join(taskDir, 'odysseys-trajectory.txt'), actionHistory),
      writeFile(join(taskDir, 'trajectory.txt'), trajectory),
      writeScreenshots(taskDir, screenshots, screenshotFilenames),
    ]);

    const durationMs = Date.now() - startTime;
    const cliError =
      cliResult.timedOut || cliResult.exitCode !== 0
        ? cliResult.timedOut
          ? `Aside CLI timed out after ${Math.round(config.timeoutMs / 1000)}s`
          : `Aside CLI exited with code ${cliResult.exitCode}`
        : undefined;

    const gradeResult = cliError
      ? {
          verdict: cliResult.timedOut ? ('fail' as const) : ('error' as const),
          reasoning: cliError,
          durationMs: 0,
          rubricScores: {},
          rubricResults: [],
          averageRubricScore: 0,
          perfect: false,
          ...(cliResult.timedOut ? {} : { error: cliError }),
        }
      : await gradeTaskResult(task, join(taskDir, 'odysseys-trajectory.txt'), config, screenshots);

    const result: TaskResult = {
      run_dir: taskDir,
      task_id: task.task_id,
      level: task.level,
      task: task.confirmed_task,
      website: task.website,
      duration_ms: durationMs,
      outcome: gradeResult.verdict === 'pass' ? 'success' : gradeResult.verdict === 'fail' ? 'failure' : 'error',
      grader_verdict: gradeResult.verdict,
      grader_reasoning: gradeResult.reasoning,
      grader_duration_ms: gradeResult.durationMs,
      session_id: '',
      provider: config.provider,
      tab_count: 0,
      message_count: steps.length,
      num_steps: steps.length,
      num_screenshots_sent: screenshots.length,
      rubric_scores: gradeResult.rubricScores,
      rubric_results: gradeResult.rubricResults,
      average_rubric_score: gradeResult.averageRubricScore,
      perfect: gradeResult.perfect,
      ...(gradeResult.error && { error: gradeResult.error }),
      artifacts: {
        stdout: 'stdout.txt',
        stderr: 'stderr.txt',
        cliEvents: 'events.jsonl',
        trajectory: 'trajectory.txt',
        stepsJsonl: 'steps.jsonl',
        odysseysTrajectory: 'odysseys-trajectory.txt',
        result: 'result.json',
        ...(screenshots.length && { screenshotsDir: 'screenshots' }),
      },
    };

    await writeFile(join(taskDir, 'result.json'), JSON.stringify(result, null, 2));
    await writeFile(join(taskDir, 'result.txt'), `${result.average_rubric_score}\n`);
    return result;
  } catch (error) {
    const result = emptyTaskResult(
      task,
      config,
      taskDir,
      Date.now() - startTime,
      error instanceof Error ? error.message : String(error),
    );
    await writeFile(join(taskDir, 'result.json'), JSON.stringify(result, null, 2)).catch(() => undefined);
    await writeFile(join(taskDir, 'result.txt'), '0\n').catch(() => undefined);
    return result;
  }
}

function levelSummary(results: TaskResult[]): LevelSummary {
  const totalRubrics = results.reduce((sum, result) => sum + Object.keys(result.rubric_scores).length, 0);
  const scoreSum = results.reduce(
    (sum, result) => sum + Object.values(result.rubric_scores).reduce<number>((inner, score) => inner + score, 0),
    0,
  );
  const perfectTasks = results.filter((result) => result.perfect).length;
  const efficiencyTerms = results
    .filter((result) => result.num_steps > 0)
    .map((result) => result.average_rubric_score / result.num_steps);
  const trajectoryEfficiency =
    efficiencyTerms.length > 0 ? efficiencyTerms.reduce((sum, value) => sum + value, 0) / efficiencyTerms.length : 0;

  return {
    total_tasks: results.length,
    total_rubrics: totalRubrics,
    average_rubric_score: totalRubrics > 0 ? Math.round((scoreSum / totalRubrics) * 10_000) / 10_000 : 0,
    perfect_tasks: perfectTasks,
    perfect_task_rate: results.length > 0 ? Math.round((perfectTasks / results.length) * 10_000) / 10_000 : 0,
    trajectory_efficiency: Math.round(trajectoryEfficiency * 1_000_000) / 1_000_000,
    trajectory_efficiency_x100: Math.round(trajectoryEfficiency * 100 * 10_000) / 10_000,
  };
}

function buildSummary(results: TaskResult[], config: BenchmarkConfig, totalDurationMs: number): RunSummary {
  const all = levelSummary(results);
  const byLevel: RunSummary['by_level'] = {};
  for (const level of VALID_LEVELS) {
    const levelResults = results.filter((result) => result.level === level);
    if (levelResults.length) byLevel[level] = levelSummary(levelResults);
  }

  return {
    total_tasks: results.length,
    ran: results.length,
    total_rubrics: all.total_rubrics,
    average_rubric_score: all.average_rubric_score,
    perfect_tasks: all.perfect_tasks,
    perfect_task_rate: all.perfect_task_rate,
    failed: results.filter((result) => result.grader_verdict === 'fail').length,
    errors: results.filter((result) => result.grader_verdict === 'error').length,
    skipped: 0,
    errored_tasks: results.filter((result) => result.error).length,
    trajectory_efficiency: all.trajectory_efficiency,
    trajectory_efficiency_x100: all.trajectory_efficiency_x100,
    by_level: byLevel,
    avg_duration_ms:
      results.length > 0
        ? Math.round(results.reduce((sum, result) => sum + result.duration_ms, 0) / results.length)
        : 0,
    total_duration_ms: totalDurationMs,
    model: config.modelId,
    provider: config.provider,
    thinking_level: config.thinkingLevel,
    fast_mode: false,
    concurrency: config.concurrency,
    grader_model: config.graderModel,
    max_steps: config.maxSteps,
    timestamp: new Date().toISOString(),
  };
}

function toEvalTaskResult(result: TaskResult): OdysseysEvalTaskResult {
  return {
    run_dir: result.run_dir,
    task_id: result.task_id,
    task: result.task,
    num_steps: result.num_steps,
    num_screenshots_sent: result.num_screenshots_sent,
    rubric_scores: result.rubric_scores,
    rubric_results: result.rubric_results,
    average_rubric_score: result.average_rubric_score,
    perfect: result.perfect,
    ...(result.error && { error: result.error }),
  };
}

function toEvalSummary(summary: RunSummary) {
  return {
    total_tasks: summary.total_tasks,
    total_rubrics: summary.total_rubrics,
    average_rubric_score: summary.average_rubric_score,
    perfect_tasks: summary.perfect_tasks,
    perfect_task_rate: summary.perfect_task_rate,
    trajectory_efficiency: summary.trajectory_efficiency,
    trajectory_efficiency_x100: summary.trajectory_efficiency_x100,
    errored_tasks: summary.errored_tasks,
    ...(Object.keys(summary.by_level).length && { by_level: summary.by_level }),
  };
}

function printSummary(summary: RunSummary): void {
  console.log('\n' + '='.repeat(60));
  console.log('ODYSSEYS RESULTS');
  console.log('='.repeat(60));
  console.log(`Model: ${summary.provider}/${summary.model} | Thinking: ${summary.thinking_level}`);
  console.log(`Grader: ${summary.grader_model}`);
  console.log(`Max steps: ${summary.max_steps}`);
  console.log(`Concurrency: ${summary.concurrency}`);
  console.log(`Total time: ${(summary.total_duration_ms / 1000 / 60).toFixed(1)} min`);
  console.log(`Avg per task: ${(summary.avg_duration_ms / 1000).toFixed(1)}s`);
  console.log('');
  console.log(
    `Rubric Avg: ${(summary.average_rubric_score * 100).toFixed(1)}% over ${summary.total_rubrics} rubric(s)`,
  );
  console.log(
    `Perfect: ${summary.perfect_tasks}/${summary.ran} (${(summary.perfect_task_rate * 100).toFixed(1)}%) | Traj. Eff.: ${summary.trajectory_efficiency_x100.toFixed(3)} x100`,
  );
  console.log('');

  for (const [level, stats] of Object.entries(summary.by_level).sort(([a], [b]) => a.localeCompare(b))) {
    console.log(
      `  ${level.padEnd(8)} avg ${(stats.average_rubric_score * 100).toFixed(1)}% | perfect ${stats.perfect_tasks}/${stats.total_tasks} (${(stats.perfect_task_rate * 100).toFixed(1)}%) | eff ${stats.trajectory_efficiency_x100.toFixed(3)} x100`,
    );
  }

  if (summary.errors > 0) console.log(`\n${summary.errors} tasks had errors`);
  console.log('='.repeat(60));
}

async function main(): Promise<void> {
  const config = parseConfig(process.argv.slice(2));
  await mkdir(config.outputDir, { recursive: true });

  const tasks = loadTasks(config);
  if (tasks.length === 0) throw new Error('No tasks match the given filters.');

  if (config.grade && !config.googleApiKey) {
    console.warn('No Gemini API key found; grading will emit error results. Use --no-grade to skip intentionally.');
  }

  console.log(`Odysseys Benchmark - ${tasks.length} tasks`);
  console.log(
    `Model: ${config.provider}/${config.modelId} | Thinking: ${config.thinkingLevel} | Concurrency: ${config.concurrency}`,
  );
  console.log(`Grader: ${config.graderModel}`);
  console.log(`Max steps: ${config.maxSteps}`);
  console.log(`Aside CLI: ${[config.asideCommand, ...config.asideArgs, 'exec'].join(' ')}`);
  console.log(`Output: ${config.outputDir}`);
  if (config.level) console.log(`Level: ${config.level}`);
  if (config.taskListJsonPath) console.log(`Task list: ${config.taskListJsonPath}`);
  console.log('');

  const runStart = Date.now();
  let completed = 0;
  const results = await runWithConcurrency(tasks, config.concurrency, async (task) => {
    const result = await runTask(task, config);
    completed += 1;
    const prefix = `[${completed}/${tasks.length}]`;
    const time = `${(result.duration_ms / 1000).toFixed(1)}s`;

    if (result.grader_verdict === 'pass') {
      console.log(`${prefix} pass ${task.task_id} (${task.level}) - avg ${result.average_rubric_score.toFixed(2)} - ${time}`);
    } else if (result.grader_verdict === 'error') {
      console.log(`${prefix} error ${task.task_id} (${task.level}) - ${result.grader_reasoning.slice(0, 80)} - ${time}`);
    } else {
      console.log(`${prefix} fail ${task.task_id} (${task.level}) - avg ${result.average_rubric_score.toFixed(2)} - ${time}`);
    }

    return result;
  });

  const summary = buildSummary(results, config, Date.now() - runStart);
  const evalPayload = {
    summary: toEvalSummary(summary),
    tasks: results.map(toEvalTaskResult),
  };

  await writeFile(join(config.outputDir, 'run_summary.json'), JSON.stringify(summary, null, 2));
  await writeFile(
    join(config.outputDir, 'eval_results_full_traj_per_rubric.json'),
    JSON.stringify(evalPayload, null, 2),
  );
  printSummary(summary);
}

process.on('uncaughtException', (error) => {
  console.error('[FATAL] Uncaught exception:', error);
  process.exit(1);
});

process.on('unhandledRejection', (reason) => {
  console.error('[FATAL] Unhandled rejection:', reason);
  process.exit(1);
});

main().catch((error) => {
  console.error('Fatal error:', error instanceof Error ? error.message : String(error));
  process.exit(1);
});
