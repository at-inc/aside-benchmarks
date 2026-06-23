export const VALID_LEVELS = ['easy', 'medium', 'hard'] as const;
export const THINKING_LEVELS = ['off', 'minimal', 'low', 'medium', 'high', 'xhigh'] as const;

export type OdysseysLevel = (typeof VALID_LEVELS)[number];
export type ThinkingLevel = (typeof THINKING_LEVELS)[number];

export interface OdysseysRubric {
  requirement: string;
  verification: string;
}

export interface OdysseysTask {
  task_id: string;
  confirmed_task: string;
  website: string;
  reference_length: number;
  level: OdysseysLevel;
  rubrics: Record<string, OdysseysRubric>;
  categories: string[];
  num_categories: number;
}

export interface RubricResult {
  rubric_id: string;
  requirement: string;
  verification: string;
  score: 0 | 1;
  success: boolean;
  final_reasoning: string;
}

export interface GradeResult {
  verdict: 'pass' | 'fail' | 'error';
  reasoning: string;
  durationMs: number;
  rubricScores: Record<string, 0 | 1>;
  rubricResults: RubricResult[];
  averageRubricScore: number;
  perfect: boolean;
  error?: string;
}

export interface TaskResult {
  run_dir: string;
  task_id: string;
  level: OdysseysLevel;
  task: string;
  website: string;
  outcome: 'success' | 'failure' | 'error';
  grader_verdict: 'pass' | 'fail' | 'error';
  grader_reasoning: string;
  session_id: string;
  provider: string;
  duration_ms: number;
  grader_duration_ms: number;
  tab_count: number;
  message_count: number;
  num_steps: number;
  num_screenshots_sent: number;
  rubric_scores: Record<string, 0 | 1>;
  rubric_results: RubricResult[];
  average_rubric_score: number;
  perfect: boolean;
  error?: string;
  artifacts: {
    stdout: string;
    stderr: string;
    cliEvents: string;
    trajectory: string;
    stepsJsonl: string;
    odysseysTrajectory: string;
    result: string;
    screenshotsDir?: string;
  };
}

export interface LevelSummary {
  total_tasks: number;
  total_rubrics: number;
  average_rubric_score: number;
  perfect_tasks: number;
  perfect_task_rate: number;
  trajectory_efficiency: number;
  trajectory_efficiency_x100: number;
}

export interface RunSummary {
  total_tasks: number;
  ran: number;
  total_rubrics: number;
  average_rubric_score: number;
  perfect_tasks: number;
  perfect_task_rate: number;
  failed: number;
  errors: number;
  skipped: number;
  errored_tasks: number;
  trajectory_efficiency: number;
  trajectory_efficiency_x100: number;
  by_level: Partial<Record<OdysseysLevel, LevelSummary>>;
  avg_duration_ms: number;
  total_duration_ms: number;
  model: string;
  provider: string;
  thinking_level: ThinkingLevel;
  fast_mode: false;
  concurrency: number;
  grader_model: string;
  max_steps: number;
  timestamp: string;
}

export type OdysseysEvalTaskResult = Pick<
  TaskResult,
  | 'run_dir'
  | 'task_id'
  | 'task'
  | 'num_steps'
  | 'num_screenshots_sent'
  | 'rubric_scores'
  | 'rubric_results'
  | 'average_rubric_score'
  | 'perfect'
  | 'error'
>;

export interface BenchmarkConfig {
  provider: string;
  modelId: string;
  thinkingLevel: ThinkingLevel;
  concurrency: number;
  outputDir: string;
  datasetPath: string;
  googleApiKey?: string;
  graderModel: string;
  maxSteps: number;
  taskId?: string;
  taskListJsonPath?: string;
  level?: OdysseysLevel;
  limit?: number;
  resume: boolean;
  grade: boolean;
  asideCommand: string;
  asideArgs: string[];
  timeoutMs: number;
}
