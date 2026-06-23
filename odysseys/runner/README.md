# Odysseys Aside CLI Runner

Standalone Node runner for Odysseys. It shells out to the Aside CLI and does not import or depend on the daemon package.

## Setup

Prerequisites:

- `aside` CLI available on `PATH`

```bash
pnpm install
```

Set `GEMINI_API_KEY`, `GOOGLE_API_KEY`, or `GOOGLE_GENERATIVE_AI_API_KEY` for grading. A local `.env` file in this package is also supported.

## Usage

```bash
pnpm run run -- [options]
```

Options:

- `--provider <name>`: model provider, default `openai`
- `--model <name>`: model id, default `gpt-5.5`
- `--thinking <level>`: `off|minimal|low|medium|high|xhigh`, default `high`
- `--concurrency <n>`: parallel task count, default `6`
- `--limit <n>`: run first N matched tasks
- `--level <easy|medium|hard>`: filter by difficulty
- `--task <id>`: run one task
- `--task-list-json <path>`: run task ids from a JSON string array
- `--output-dir <path>`: output directory
- `--resume`: skip tasks with existing `result.json`
- `--dataset <path>`: encoded dataset path, default `Odysseys-dataset.json.enc`
- `--grader-model <name>`: Gemini grader model, default `gemini-3.1-flash-lite`
- `--max-steps <n>`: max generated trajectory steps for grading, default `200`
- `--timeout-minutes <n>`: per-task timeout, default `30`
- `--no-grade`: skip Gemini grading
- `--aside-command <command>`: executable to run, default `aside`
- `--aside-args <args>`: whitespace-separated args inserted before `exec`

Each task writes `stdout.txt`, `stderr.txt`, `events.jsonl`, `steps.jsonl`, `odysseys-trajectory.txt`, `result.txt`, and `result.json`.
