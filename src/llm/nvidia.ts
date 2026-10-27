import { LlmError, type ChatRequest, type ChatResponse, type LlmClient } from "./types.js";

interface NvidiaOptions {
  apiKey: string;
  baseUrl: string;
  model: string;
  timeoutMs: number;
  maxAttempts?: number;
  /** Enable Nemotron reasoning; the thinking is returned and logged. Adds `thinkingTokens` to each budget. */
  thinking?: boolean;
  thinkingTokens?: number;
}

/**
 * Client for NVIDIA's OpenAI-compatible chat completions endpoint.
 * Reasoning is optional. When on, the thinking is returned for logging and extra tokens are added to the
 * budget so thinking cannot crowd out the tool call. There is deliberately no fallback to another provider.
 */
export class NvidiaClient implements LlmClient {
  readonly provider = "nvidia";
  readonly model: string;

  constructor(private readonly options: NvidiaOptions) {
    this.model = options.model;
  }

  async chat(request: ChatRequest): Promise<ChatResponse> {
    const body: Record<string, unknown> = {
      model: this.model,
      messages: request.messages,
      max_tokens: (request.maxTokens ?? 1024) + (this.options.thinking ? (this.options.thinkingTokens ?? 2048) : 0),
      temperature: request.temperature ?? 0.2,
      chat_template_kwargs: { enable_thinking: this.options.thinking ?? false },
    };
    if (request.tools?.length) {
      body.tools = request.tools.map((tool) => ({ type: "function", function: tool }));
      const choice = request.toolChoice ?? "auto";
      body.tool_choice = typeof choice === "string" ? choice : { type: "function", function: { name: choice.name } };
    }

    const maxAttempts = this.options.maxAttempts ?? 2;
    let lastError: LlmError | undefined;
    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
      try {
        return await this.post(body);
      } catch (error) {
        lastError = error instanceof LlmError ? error : new LlmError(String(error), undefined, true);
        if (!lastError.retryable || attempt === maxAttempts) break;
        await new Promise((resolve) => setTimeout(resolve, 1000 * attempt));
      }
    }
    throw lastError;
  }

  private async post(body: Record<string, unknown>): Promise<ChatResponse> {
    let response: Response;
    try {
      response = await fetch(`${this.options.baseUrl}/chat/completions`, {
        method: "POST",
        headers: { Authorization: `Bearer ${this.options.apiKey}`, "Content-Type": "application/json" },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(this.options.timeoutMs),
      });
    } catch (error) {
      const timedOut = error instanceof Error && error.name === "TimeoutError";
      throw new LlmError(timedOut ? `model call timed out after ${this.options.timeoutMs} ms` : `network error: ${String(error)}`, undefined, true);
    }

    if (!response.ok) {
      const detail = (await response.text()).slice(0, 300);
      const retryable = response.status === 429 || response.status >= 500;
      throw new LlmError(`NVIDIA endpoint returned ${response.status}: ${detail}`, response.status, retryable);
    }

    const json = (await response.json()) as {
      choices?: { message?: { content?: string | null; reasoning_content?: string | null; tool_calls?: ChatResponse["toolCalls"] }; finish_reason?: string }[];
      usage?: { prompt_tokens?: number; completion_tokens?: number; total_tokens?: number };
    };
    const choice = json.choices?.[0];
    if (!choice?.message) throw new LlmError("malformed completion: no message in response", response.status, true);
    return {
      content: choice.message.content ?? null,
      reasoning: choice.message.reasoning_content ?? undefined,
      toolCalls: choice.message.tool_calls ?? [],
      finishReason: choice.finish_reason ?? null,
      usage: json.usage && {
        promptTokens: json.usage.prompt_tokens,
        completionTokens: json.usage.completion_tokens,
        totalTokens: json.usage.total_tokens,
      },
    };
  }
}
