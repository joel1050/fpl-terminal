import {
  deepSeekChatCompletion,
  DeepSeekChatResponse,
  getDeepSeekModel,
  hasDeepSeekKey,
  ChatMessage,
  DeepSeekThinkingMode,
} from "./deepseek";
import { ANALYST_SYSTEM_PROMPT, compactContextPrompt } from "./systemPrompt";
import {
  AIRequest,
  AIRequestSchema,
  AnalystActionSchema,
  AnalystContextInput,
  AnalystResponse,
  AnalystResponseSchema,
  DEFAULT_ANALYST_CONTEXT,
  DeepSeekToolCallSchema,
  DeepSeekMessageSchema,
} from "./schemas";
import { AIDataAdapters, createToolRegistry, executeTool, TOOL_DEFINITIONS } from "./tools";

export const MAX_TOOL_ROUNDS = 6;

export interface AnalystRunResult extends AnalystResponse {
  offline?: boolean;
  model?: string;
  thinking: DeepSeekThinkingMode;
  toolRounds: number;
  loopGuardTriggered?: boolean;
}

export interface AnalystChatRequest {
  messages: ChatMessage[];
  tools: typeof TOOL_DEFINITIONS;
  mode: DeepSeekThinkingMode;
  signal?: AbortSignal;
}

export type AnalystChat = (request: AnalystChatRequest) => Promise<DeepSeekChatResponse>;

export interface RunAnalystOptions {
  adapters?: AIDataAdapters;
  chat?: AnalystChat;
  apiKey?: string;
  signal?: AbortSignal;
}

const OFFLINE_MESSAGE = "AI ANALYST OFFLINE\n\nAdd DEEPSEEK_API_KEY to .env.local to enable conversational analysis.";

function thinkingMode(request: AIRequest): DeepSeekThinkingMode {
  if (request.mode) return request.mode;
  if (request.thinking !== undefined) return request.thinking ? "thinking" : "normal";
  return /\b(restructure|alternative|afford|optimi[sz]|improv|sacrifice|around|make .+ fit|complete|finish|stronger bench|spend less|safer)\b/i.test(request.message)
    ? "thinking"
    : "normal";
}

function cleanAssistantText(content: string | null | undefined): string {
  if (!content) return "";
  return content
    .replace(/<think>[\s\S]*?<\/think>/gi, "")
    .replace(/^\s*reasoning\s*:[\s\S]*?(?:\n\s*answer\s*:|$)/i, "")
    .trim();
}

function parseJsonCandidate(content: string): unknown {
  const trimmed = content.trim().replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/, "");
  try {
    return JSON.parse(trimmed) as unknown;
  } catch {
    const start = trimmed.indexOf("{");
    const end = trimmed.lastIndexOf("}");
    if (start < 0 || end <= start) return undefined;
    try {
      return JSON.parse(trimmed.slice(start, end + 1)) as unknown;
    } catch {
      return undefined;
    }
  }
}

function parseAssistantResponse(content: string | null | undefined): AnalystResponse {
  const text = cleanAssistantText(content);
  const candidate = parseJsonCandidate(text);
  if (candidate && typeof candidate === "object") {
    const parsed = AnalystResponseSchema.safeParse(candidate);
    if (parsed.success) return parsed.data;

    const record = candidate as Record<string, unknown>;
    if (typeof record.message === "string") {
      const actions = Array.isArray(record.actions)
        ? record.actions.flatMap((action) => {
            const parsedAction = AnalystActionSchema.safeParse(action);
            return parsedAction.success ? [parsedAction.data] : [];
          })
        : [];
      return { message: cleanAssistantText(record.message).slice(0, 10000), ...(actions.length ? { actions } : {}) };
    }
  }
  return { message: text.slice(0, 10000) || "I couldn't produce an analyst response." };
}

function offlineResult(mode: DeepSeekThinkingMode): AnalystRunResult {
  return { message: OFFLINE_MESSAGE, offline: true, thinking: mode, toolRounds: 0 };
}

function normalizeRequest(request: AIRequest): AIRequest {
  const parsed = AIRequestSchema.parse(request);
  return parsed;
}

export async function runAnalyst(request: AIRequest, options: RunAnalystOptions = {}): Promise<AnalystRunResult> {
  const parsedRequest = normalizeRequest(request);
  const mode = thinkingMode(parsedRequest);
  if (!options.chat && !options.apiKey && !hasDeepSeekKey()) return offlineResult(mode);

  const context: AnalystContextInput = parsedRequest.context ?? DEFAULT_ANALYST_CONTEXT;
  const registry = createToolRegistry(options.adapters);
  const messages: ChatMessage[] = [
    {
      role: "system",
      content: `${ANALYST_SYSTEM_PROMPT}\n\nCurrent compact squad context:\n${compactContextPrompt(context)}`,
    },
    { role: "user", content: parsedRequest.message },
  ];
  const chat: AnalystChat = options.chat ?? ((input) => deepSeekChatCompletion(input, { apiKey: options.apiKey }));
  let rounds = 0;

  while (rounds < MAX_TOOL_ROUNDS) {
    const completion = await chat({ messages, tools: TOOL_DEFINITIONS, mode, signal: options.signal });
    const choice = completion.choices[0];
    if (!choice) return { message: "DeepSeek returned no answer.", model: completion.model, thinking: mode, toolRounds: rounds };

    const messageParse = DeepSeekMessageSchema.safeParse(choice.message);
    if (!messageParse.success) return { message: "DeepSeek returned an invalid answer.", model: completion.model, thinking: mode, toolRounds: rounds };
    const assistantMessage = messageParse.data;
    const toolCalls = assistantMessage.tool_calls ?? [];
    if (!toolCalls.length) {
      const response = parseAssistantResponse(assistantMessage.content);
      return { ...response, model: completion.model, thinking: mode, toolRounds: rounds };
    }

    // Keep the complete assistant message, including reasoning_content, in the
    // next request. DeepSeek requires it when a thinking response calls tools.
    messages.push(assistantMessage);
    rounds += 1;
    for (const rawCall of toolCalls) {
      const call = DeepSeekToolCallSchema.safeParse(rawCall);
      const result = call.success
        ? await executeTool(registry, call.data.function.name, call.data.function.arguments, context)
        : { ok: false, error: "Invalid tool call" };
      messages.push({
        role: "tool",
        tool_call_id: call.success ? call.data.id : "invalid-tool-call",
        name: call.success ? call.data.function.name : "invalid",
        content: JSON.stringify(result.ok ? result.data : { error: result.error }),
      });
    }
  }

  const partial = [...messages]
    .reverse()
    .find((message) => message.role === "assistant" && cleanAssistantText(message.content))?.content;
  return {
    message: partial
      ? `${cleanAssistantText(partial)}\n\nI reached the tool-call limit before the analysis finished.`
      : "I reached the tool-call limit before the analysis finished. Try a narrower question.",
    model: getDeepSeekModel(),
    thinking: mode,
    toolRounds: rounds,
    loopGuardTriggered: true,
  };
}

export const runAgent = runAnalyst;
export { cleanAssistantText, parseAssistantResponse, thinkingMode };
