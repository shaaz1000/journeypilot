/** Small DOM helpers. All text goes through textContent; nothing untrusted is ever parsed as HTML. */
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

const INLINE = /(\*\*[^*]+\*\*|https?:\/\/[^\s)\]`]+)/g;

function inline(text: string): Node[] {
  const nodes: Node[] = [];
  let last = 0;
  for (const match of text.matchAll(INLINE)) {
    const token = match[0];
    if (match.index! > last) nodes.push(document.createTextNode(text.slice(last, match.index)));
    if (token.startsWith("**")) nodes.push(el("strong", {}, token.slice(2, -2)));
    else {
      const clean = token.replace(/[.,;:]+$/, "");
      nodes.push(safeLink(clean));
      if (clean.length < token.length) nodes.push(document.createTextNode(token.slice(clean.length)));
    }
    last = match.index! + token.length;
  }
  if (last < text.length) nodes.push(document.createTextNode(text.slice(last)));
  return nodes;
}

/** Renders the model's light markdown (paragraphs, "- " bullets, nested bullets, **bold**, links) as DOM. */
export function richText(text: string): HTMLElement {
  const root = el("div", { class: "rich" });
  let list: HTMLUListElement | null = null;
  let sublist: HTMLUListElement | null = null;
  for (const raw of text.split("\n")) {
    const bullet = raw.match(/^(\s*)[-*•]\s+(.*)$/);
    if (bullet) {
      const nested = bullet[1]!.length >= 2;
      const item = el("li", {}, ...inline(bullet[2]!));
      if (nested && list?.lastElementChild) {
        if (!sublist) {
          sublist = el("ul");
          list.lastElementChild.append(sublist);
        }
        sublist.append(item);
      } else {
        if (!list) {
          list = el("ul");
          root.append(list);
        }
        sublist = null;
        list.append(item);
      }
      continue;
    }
    list = null;
    sublist = null;
    if (raw.trim()) root.append(el("p", {}, ...inline(raw.trim())));
  }
  return root;
}

export function formatDuration(ms: unknown): string {
  if (typeof ms !== "number") return "";
  return ms < 1000 ? `${ms} ms` : `${(ms / 1000).toFixed(1)} s`;
}
