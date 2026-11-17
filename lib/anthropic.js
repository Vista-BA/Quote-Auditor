// One place where the app talks to the Claude API.
// Both /api/check and /api/health used to hand-build the same fetch, so the headers and the
// error shapes could drift apart. They also had no timeout: a slow upstream held the
// serverless function open until the platform killed it, and the caller got nothing useful back.
// This module never throws. It always answers { ok: true, data } or { ok: false, status, problem, detail },
// so a route can report the trouble instead of crashing.

const API_URL = "https://api.anthropic.com/v1/messages";
const API_VERSION = "2023-06-01";

// OpenRouter (openrouter.ai) resells Claude behind one key. Its keys start "sk-or-"; such a key in
// ANTHROPIC_API_KEY (or OPENROUTER_API_KEY) sends the call there instead of to Anthropic, in
// OpenRouter's OpenAI-style format, and the reply is turned back into Anthropic's shape so nothing
// else changes. The model id there is "anthropic/claude-haiku-5.5" for our "claude-haiku-5-5";
// OPENROUTER_MODEL overrides it if OpenRouter names it differently.
const OR_URL = "https://openrouter.ai/api/v1/chat/completions";
export const isOpenRouter = (key, env = process.env) => String(key || "").startsWith("sk-or-") || env.LLM_PROVIDER === "openrouter";
export const openRouterModel = (model, env = process.env) => env.OPENROUTER_MODEL || `anthropic/${String(model).replace(/-(\d+)-(\d+)$/, "-$1.$2")}`;
export const llmKey = (env = process.env) => env.ANTHROPIC_API_KEY || env.OPENROUTER_API_KEY || "";

// Anthropic request pieces -> OpenRouter messages. System blocks keep their cache_control, which
// OpenRouter passes on to Claude, so the long skill prompt is still cached.
export function toOpenRouter({ model, system, user, messages, maxTokens }, env = process.env) {
  const out = [];
  if (system) out.push({ role: "system", content: typeof system === "string" ? system : system.map((b) => ({ type: "text", text: b.text, ...(b.cache_control ? { cache_control: b.cache_control } : {}) })) });
  for (const m of messages || [{ role: "user", content: user }]) {
    out.push({ role: m.role, content: typeof m.content === "string" ? m.content : m.content.filter((c) => c.type === "text").map((c) => ({ type: "text", text: c.text })) });
  }
  return { model: openRouterModel(model, env), max_tokens: maxTokens, messages: out };
}

// OpenRouter reply -> the Anthropic reply shape the routes read (content, stop_reason, usage).
export function fromOpenRouter(d) {
  const ch = d?.choices?.[0] || {};
  const text = typeof ch.message?.content === "string" ? ch.message.content : (ch.message?.content || []).map((c) => c.text || "").join("");
  const cached = d?.usage?.prompt_tokens_details?.cached_tokens || 0;
  const stop = { stop: "end_turn", length: "max_tokens", content_filter: "refusal" }[ch.finish_reason] || ch.finish_reason || null;
  return {
    model: d?.model, content: text ? [{ type: "text", text }] : [], stop_reason: stop,
    usage: { input_tokens: Math.max(0, (d?.usage?.prompt_tokens || 0) - cached), output_tokens: d?.usage?.completion_tokens || 0, cache_read_input_tokens: cached, cache_creation_input_tokens: 0 },
  };
}

async function callOpenRouter({ key, model, system, user, messages, tools, maxTokens, timeoutMs }) {
  if (tools) return { ok: false, status: 400, problem: "not_supported", detail: "Agentic search is not available through OpenRouter; the fixed search is used." };
  let r;
  try {
    r = await fetch(OR_URL, {
      method: "POST",
      headers: { Authorization: `Bearer ${key}`, "content-type": "application/json", "X-Title": "Quote Auditor" },
      body: JSON.stringify(toOpenRouter({ model, system, user, messages, maxTokens })),
      signal: AbortSignal.timeout(timeoutMs),
    });
  } catch (e) {
    if (e?.name === "TimeoutError" || e?.name === "AbortError") return { ok: false, status: 502, problem: "timeout", detail: `No answer from OpenRouter within ${Math.round(timeoutMs / 1000)} seconds.` };
    return { ok: false, status: 502, problem: "network", detail: String(e).slice(0, 200) };
  }
  const data = await r.json().catch(() => ({}));
  if (!r.ok || data?.error) {
    return { ok: false, status: r.ok ? 502 : r.status, problem: r.status === 401 ? "authentication_error" : "openrouter_error", detail: `OpenRouter: ${data?.error?.message || r.status}` };
  }
  return { ok: true, data: fromOpenRouter(data) };
}

// messages replaces the single user turn for a multi-step conversation (lib/agentic.js); tools and
// toolChoice go with it. Without them the request is the same one-turn call as before.
export async function callClaude({ key, model, system, user, messages, tools, toolChoice, maxTokens, timeoutMs = 60000 }) {
  if (isOpenRouter(key)) return callOpenRouter({ key, model, system, user, messages, tools, maxTokens, timeoutMs });
  // No temperature field on purpose: the 5-series models reject it. Do not add one.
  const payload = { model, max_tokens: maxTokens, messages: messages || [{ role: "user", content: user }] };
  if (system) payload.system = system;
  if (tools) payload.tools = tools;
  // Only "auto" and "none" are used: Opus 5.5 and Sonnet 5.5 reject a forced tool_choice with a 400.
  if (toolChoice) payload.tool_choice = toolChoice;

  let r;
  try {
    r = await fetch(API_URL, {
      method: "POST",
      headers: { "x-api-key": key, "anthropic-version": API_VERSION, "content-type": "application/json" },
      body: JSON.stringify(payload),
      signal: AbortSignal.timeout(timeoutMs),
    });
  } catch (e) {
    // A timeout is worth naming: "network" sends someone hunting the wrong problem.
    if (e?.name === "TimeoutError" || e?.name === "AbortError") {
      return { ok: false, status: 502, problem: "timeout", detail: `No answer from the Claude API within ${Math.round(timeoutMs / 1000)} seconds.` };
    }
    return { ok: false, status: 502, problem: "network", detail: String(e).slice(0, 200) };
  }

  // An error response is not always JSON (a gateway page, an empty body), so parse defensively.
  const data = await r.json().catch(() => ({}));
  if (!r.ok) {
    return { ok: false, status: r.status, problem: data?.error?.type || "unknown", detail: data?.error?.message || "" };
  }
  return { ok: true, data };
}

// The text the model wrote, with the non-text parts dropped.
// Returns "" when the model wrote nothing, which the check route reports as empty_answer.
export function textOf(data) {
  return (data?.content || []).filter((c) => c.type === "text").map((c) => c.text).join("\n").trim();
}
