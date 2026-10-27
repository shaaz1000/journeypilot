export interface ToolCall {
  id: string;
  type: "function";
  function: { name: string; arguments: string };
}

export type ChatMessage =
  | { role: "system" | "user"; content: string }
  | { role: "assistant"; content: string | null; tool_calls?: ToolCall[] }
  | { role: "tool"; content: string; tool_call_id: string };

export interface ToolSpec {
  name: string;
  description: string;
  parameters: Record<string, unknown>;
}

export interface ChatRequest {
  /** Short label recorded in the trace, e.g. "classify" or "agent:flight". */
  purpose: string;
  messages: ChatMessage[];
  tools?: ToolSpec[];
  /** "auto" lets the model choose; a name forces exactly that function (used for structured output). */
  toolChoice?: "auto" | "none" | { name: string };
  maxTokens?: number;
  temperature?: number;
}

export interface TokenUsage {
  promptTokens?: number;
  completionTokens?: number;
  totalTokens?: number;
}

export interface ChatResponse {
  content: string | null;
  toolCalls: ToolCall[];
  finishReason: string | null;
  usage?: TokenUsage;
}

export interface LlmClient {
  readonly provider: string;
  readonly model: string;
  chat(request: ChatRequest): Promise<ChatResponse>;
}

export class LlmError extends Error {
  constructor(
    message: string,
    readonly status?: number,
    readonly retryable = false,
  ) {
    super(message);
    this.name = "LlmError";
  }
}
