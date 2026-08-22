import { z } from "zod";

import { DeepSeekMessageSchema } from "./schemas";

export const DEEPSEEK_BASE_URL = "https://api.deepseek.com";
export const DEFAULT_DEEPSEEK_MODEL = "deepseek-v4-flash";

export type DeepSeekThinkingMode = "normal" | "thinking";

export type ChatMessage = z.infer<typeof DeepSeekMessageSchema>;

export interface ChatToolDefinition {
  type: "function";
  function: {
    name: string;
    description: string;
    parameters: Record<string, unknown>;
  };
}

export interface DeepSeekChatRequest {
  messages: ChatMessage[];
  tools?: ChatToolDefinition[];
  mode?: DeepSeekThinkingMode;
  signal?: AbortSignal;
}

export interface DeepSeekChatResponse {
  id?: string;
  model?: string;
  choices: Array<{
    message: ChatMessage;
    finish_reason?: string | null;
  }>;
  usage?: Record<string, unknown>;
}

export class DeepSeekUnavailableError extends Error {
  constructor() {
    super("DEEPSEEK_API_KEY is not configured");
    this.name = "DeepSeekUnavailableError";
  }
}

export class DeepSeekRequestError extends Error {
  readonly status: number;

  constructor(message: string, status: number) {
    super(message);
    this.name = "DeepSeekRequestError";
    this.status = status;
  }
}

export function getDeepSeekModel(): string {
  return process.env.DEEPSEEK_MODEL?.trim() || DEFAULT_DEEPSEEK_MODEL;
}

export function hasDeepSeekKey(): boolean {
  return Boolean(process.env.DEEPSEEK_API_KEY?.trim());
}

export async function deepSeekChatCompletion(
  request: DeepSeekChatRequest,
  options: {
    apiKey?: string;
    baseUrl?: string;
    model?: string;
    fetcher?: typeof fetch;
  } = {},
): Promise<DeepSeekChatResponse> {
  const apiKey = options.apiKey?.trim() || process.env.DEEPSEEK_API_KEY?.trim();
  if (!apiKey) throw new DeepSeekUnavailableError();

  const mode = request.mode ?? "normal";
  const body: Record<string, unknown> = {
    model: options.model || getDeepSeekModel(),
    messages: request.messages,
    stream: false,
    thinking: { type: mode === "thinking" ? "enabled" : "disabled" },
  };
  if (mode === "thinking") body.reasoning_effort = "high";
  if (request.tools?.length) {
    body.tools = request.tools;
    body.tool_choice = "auto";
  }

  const fetcher = options.fetcher ?? fetch;
  const response = await fetcher(`${options.baseUrl || DEEPSEEK_BASE_URL}/chat/completions`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      authorization: `Bearer ${apiKey}`,
    },
    body: JSON.stringify(body),
    signal: request.signal,
  });

  const payload: unknown = await response.json().catch(() => undefined);
  if (!response.ok) {
    const error = z
      .object({ error: z.object({ message: z.string().optional() }).optional() })
      .safeParse(payload);
    throw new DeepSeekRequestError(
      error.success ? error.data.error?.message || "DeepSeek request failed" : "DeepSeek request failed",
      response.status,
    );
  }

  const parsed = z
    .object({
      id: z.string().optional(),
      model: z.string().optional(),
      choices: z
        .array(
          z.object({
            message: DeepSeekMessageSchema,
            finish_reason: z.string().nullable().optional(),
          }),
        )
        .min(1),
      usage: z.record(z.string(), z.unknown()).optional(),
    })
    .safeParse(payload);
  if (!parsed.success) throw new DeepSeekRequestError("DeepSeek returned an invalid response", response.status);
  return parsed.data;
}

export const deepseekChatCompletion = deepSeekChatCompletion;
