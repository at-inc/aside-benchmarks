import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

import { z } from 'zod';

export interface OdysseysTrajectoryScreenshot {
  mimeType: string;
  data: string;
}

export interface OdysseysTrajectoryStep {
  step_num: number;
  action_line?: string;
  response?: string;
  screenshot_file?: string;
  final?: boolean;
}

const DEFAULT_TRUNCATE_CHARS = 2_000;
const REPL_RESULT_HEAD_CHARS = 1_200;
const REPL_RESULT_TAIL_CHARS = 1_200;
const TOOL_RESULT_HEAD_CHARS = 1_000;
const TOOL_RESULT_TAIL_CHARS = 1_000;

const JsonRecordSchema = z.record(z.string(), z.unknown());
const ContentPartSchema = z.object({ type: z.string() }).passthrough();

type JsonRecord = z.infer<typeof JsonRecordSchema>;
type ContentPart = z.infer<typeof ContentPartSchema>;

interface ToolResultMessage {
  role: 'toolResult';
  toolCallId: string;
  content: ContentPart[];
}

interface AssistantMessage {
  role: 'assistant';
  content: ContentPart[];
}

function truncateHeadOnly(value: unknown, limit: number): string {
  if (typeof value === 'string' && value.startsWith('(tool returned image')) return value;
  const jsonStr = JSON.stringify(value);
  if (jsonStr.length <= limit) return jsonStr;
  const truncated = jsonStr.slice(0, limit);
  return `${truncated}...[truncated ${jsonStr.length - truncated.length} chars]...${jsonStr.startsWith('"') ? '"' : ''}`;
}

function truncateHeadTail(value: unknown, headChars: number, tailChars: number): string {
  if (typeof value === 'string' && value.startsWith('(tool returned image')) return value;
  const jsonStr = JSON.stringify(value);
  if (jsonStr.length <= headChars + tailChars) return jsonStr;
  const head = jsonStr.slice(0, Math.min(headChars, jsonStr.length));
  const tail = jsonStr.slice(Math.max(0, jsonStr.length - tailChars));
  return `${head}...[truncated ${jsonStr.length - head.length - tail.length} chars]...${tail}`;
}

function imageExtension(mimeType: string): string {
  if (mimeType === 'image/jpeg') return 'jpg';
  if (mimeType === 'image/webp') return 'webp';
  if (mimeType === 'image/gif') return 'gif';
  return 'png';
}

function parseEventLine(line: string): JsonRecord | undefined {
  const parsed = JsonRecordSchema.safeParse(JSON.parse(line));
  return parsed.success ? parsed.data : undefined;
}

function parseMessage(event: JsonRecord): JsonRecord | undefined {
  const parsed = JsonRecordSchema.safeParse(event.message);
  return parsed.success ? parsed.data : undefined;
}

function parseContent(value: unknown): ContentPart[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap((part) => {
    const parsed = ContentPartSchema.safeParse(part);
    return parsed.success ? [parsed.data] : [];
  });
}

function parseAssistantMessage(message: JsonRecord): AssistantMessage | undefined {
  if (message.role !== 'assistant') return undefined;
  return { role: 'assistant', content: parseContent(message.content) };
}

function parseToolResultMessage(message: JsonRecord): ToolResultMessage | undefined {
  if (message.role !== 'toolResult' || typeof message.toolCallId !== 'string') return undefined;
  return { role: 'toolResult', toolCallId: message.toolCallId, content: parseContent(message.content) };
}

function stringifyToolArgs(argumentsValue: unknown): string {
  const serialized = JSON.stringify(argumentsValue ?? {});
  return serialized.startsWith('{') && serialized.endsWith('}') ? serialized.slice(1, -1) : serialized;
}

function formatToolAction(toolName: string, argumentsValue: unknown): string {
  return `${toolName}(${truncateHeadOnly(stringifyToolArgs(argumentsValue), DEFAULT_TRUNCATE_CHARS)})`;
}

function formatReplAction(part: ContentPart): string {
  const args = JsonRecordSchema.safeParse(part.arguments);
  const title = args.success && typeof args.data.title === 'string' ? args.data.title : '';
  const code = args.success && typeof args.data.code === 'string' ? args.data.code : '';
  return `repl(${truncateHeadOnly(title, DEFAULT_TRUNCATE_CHARS)}, ${truncateHeadOnly(code, DEFAULT_TRUNCATE_CHARS)})`;
}

function formatImageToolResultPart(part: ContentPart): string {
  return `(image: ${typeof part.mimeType === 'string' ? part.mimeType : 'image/png'}, ${typeof part.data === 'string' ? part.data.length : 0} bytes)`;
}

function buildToolResultValue(message?: ToolResultMessage): unknown {
  if (!message) return null;

  const parts = message.content.flatMap((part) => {
    if (part.type === 'text') {
      const text = typeof part.text === 'string' ? part.text.trim() : '';
      return text ? [text] : [];
    }
    if (part.type === 'image') return [formatImageToolResultPart(part)];
    return [];
  });

  if (parts.length === 0) return null;
  return parts.length === 1 ? parts[0] : parts;
}

function formatToolResponse(part: ContentPart, result?: ToolResultMessage): string | undefined {
  const value = buildToolResultValue(result);
  if (value === null) return undefined;
  return part.name === 'repl'
    ? truncateHeadTail(value, REPL_RESULT_HEAD_CHARS, REPL_RESULT_TAIL_CHARS)
    : truncateHeadTail(value, TOOL_RESULT_HEAD_CHARS, TOOL_RESULT_TAIL_CHARS);
}

function extractScreenshots(result?: ToolResultMessage): OdysseysTrajectoryScreenshot[] {
  if (!result) return [];
  return result.content.flatMap((part) => {
    if (part.type !== 'image' || typeof part.data !== 'string' || !part.data) return [];
    return [{ mimeType: typeof part.mimeType === 'string' ? part.mimeType : 'image/png', data: part.data }];
  });
}

function formatTextResponse(part: ContentPart): string | undefined {
  const text = typeof part.text === 'string' ? part.text.trim() : '';
  return text ? truncateHeadOnly(text, DEFAULT_TRUNCATE_CHARS) : undefined;
}

function formatOdysseysHistoryStep(step: OdysseysTrajectoryStep, index: number): string | null {
  const parts: string[] = [];
  if (step.response?.trim()) parts.push(`Response: ${step.response.trim()}`);
  if (step.action_line?.trim()) parts.push(`Action: ${step.action_line.trim()}`);
  if (parts.length === 0) return null;
  return `${index}. ${parts.join('\n')}`;
}

export function serializeOdysseysStepsJsonl(steps: OdysseysTrajectoryStep[]): string {
  return `${steps.map((step) => JSON.stringify(step)).join('\n')}\n`;
}

export function formatOdysseysActionHistory(steps: OdysseysTrajectoryStep[]): string {
  const history = steps.flatMap((step, index) => {
    const formatted = formatOdysseysHistoryStep(step, index + 1);
    return formatted ? [formatted] : [];
  });
  return history.length ? history.join('\n') : 'No actions recorded.';
}

export function generateOdysseysTrajectory(eventsText: string, maxSteps: number) {
  const assistantMessages: AssistantMessage[] = [];
  const toolResultsById = new Map<string, ToolResultMessage>();

  for (const line of eventsText.split('\n').filter(Boolean)) {
    let event: JsonRecord | undefined;
    try {
      event = parseEventLine(line);
    } catch {
      continue;
    }
    if (!event || event.type !== 'message_end') continue;

    const message = parseMessage(event);
    if (!message) continue;

    const assistantMessage = parseAssistantMessage(message);
    if (assistantMessage) assistantMessages.push(assistantMessage);

    const toolResult = parseToolResultMessage(message);
    if (toolResult) toolResultsById.set(toolResult.toolCallId, toolResult);
  }

  const steps: OdysseysTrajectoryStep[] = [];
  const screenshots: OdysseysTrajectoryScreenshot[] = [];
  const screenshotFilenames: string[] = [];

  for (const [messageIndex, message] of assistantMessages.entries()) {
    if (steps.length >= maxSteps) break;

    for (const part of message.content) {
      if (steps.length >= maxSteps) break;

      if (part.type === 'toolCall' && typeof part.id === 'string' && typeof part.name === 'string') {
        const result = toolResultsById.get(part.id);
        const resultScreenshots = extractScreenshots(result);
        const screenshotStart = screenshots.length;
        const screenshotFile = resultScreenshots[0]
          ? `screenshots/${String(screenshotStart + 1).padStart(2, '0')}.${imageExtension(resultScreenshots[0].mimeType)}`
          : undefined;

        steps.push({
          step_num: steps.length + 1,
          action_line: part.name === 'repl' ? formatReplAction(part) : formatToolAction(part.name, part.arguments),
          response: formatToolResponse(part, result),
          ...(screenshotFile && { screenshot_file: screenshotFile }),
        });

        for (const shot of resultScreenshots) {
          screenshotFilenames.push(
            `screenshots/${String(screenshots.length + 1).padStart(2, '0')}.${imageExtension(shot.mimeType)}`,
          );
          screenshots.push(shot);
        }
        continue;
      }

      if (part.type === 'text') {
        const response = formatTextResponse(part);
        if (response) {
          steps.push({
            step_num: steps.length + 1,
            response,
            ...(messageIndex === assistantMessages.length - 1 && { final: true }),
          });
        }
      }
    }
  }

  return { steps, screenshots, screenshotFilenames };
}

export async function writeScreenshots(
  taskDir: string,
  screenshots: OdysseysTrajectoryScreenshot[],
  filenames: string[],
): Promise<void> {
  if (!screenshots.length) return;
  await mkdir(join(taskDir, 'screenshots'), { recursive: true });
  await Promise.all(
    screenshots.map((shot, index) =>
      writeFile(join(taskDir, filenames[index]!), Buffer.from(shot.data, 'base64')),
    ),
  );
}
