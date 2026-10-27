import type { Tracer } from "../trace/tracer.js";
import type { ChatRequest, ChatResponse, LlmClient } from "./types.js";

/** Calls the model and records a `model` trace event with latency, token counts and outcome. */
export async function tracedChat(llm: LlmClient, tracer: Tracer, request: ChatRequest, parentSpanId?: string): Promise<ChatResponse> {
  const started = performance.now();
  try {
    const response = await llm.chat(request);
    tracer.emit(
      "model",
      {
        purpose: request.purpose,
        provider: llm.provider,
        model: llm.model,
        status: "ok",
        prompt: tracer.payload(request.messages),
        toolsOffered: request.tools?.map((tool) => tool.name) ?? [],
        toolChoice: request.toolChoice ?? null,
        reasoning: response.reasoning ? tracer.payload(response.reasoning) : null,
        durationMs: Math.round(performance.now() - started),
        finishReason: response.finishReason,
        toolCalls: response.toolCalls.map((call) => ({ name: call.function.name, arguments: tracer.payload(call.function.arguments) })),
        response: response.content ? tracer.payload(response.content) : null,
        usage: response.usage,
      },
      { parentSpanId },
    );
    return response;
  } catch (error) {
    tracer.emit(
      "model",
      {
        purpose: request.purpose,
        provider: llm.provider,
        model: llm.model,
        status: "error",
        prompt: tracer.payload(request.messages),
        toolsOffered: request.tools?.map((tool) => tool.name) ?? [],
        durationMs: Math.round(performance.now() - started),
        error: String(error),
      },
      { parentSpanId },
    );
    throw error;
  }
}
