import { spawn } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';

import { z } from 'zod';

import { gradeTaskResult } from './grader.js';
import {
  THINKING_LEVELS,
  VALID_CATEGORIES,
  type BenchmarkConfig,
  type BuBenchCategory,
  type BuBenchTask,
  type GraderVerdict,
  type RunSummary,
  type TaskResult,
  type ThinkingLevel,
} from './types.js';

const DATASET_PATH = resolve(import.meta.dirname, '..', 'BU-Bench-v1-dataset.json.enc');
const DEFAULT_TIMEOUT_MS = 30 * 60_000;

const BuBenchTaskSchema = z.object({
  task_id: z.string(),
  confirmed_task: z.string(),
  category: z.enum(VALID_CATEGORIES),
  answer: z.string().optional(),
});

const JsonRecordSchema = z.record(z.string(), z.unknown());

function printHelp(): never {
  console.log(`BU Bench V1 Aside CLI Runner

Usage: pnpm run run -- [options]

Options:
  --provider <name>          Model provider (default: openai)
  --model <name>             Model ID (default: gpt-5.5)
  --thinking <level>         Thinking level: ${THINKING_LEVELS.join(', ')} (default: high)
  --concurrency <n>          Parallel task count (default: 6)
  --limit <n>                Run first N tasks only
  --category <name>          Filter by category: ${VALID_CATEGORIES.join(', ')}
  --task <id>                Run single task by ID
  --task-list-json <path>    Run only task IDs listed in a JSON array file
  --output-dir <path>        Output directory (default: results/{timestamp})
  --resume                   Skip tasks with existing results
  --dataset <path>           Path to encoded dataset (default: BU-Bench-v1-dataset.json.enc)
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

function parseCategory(value: string): BuBenchCategory {
  if (VALID_CATEGORIES.includes(value as BuBenchCategory)) return value as BuBenchCategory;
  throw new Error(`Invalid category: ${value}`);
}

function splitArgs(value: string | undefined): string[] {
  return value?.trim() ? value.trim().split(/\s+/) : [];
}

function loadDotEnvValue(key: string): string | undefined {
  const envPath = join(import.meta.dirname, '..', '.env');
  if (!existsSync(envPath)) return undefined;

  const line = readFileSync(envPath, 'utf8')
    .split('\n')
    .find((candidate) => candidate.match(new RegExp(`^${key}=`)));
  const value = line?.slice(key.length + 1).trim();
  return value?.replace(/^["']|["']$/g, '') || undefined;
}

function loadGoogleApiKey(): string | undefined {
  return (
    process.env.GOOGLE_GENERATIVE_AI_API_KEY ??
    process.env.GOOGLE_API_KEY ??
    loadDotEnvValue('GOOGLE_GENERATIVE_AI_API_KEY') ??
    loadDotEnvValue('GOOGLE_API_KEY')
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
    resume: false,
    googleApiKey: loadGoogleApiKey(),
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
      case '--category':
        if (!next) throw new Error('Missing value for --category');
        config.category = parseCategory(next);
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

function loadTasks(config: BenchmarkConfig): BuBenchTask[] {
  // Store the dataset as base64 to prevent AI from training the data.
  const rawDataset = Buffer.from(readFileSync(config.datasetPath, 'utf8'), 'base64').toString('utf8');
  let tasks = z.array(BuBenchTaskSchema).parse(JSON.parse(rawDataset));

  if (config.taskListJsonPath) {
    const taskIds = new Set(loadTaskListJson(config.taskListJsonPath));
    tasks = tasks.filter((task) => taskIds.has(task.task_id));
  }
  if (config.taskId) tasks = tasks.filter((task) => task.task_id === config.taskId);
  if (config.category) tasks = tasks.filter((task) => task.category === config.category);
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

function formatTextContent(content: unknown): string {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';

  return content
    .map((part) => {
      const parsed = JsonRecordSchema.safeParse(part);
      if (!parsed.success) return '';
      if (parsed.data.type === 'text') return typeof parsed.data.text === 'string' ? parsed.data.text : '';
      if (parsed.data.type === 'image') return `[image ${String(parsed.data.mimeType ?? 'unknown')}]`;
      if (parsed.data.type === 'toolCall') return `[toolCall ${String(parsed.data.name ?? 'unknown')}]`;
      return '';
    })
    .filter(Boolean)
    .join('\n');
}

function formatCliEvent(line: string): string | undefined {
  const parsed = JsonRecordSchema.safeParse(JSON.parse(line));
  if (!parsed.success) return undefined;

  const event = parsed.data;
  if (event.type === 'tool_execution_start') {
    return `Tool: ${String(event.toolName ?? 'unknown')}\nArguments: ${JSON.stringify(event.args ?? {})}`;
  }

  if (event.type !== 'message_end') return undefined;

  const message = JsonRecordSchema.safeParse(event.message);
  if (!message.success) return undefined;

  const role = String(message.data.role ?? 'unknown');
  const text = formatTextContent(message.data.content).trim();
  if (!text) return undefined;

  if (role === 'toolResult') return `Tool result:\n${text}`;
  return `${role}:\n${text}`;
}

async function buildTrajectory(task: BuBenchTask, stdoutPath: string, stderrPath: string, eventPath: string): Promise<string> {
  const stdout = stripAnsi(await readFile(stdoutPath, 'utf8').catch(() => ''));
  const stderr = stripAnsi(await readFile(stderrPath, 'utf8').catch(() => ''));
  const events = await readFile(eventPath, 'utf8').catch(() => '');
  const eventText = events
    .split('\n')
    .filter(Boolean)
    .map((line) => {
      try {
        return formatCliEvent(line);
      } catch {
        return undefined;
      }
    })
    .filter((value): value is string => Boolean(value))
    .join('\n\n');

  return [
    `Task ID: ${task.task_id}`,
    `Category: ${task.category}`,
    '',
    '<task>',
    task.confirmed_task,
    '</task>',
    '',
    '<aside_cli_events>',
    eventText || 'No CLI event dump was captured.',
    '</aside_cli_events>',
    '',
    '<aside_cli_stdout>',
    stdout || 'No stdout captured.',
    '</aside_cli_stdout>',
    '',
    stderr.trim() ? `<aside_cli_stderr>\n${stderr}\n</aside_cli_stderr>` : '',
  ]
    .filter(Boolean)
    .join('\n');
}

interface AsideCliResult {
  stdout: string;
  stderr: string;
  exitCode: number | null;
  timedOut: boolean;
}

async function runAsideCli(task: BuBenchTask, config: BenchmarkConfig, taskDir: string): Promise<AsideCliResult> {
  const args = [
    ...config.asideArgs,
    'exec',
    '--model',
    `${config.provider}/${config.modelId}`,
    '--thinking',
    config.thinkingLevel,
    '--log-dump',
    join(taskDir, 'events.jsonl'),
    task.confirmed_task,
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

function errorResult(task: BuBenchTask, config: BenchmarkConfig, durationMs: number, reason: string): TaskResult {
  return {
    task_id: task.task_id,
    category: task.category,
    task: task.confirmed_task,
    durationMs,
    outcome: 'error',
    graderVerdict: 'error',
    graderReasoning: reason,
    agentStatus: 'error',
    graderDurationMs: 0,
    sessionId: '',
    model: {
      provider: config.provider,
      modelId: config.modelId,
      thinkingLevel: config.thinkingLevel,
      fastMode: false,
    },
    provider: config.provider,
    tabCount: 0,
    messageCount: 0,
    artifacts: {
      stdout: 'stdout.txt',
      stderr: 'stderr.txt',
      cliEvents: 'events.jsonl',
      trajectory: 'trajectory.txt',
      result: 'result.json',
    },
  };
}

async function runTask(task: BuBenchTask, config: BenchmarkConfig): Promise<TaskResult> {
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

    const trajectory = await buildTrajectory(
      task,
      join(taskDir, 'stdout.txt'),
      join(taskDir, 'stderr.txt'),
      join(taskDir, 'events.jsonl'),
    );
    await writeFile(join(taskDir, 'trajectory.txt'), trajectory);

    const durationMs = Date.now() - startTime;
    const cliError =
      cliResult.timedOut || cliResult.exitCode !== 0
        ? cliResult.timedOut
          ? `Aside CLI timed out after ${Math.round(config.timeoutMs / 1000)}s`
          : `Aside CLI exited with code ${cliResult.exitCode}`
        : undefined;

    const gradeResult = cliError
      ? {
          verdict: (cliResult.timedOut ? 'fail' : 'error') as GraderVerdict,
          reasoning: cliError,
          durationMs: 0,
        }
      : await gradeTaskResult(task, join(taskDir, 'trajectory.txt'), config);

    const outcome =
      gradeResult.verdict === 'pass'
        ? 'success'
        : gradeResult.verdict === 'fail'
          ? 'failure'
          : gradeResult.verdict;

    const result: TaskResult = {
      task_id: task.task_id,
      category: task.category,
      task: task.confirmed_task,
      durationMs,
      outcome,
      graderVerdict: gradeResult.verdict,
      graderReasoning: gradeResult.reasoning,
      agentStatus: outcome,
      graderDurationMs: gradeResult.durationMs,
      sessionId: '',
      model: {
        provider: config.provider,
        modelId: config.modelId,
        thinkingLevel: config.thinkingLevel,
        fastMode: false,
      },
      provider: config.provider,
      tabCount: 0,
      messageCount: 0,
      artifacts: {
        stdout: 'stdout.txt',
        stderr: 'stderr.txt',
        cliEvents: 'events.jsonl',
        trajectory: 'trajectory.txt',
        result: 'result.json',
      },
    };
    await writeFile(join(taskDir, 'result.json'), JSON.stringify(result, null, 2));
    return result;
  } catch (error) {
    const result = errorResult(
      task,
      config,
      Date.now() - startTime,
      error instanceof Error ? error.message : String(error),
    );
    await writeFile(join(taskDir, 'result.json'), JSON.stringify(result, null, 2)).catch(() => undefined);
    return result;
  }
}

function buildSummary(results: TaskResult[], config: BenchmarkConfig, totalDurationMs: number): RunSummary {
  const passed = results.filter((result) => result.graderVerdict === 'pass').length;
  const failed = results.filter((result) => result.graderVerdict === 'fail').length;
  const impossible = results.filter((result) => result.graderVerdict === 'impossible').length;
  const errors = results.filter((result) => result.graderVerdict === 'error').length;
  const ran = results.length;
  const ranExcludingImpossible = ran - impossible;

  const byCategory: RunSummary['byCategory'] = {};
  for (const result of results) {
    byCategory[result.category] ??= { total: 0, passed: 0, failed: 0, impossible: 0, errors: 0 };
    const category = byCategory[result.category]!;
    category.total += 1;
    if (result.graderVerdict === 'pass') category.passed += 1;
    else if (result.graderVerdict === 'fail') category.failed += 1;
    else if (result.graderVerdict === 'impossible') category.impossible += 1;
    else category.errors += 1;
  }

  return {
    total: ran,
    ran,
    passed,
    failed,
    impossible,
    errors,
    skipped: 0,
    byCategory,
    passRate: ran > 0 ? passed / ran : 0,
    passRateExcludingImpossible: ranExcludingImpossible > 0 ? passed / ranExcludingImpossible : 0,
    avgDurationMs: ran > 0 ? Math.round(results.reduce((sum, result) => sum + result.durationMs, 0) / ran) : 0,
    totalDurationMs,
    model: config.modelId,
    provider: config.provider,
    thinkingLevel: config.thinkingLevel,
    fastMode: false,
    concurrency: config.concurrency,
    timestamp: new Date().toISOString(),
  };
}

function printSummary(summary: RunSummary): void {
  console.log('\n' + '='.repeat(60));
  console.log('BU BENCH V1 RESULTS');
  console.log('='.repeat(60));
  console.log(`Model: ${summary.provider}/${summary.model} | Thinking: ${summary.thinkingLevel}`);
  console.log(`Concurrency: ${summary.concurrency}`);
  console.log(`Total time: ${(summary.totalDurationMs / 1000 / 60).toFixed(1)} min`);
  console.log(`Avg per task: ${(summary.avgDurationMs / 1000).toFixed(1)}s`);
  console.log('');
  console.log(`Overall: ${summary.passed}/${summary.ran} passed (${(summary.passRate * 100).toFixed(1)}%)`);
  if (summary.impossible > 0) {
    const excludingImpossible = summary.ran - summary.impossible;
    console.log(
      `Excluding impossible: ${summary.passed}/${excludingImpossible} (${(summary.passRateExcludingImpossible * 100).toFixed(1)}%)`,
    );
  }
  console.log('');

  for (const [category, stats] of Object.entries(summary.byCategory).sort(([a], [b]) => a.localeCompare(b))) {
    const pct = stats.total > 0 ? ((stats.passed / stats.total) * 100).toFixed(1) : '0.0';
    console.log(
      `  ${category.padEnd(18)} ${stats.passed}/${stats.total} passed (${pct}%) | ${stats.failed} failed | ${stats.impossible} impossible | ${stats.errors} errors`,
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
    console.warn('No Google API key found; grading will emit error verdicts. Use --no-grade to skip intentionally.');
  }

  console.log(`BU Bench V1 - ${tasks.length} tasks`);
  console.log(
    `Model: ${config.provider}/${config.modelId} | Thinking: ${config.thinkingLevel} | Concurrency: ${config.concurrency}`,
  );
  console.log(`Aside CLI: ${[config.asideCommand, ...config.asideArgs, 'exec'].join(' ')}`);
  console.log(`Output: ${config.outputDir}`);
  if (config.category) console.log(`Category: ${config.category}`);
  if (config.taskListJsonPath) console.log(`Task list: ${config.taskListJsonPath}`);
  console.log('');

  const runStart = Date.now();
  let completed = 0;
  const results = await runWithConcurrency(tasks, config.concurrency, async (task) => {
    const result = await runTask(task, config);
    completed += 1;
    const prefix = `[${completed}/${tasks.length}]`;
    const time = `${(result.durationMs / 1000).toFixed(1)}s`;

    if (result.graderVerdict === 'pass') console.log(`${prefix} PASS ${task.task_id} [${task.category}] - ${time}`);
    else if (result.graderVerdict === 'impossible')
      console.log(`${prefix} IMPOSSIBLE ${task.task_id} [${task.category}] - ${time}`);
    else if (result.graderVerdict === 'error')
      console.log(`${prefix} ERROR ${task.task_id} [${task.category}] - ${result.graderReasoning.slice(0, 80)} - ${time}`);
    else console.log(`${prefix} FAIL ${task.task_id} [${task.category}] - ${time}`);

    return result;
  });

  const summary = buildSummary(results, config, Date.now() - runStart);
  await writeFile(join(config.outputDir, 'run_summary.json'), JSON.stringify(summary, null, 2));
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
