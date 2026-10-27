import { parseDocument } from "htmlparser2";
import { findOne, textContent } from "domutils";
import type { ChildNode, Element } from "domhandler";
import { cosine, type Embedder } from "../llm/embeddings.js";

const SKIPPED = new Set(["script", "style", "noscript", "svg", "template", "iframe", "head"]);
const BLOCKS = new Set([
  "p", "li", "td", "th", "dd", "dt", "h1", "h2", "h3", "h4", "h5", "h6", "blockquote", "section", "article",
  "div", "tr", "ul", "ol", "table", "header", "footer", "main", "aside", "nav", "figcaption", "summary", "details", "br",
]);
const MAX_PASSAGE = 500;
const MIN_PASSAGE = 40;

/** Classes of machine-readable or print-only markers (map coordinates, references) that are not reading text. */
const SKIPPED_CLASSES = ["geo", "listing-coordinates", "noprint", "mw-ref", "reference"];

/** Visible text of a node: like textContent, but skipping scripts, styles and other non-content elements. */
export function visibleText(node: ChildNode): string {
  if (node.type === "text") return (node as { data: string }).data;
  if ("name" in node && "children" in node) {
    const el = node as Element;
    if (SKIPPED.has(el.name)) return "";
    const classes = (el.attribs?.class ?? "").split(" ");
    if (SKIPPED_CLASSES.some((c) => classes.includes(c))) return "";
    // Spaces separate block-level children only; inline children ("Museum</span>, on") join as written.
    return el.children.map((child) => ("name" in child && BLOCKS.has((child as Element).name) ? ` ${visibleText(child)} ` : visibleText(child))).join("");
  }
  return "";
}

/** Collapses runs of whitespace to single spaces without pattern matching. */
export function normaliseSpace(text: string): string {
  let out = "";
  let pendingSpace = false;
  for (const ch of text) {
    if (ch.trim() === "") {
      pendingSpace = out.length > 0;
      continue;
    }
    if (pendingSpace) out += " ";
    out += ch;
    pendingSpace = false;
  }
  return out;
}

/** Splits long text at sentence boundaries using the platform's sentence segmenter. */
function splitLong(text: string): string[] {
  if (text.length <= MAX_PASSAGE) return [text];
  const parts: string[] = [];
  let current = "";
  for (const { segment } of new Intl.Segmenter("en", { granularity: "sentence" }).segment(text)) {
    if ((current + segment).length > MAX_PASSAGE && current) {
      parts.push(current.trim());
      current = "";
    }
    current += segment;
  }
  if (current.trim()) parts.push(current.trim());
  return parts.flatMap((p) => (p.length > MAX_PASSAGE ? [p.slice(0, MAX_PASSAGE)] : [p]));
}

/**
 * Parses HTML with a real parser and returns its title and readable passages, one per block element
 * (paragraph, list item, table cell, heading). Scripts, styles and other non-content elements are skipped.
 */
export function htmlToPassages(html: string): { title: string; passages: string[] } {
  const document = parseDocument(html, { decodeEntities: true });
  const titleElement = findOne((el: Element) => el.name === "title", document.children, true);
  const title = titleElement ? normaliseSpace(textContent(titleElement)) : "";

  const raw: string[] = [];
  let buffer = "";
  const flush = () => {
    const text = normaliseSpace(buffer);
    if (text) raw.push(text);
    buffer = "";
  };
  const walk = (nodes: ChildNode[]) => {
    for (const node of nodes) {
      if (node.type === "text") buffer += (node as { data: string }).data;
      else if ("name" in node && "children" in node) {
        const el = node as Element;
        if (SKIPPED.has(el.name)) continue;
        const block = BLOCKS.has(el.name);
        if (block) flush();
        else buffer += " ";
        walk(el.children);
        if (block) flush();
      }
    }
  };
  walk(document.children);
  flush();

  return { title, passages: mergePassages(raw) };
}

/** Merges fragments too short to stand alone (menu items, labels) into their neighbour, then caps length. */
function mergePassages(raw: string[]): string[] {
  const merged: string[] = [];
  for (const text of raw) {
    const last = merged[merged.length - 1];
    if (last !== undefined && (last.length < MIN_PASSAGE || text.length < MIN_PASSAGE) && last.length + text.length < MAX_PASSAGE) merged[merged.length - 1] = `${last} ${text}`;
    else merged.push(text);
  }
  return merged.flatMap(splitLong);
}

/** Passages from a browser's visible text, where each line is one rendered block. */
export function textToPassages(text: string): string[] {
  return mergePassages(text.split("\n").map(normaliseSpace).filter(Boolean));
}

/** Passages long enough to carry content; fewer than two means the page needs a browser to render. */
export function substantialPassages(passages: string[]): number {
  return passages.filter((p) => p.length >= MIN_PASSAGE).length;
}

/** Word-level fallback when embeddings are unavailable: words come from the platform's word segmenter. */
function words(text: string): Set<string> {
  const out = new Set<string>();
  for (const { segment, isWordLike } of new Intl.Segmenter("en", { granularity: "word" }).segment(text.toLowerCase())) {
    if (isWordLike && segment.length > 2) out.add(segment);
  }
  return out;
}

const MAX_PASSAGES_TO_RANK = 150;

/**
 * The passages most relevant to the query, in page order. Ranked by meaning with embeddings; if the
 * embedding call fails, ranked by shared words instead. Returns the method used for the trace.
 */
export async function rankPassages(
  passages: string[],
  query: string,
  embedder: Embedder | undefined,
  max = 5,
  signal?: AbortSignal,
): Promise<{ excerpts: string[]; method: "embeddings" | "word_overlap" }> {
  const candidates = passages.filter((p) => p.length >= MIN_PASSAGE).slice(0, MAX_PASSAGES_TO_RANK);
  if (candidates.length === 0) return { excerpts: [], method: "word_overlap" };
  let scores: number[] | undefined;
  let method: "embeddings" | "word_overlap" = "word_overlap";
  if (embedder) {
    try {
      const [q] = await embedder.embed([query], "query", signal);
      const vectors = await embedder.embed(candidates, "passage", signal);
      scores = vectors.map((v) => cosine(q!, v));
      method = "embeddings";
    } catch {
      scores = undefined;
    }
  }
  if (!scores) {
    const queryWords = words(query);
    scores = candidates.map((p) => {
      const passageWords = words(p);
      let shared = 0;
      for (const w of queryWords) if (passageWords.has(w)) shared++;
      return shared;
    });
  }
  const top = scores
    .map((score, index) => ({ score, index }))
    .filter((s) => s.score > 0)
    .sort((a, b) => b.score - a.score)
    .slice(0, max)
    .sort((a, b) => a.index - b.index);
  return { excerpts: top.map((t) => candidates[t.index]!), method };
}
