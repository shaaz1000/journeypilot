import MarkdownIt from "markdown-it";

/**
 * Small DOM helpers. Plain text goes through textContent. Answer text is Markdown rendered by markdown-it
 * with raw HTML disabled, so nothing in it can become markup or script.
 */
type Child = Node | string | null | undefined | false;

export function el<K extends keyof HTMLElementTagNameMap>(tag: K, attrs: Record<string, string> = {}, ...children: Child[]): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  for (const [name, value] of Object.entries(attrs)) {
    if (name === "class") node.className = value;
    else node.setAttribute(name, value);
  }
  for (const child of children) {
    if (child === null || child === undefined || child === false) continue;
    node.append(typeof child === "string" ? document.createTextNode(child) : child);
  }
  return node;
}

export function safeLink(href: string, label?: string): HTMLElement {
  let url: URL | null = null;
  try {
    url = new URL(href);
  } catch {
    url = null;
  }
  if (!url || (url.protocol !== "https:" && url.protocol !== "http:")) return el("span", {}, label ?? href);
  return el("a", { href: url.toString(), target: "_blank", rel: "noopener noreferrer" }, label ?? href);
}

// Raw HTML is escaped (html: false) and bare URLs are not auto-linked; only http(s) link targets are accepted.
const markdown = new MarkdownIt({ html: false, linkify: false, breaks: true });
markdown.validateLink = (url: string) => {
  try {
    const protocol = new URL(url).protocol;
    return protocol === "https:" || protocol === "http:";
  } catch {
    return false;
  }
};
const defaultLinkOpen = markdown.renderer.rules.link_open ?? ((tokens, idx, options, _env, self) => self.renderToken(tokens, idx, options));
markdown.renderer.rules.link_open = (tokens, idx, options, env, self) => {
  tokens[idx]!.attrSet("target", "_blank");
  tokens[idx]!.attrSet("rel", "noopener noreferrer");
  return defaultLinkOpen(tokens, idx, options, env, self);
};

/** Renders the answer's Markdown (paragraphs, lists, bold, links) with markdown-it. */
export function richText(text: string): HTMLElement {
  const root = el("div", { class: "rich" });
  root.innerHTML = markdown.render(text);
  return root;
}

export function formatDuration(ms: unknown): string {
  if (typeof ms !== "number") return "";
  return ms < 1000 ? `${ms} ms` : `${(ms / 1000).toFixed(1)} s`;
}
