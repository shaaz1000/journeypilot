export interface Embedder {
  readonly model: string;
  /** "query" for the question, "passage" for the text being searched (retrieval models embed them differently). */
  embed(texts: string[], inputType: "query" | "passage", signal?: AbortSignal): Promise<number[][]>;
}

interface NvidiaEmbedderOptions {
  apiKey: string;
  baseUrl: string;
  model: string;
  timeoutMs: number;
}

/** Nemotron retrieval embeddings on NVIDIA's hosted endpoint, used to rank page passages by meaning. */
export class NvidiaEmbedder implements Embedder {
  readonly model: string;

  constructor(private readonly options: NvidiaEmbedderOptions) {
    this.model = options.model;
  }

  async embed(texts: string[], inputType: "query" | "passage", signal?: AbortSignal): Promise<number[][]> {
    const timeout = AbortSignal.timeout(this.options.timeoutMs);
    const response = await fetch(`${this.options.baseUrl}/embeddings`, {
      method: "POST",
      headers: { Authorization: `Bearer ${this.options.apiKey}`, "Content-Type": "application/json" },
      body: JSON.stringify({ model: this.model, input: texts, input_type: inputType, encoding_format: "float", truncate: "END" }),
      signal: signal ? AbortSignal.any([signal, timeout]) : timeout,
    });
    if (!response.ok) throw new Error(`embedding endpoint returned ${response.status}`);
    const json = (await response.json()) as { data?: { index: number; embedding: number[] }[] };
    if (!json.data || json.data.length !== texts.length) throw new Error("embedding response did not match the input");
    return [...json.data].sort((a, b) => a.index - b.index).map((d) => d.embedding);
  }
}

export function cosine(a: number[], b: number[]): number {
  let dot = 0;
  let na = 0;
  let nb = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i]! * b[i]!;
    na += a[i]! * a[i]!;
    nb += b[i]! * b[i]!;
  }
  return na && nb ? dot / Math.sqrt(na * nb) : 0;
}
