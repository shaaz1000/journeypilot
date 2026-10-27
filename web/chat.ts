import { el, richText, safeLink } from "./dom.js";

interface ChatReply {
  requestId: string;
  status: "answered" | "partial" | "declined" | "clarify" | "refused" | "failed";
  body: string;
  agentsUsed: string[];
  citations: { url: string; title: string; retrievedAt: string }[];
  limitations: string[];
}

const AGENT_NAMES: Record<string, string> = { flight: "flight search", hotel: "hotel search", benefits: "lounge and card benefits" };

const thread = document.querySelector<HTMLElement>("#thread")!;
const form = document.querySelector<HTMLFormElement>("#composer")!;
const input = document.querySelector<HTMLTextAreaElement>("#message")!;
const send = document.querySelector<HTMLButtonElement>("#send")!;
const intro = document.querySelector<HTMLElement>("#intro")!;

function scrollToEnd(): void {
  window.scrollTo({ top: document.body.scrollHeight, behavior: matchMedia("(prefers-reduced-motion: reduce)").matches ? "auto" : "smooth" });
}

function renderReply(reply: ChatReply): HTMLElement {
  const card = el("article", { class: `reply reply--${reply.status}` });
  if (reply.status === "declined" || reply.status === "refused") card.append(el("p", { class: "reply__flag" }, "Outside what JourneyPilot covers"));
  if (reply.status === "clarify") card.append(el("p", { class: "reply__flag" }, "Needs a little more detail"));
  if (reply.status === "failed") card.append(el("p", { class: "reply__flag" }, "Couldn't get results this time"));
  card.append(richText(reply.body));

  if (reply.limitations.length) {
    card.append(el("section", { class: "reply__notes" }, el("h3", {}, "Good to know"), el("ul", {}, ...reply.limitations.map((l) => el("li", {}, l)))));
  }
  if (reply.citations.length) {
    card.append(
      el(
        "section",
        { class: "reply__sources" },
        el("h3", {}, "Sources"),
        el("ul", {}, ...reply.citations.map((c) => el("li", {}, safeLink(c.url, c.title), el("span", { class: "muted" }, ` checked ${new Date(c.retrievedAt).toLocaleString()}`)))),
      ),
    );
  }
  const via = reply.agentsUsed.map((a) => AGENT_NAMES[a] ?? a).join(", ");
  card.append(el("footer", { class: "reply__meta" }, via ? `Used ${via}. ` : "", `Reference ${reply.requestId}`));
  return card;
}

async function ask(message: string): Promise<void> {
  intro.hidden = true;
  thread.append(el("p", { class: "question" }, message));
  const pending = el("div", { class: "pending", role: "status" }, el("span", { class: "pending__dot", "aria-hidden": "true" }), "Checking flights, hotels and lounge sources");
  thread.append(pending);
  scrollToEnd();
  send.disabled = true;
  try {
    const response = await fetch("/api/chat", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ message }) });
    const data = (await response.json()) as ChatReply | { error: string };
    pending.replaceWith("error" in data ? el("p", { class: "error" }, data.error) : renderReply(data));
  } catch {
    pending.replaceWith(el("p", { class: "error" }, "JourneyPilot didn't respond. Check the server is running, then send your question again."));
  } finally {
    send.disabled = false;
    input.focus();
    scrollToEnd();
  }
}

form.addEventListener("submit", (event) => {
  event.preventDefault();
  const message = input.value.trim();
  if (!message || send.disabled) return;
  input.value = "";
  void ask(message);
});

input.addEventListener("keydown", (event) => {
  if (event.key === "Enter" && !event.shiftKey) {
    event.preventDefault();
    form.requestSubmit();
  }
});

document.querySelectorAll<HTMLButtonElement>("[data-example]").forEach((button) =>
  button.addEventListener("click", () => {
    input.value = button.dataset.example ?? "";
    form.requestSubmit();
  }),
);
