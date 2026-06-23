# BU Bench V1 Aside CLI Runner

Standalone Node runner for BU Bench V1. It shells out to the Aside CLI and does not import or depend on the daemon package.

## Setup

Prerequisites:

- `aside` CLI available on `PATH`

```bash
pnpm install
```

Set `GOOGLE_GENERATIVE_AI_API_KEY` or `GOOGLE_API_KEY` for grading. A local `.env` file in this package is also supported.

## Usage

```bash
pnpm run run -- [options]
```

Options match the old BU Bench runner where possible:

- `--provider <name>`: model provider, default `openai`
- `--model <name>`: model id, default `gpt-5.5`
- `--thinking <level>`: `off|minimal|low|medium|high|xhigh`, default `high`
- `--concurrency <n>`: parallel task count, default `6`
- `--limit <n>`: run first N matched tasks
- `--category <name>`: filter by BU Bench category
- `--task <id>`: run one task
- `--task-list-json <path>`: run task ids from a JSON string array
- `--output-dir <path>`: output directory
- `--resume`: skip tasks with existing `result.json`
- `--dataset <path>`: encoded dataset path, default `BU-Bench-v1-dataset.json.enc`
- `--timeout-minutes <n>`: per-task timeout, default `30`
- `--no-grade`: skip Gemini grading
- `--aside-command <command>`: executable to run, default `aside`
- `--aside-args <args>`: whitespace-separated args inserted before `exec`

Each task writes `stdout.txt`, `stderr.txt`, `events.jsonl`, `trajectory.txt`, and `result.json`.
