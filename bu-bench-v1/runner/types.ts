export const VALID_CATEGORIES = ['WebBenchREAD', 'OM2W2', 'InteractionTests', 'GAIA', 'BrowseComp'] as const;

export const THINKING_LEVELS = ['off', 'minimal', 'low', 'medium', 'high', 'xhigh'] as const;

export type BuBenchCategory = (typeof VALID_CATEGORIES)[number];
export type ThinkingLevel = (typeof THINKING_LEVELS)[number];
export type GraderVerdict = 'pass' | 'fail' | 'impossible' | 'error';

export interface BuBenchTask {
  task_id: string;
  confirmed_task: string;
  category: BuBenchCategory;
  answer?: string;
}

export interface ModelSelection {
  provider: string;
  modelId: string;
  thinkingLevel: ThinkingLevel;
  fastMode: false;
}

export interface TaskResult {
  task_id: string;
  category: BuBenchCategory;
  task: string;
  outcome: 'success' | 'failure' | 'impossible' | 'error';
  graderVerdict: GraderVerdict;
  graderReasoning: string;
  agentStatus: string;
  sessionId: string;
  model: ModelSelection;
  provider: string;
  durationMs: number;
  graderDurationMs: number;
  tabCount: number;
  messageCount: number;
  artifacts: {
    stdout: string;
    stderr: string;
    cliEvents: string;
    trajectory: string;
    result: string;
  };
}

export interface RunSummary {
  total: number;
  ran: number;
  passed: number;
  failed: number;
  impossible: number;
  errors: number;
  skipped: number;
  byCategory: Record<string, { total: number; passed: number; failed: number; impossible: number; errors: number }>;
  passRate: number;
  passRateExcludingImpossible: number;
  avgDurationMs: number;
  totalDurationMs: number;
  model: string;
  provider: string;
  thinkingLevel: ThinkingLevel;
  fastMode: false;
  concurrency: number;
  timestamp: string;
}

export interface BenchmarkConfig {
  provider: string;
  modelId: string;
  thinkingLevel: ThinkingLevel;
  concurrency: number;
  outputDir: string;
  datasetPath: string;
  taskId?: string;
  taskListJsonPath?: string;
  category?: BuBenchCategory;
  limit?: number;
  resume: boolean;
  googleApiKey?: string;
  grade: boolean;
  asideCommand: string;
  asideArgs: string[];
  timeoutMs: number;
}

export interface GradeResult {
  verdict: GraderVerdict;
  reasoning: string;
  durationMs: number;
}
