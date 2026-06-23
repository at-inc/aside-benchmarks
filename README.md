# Aside benchmark results

Evaluates the [Aside](https://asidehq.com) browser agent on
three open-web browser-agent benchmarks:
[Online-Mind2Web](https://github.com/OSU-NLP-Group/Online-Mind2Web),
[Odysseys](https://github.com/ljang0/Odysseys), and
[BU Bench V1](https://github.com/browser-use/benchmark). Together these suites
cover short and long horizon web navigation, live-website task completion,
rubric-based partial-progress scoring, and browser automation tasks drawn from
multiple public benchmark sources.

## Notes

- The benchmark tasks were executed against live websites, so outcomes can
  change as websites update their content, flows, inventory, authentication,
  or anti-automation behavior.
- Impossible tasks are reported separately from failures when the target
  website no longer exposes the requested state or item.

## Online-Mind2Web

Online-Mind2Web contains 300 diverse online tasks across 136 popular websites.
It is designed to evaluate web agents in a real-world online environment rather
than only against frozen or simulated webpages.

![Benchmark Results](./mind2web/charts.png)

| Model | Tasks | Passed | Failed | Impossible | Pass Rate | Pass Rate (excl. impossible) |
|-------|-------|--------|--------|------------|-----------|------------------------------|
| `gpt-5.5` (openai-codex) | 300 | 297 | 2 | 1 | **99.0%** | **99.3%** |

Detailed results for each task are in [`mind2web/results/`](./mind2web/results/).

### Tasks not completed

3 tasks were not completed - 1 is impossible due to current site inventory,
and 2 were genuine failures:

| Task | Verdict | Reason |
|------|---------|--------|
| Send a Dillard's "Merry Christmas" eGift Card | impossible | Site no longer offers a "Merry Christmas" eGift card design; Dec 25 delivery also disabled |
| Add a used Apple Mac Studio M4 Max 16-core to cart | fail | No M4 Max 16-core Mac Studio in stock; not purchasable online |
| Search for 33-49" QLED 240Hz gaming monitor $1000-$2000 | fail | Failed |

Excluding the 1 impossible task: **297/299 = 99.3%**.

### By difficulty

| Level | Passed | Total | Pass Rate |
|-------|--------|-------|-----------|
| easy | 80 | 80 | 100% |
| medium | 142 | 143 | 99.3% |
| hard | 75 | 77 | 97.4% |

### Configuration

| Setting | Value |
|---------|-------|
| Model | `gpt-5.5` |
| Provider | `openai-codex` |
| Thinking | `high` |
| Fast mode | `true` |
| Concurrency | 3-6 |
| Timeout | 900s per task |
| Grader | `gpt-5.4` (automated LLM grading) |

## Odysseys

[Odysseys](https://github.com/ljang0/Odysseys) evaluates long-horizon web
agents on 200 live-web tasks derived from real browsing sessions. Unlike a
binary success benchmark, Odysseys grades each task with multiple
task-specific rubrics, so the most informative result surface includes both
perfect-task rate and partial-progress rubric scores.

The included Aside evaluation is a `gpt-5.5` / `openai-codex` run with
`high` thinking, fast mode enabled, `gemini-3.1-flash-lite` as grader, and a
200-step maximum trajectory budget. Results are stored in
[`odysseys/results/260528-gpt55/`](./odysseys/results/260528-gpt55/), with
runner code in [`odysseys/runner/`](./odysseys/runner/).

| Metric | Value |
|--------|-------|
| Tasks evaluated | 200 / 200 |
| Perfect tasks | 151 / 200 (**75.5%**) |
| Failed tasks | 49 / 200 |
| Rubric items passed | 1,050 / 1,182 (**88.8%**) |
| Task-average rubric score | **86.5%** |
| Errors | 0 |

### Odysseys by difficulty

| Level | Tasks | Perfect tasks | Perfect-task rate | Rubric items passed | Rubric pass rate | Task-average rubric score |
|-------|-------|---------------|-------------------|---------------------|------------------|---------------------------|
| easy | 45 | 38 | 84.4% | 200 / 213 | 93.9% | 93.8% |
| medium | 46 | 40 | 87.0% | 247 / 256 | 96.5% | 92.5% |
| hard | 109 | 73 | 67.0% | 603 / 713 | 84.6% | 80.9% |

## BU Bench V1

[BU Bench V1](https://github.com/browser-use/benchmark) contains 100
hand-selected browser automation tasks. The benchmark combines tasks from
WebBenchREAD, Online-Mind2Web 2, InteractionTests, GAIA, and BrowseComp, with
20 tasks in each category. The included Aside artifacts contain two complete
100-task runs in [`bu-bench-v1/results/`](./bu-bench-v1/results/), with
runner code in [`bu-bench-v1/runner/`](./bu-bench-v1/runner/).

| Run | Provider | Model | Tasks | Passed | Failed | Impossible | Pass rate | Pass rate excl. impossible |
|-----|----------|-------|-------|--------|--------|------------|-----------|----------------------------|
| [`gpt55-20260524`](./bu-bench-v1/results/gpt55-20260524/run_summary.json) | `openai` | `gpt-5.5` | 100 | 93 | 6 | 1 | **93.0%** | **93.9%** |
| [`kimi2.6-260601`](./bu-bench-v1/results/kimi2.6-260601/run_summary.json) | `aside` | `kimi-k2.6` | 100 | 88 | 12 | 0 | **88.0%** | **88.0%** |

Both BU Bench V1 runs used `high` thinking, fast mode, and concurrency 6. The
`gpt-5.5` run has the higher aggregate score, with all WebBenchREAD and OM2W2
tasks passing and most remaining failures concentrated in GAIA and BrowseComp.
The `kimi-k2.6` run also passed all OM2W2 and InteractionTests tasks, but lost
more tasks in GAIA and BrowseComp.

### BU Bench V1 by category

| Category | `gpt-5.5` passed | `gpt-5.5` failed | `gpt-5.5` impossible | `kimi-k2.6` passed | `kimi-k2.6` failed |
|----------|------------------|------------------|----------------------|--------------------|--------------------|
| WebBenchREAD | 20 / 20 | 0 | 0 | 19 / 20 | 1 |
| OM2W2 | 20 / 20 | 0 | 0 | 20 / 20 | 0 |
| InteractionTests | 19 / 20 | 1 | 0 | 20 / 20 | 0 |
| GAIA | 17 / 20 | 3 | 0 | 14 / 20 | 6 |
| BrowseComp | 17 / 20 | 2 | 1 | 15 / 20 | 5 |


## Citation

If you use these benchmark results, cite the benchmark sources as well as this
repository's run artifacts. Online-Mind2Web and Odysseys have paper citations;
BU Bench V1 is cited here as its public benchmark repository.

```bibtex
@article{xue2025illusionprogressassessingcurrent,
  title={An Illusion of Progress? Assessing the Current State of Web Agents},
  author={Tianci Xue and Weijian Qi and Tianneng Shi and Chan Hee Song and
          Boyu Gou and Dawn Song and Huan Sun and Yu Su},
  year={2025},
  eprint={2504.01382},
  archivePrefix={arXiv},
  primaryClass={cs.AI},
}

@article{jang2026odysseys,
  title={Odysseys: Benchmarking Web Agents on Realistic Long Horizon Tasks},
  author={Jang, Lawrence Keunho and Koh, Jing Yu and Fried, Daniel and
          Salakhutdinov, Ruslan},
  year={2026},
  eprint={2604.24964},
  archivePrefix={arXiv},
  primaryClass={cs.AI},
}

@misc{browseruse2026bubenchv1,
  title={BU Bench V1},
  author={{Browser Use}},
  year={2026},
  howpublished={\url{https://github.com/browser-use/benchmark}},
  note={100 hand-selected tasks for evaluating browser automation agents},
}
```
