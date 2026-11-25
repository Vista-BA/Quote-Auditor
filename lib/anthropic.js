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
export const OR_THINKING_ROOM = 12000;
export const isOpenRouter = (key, env = process.env) => String(key || "").startsWith("sk-or-") || env.LLM_PROVIDER === "openrouter";
export const openRouterModel = (model, env = process.env) => env.OPENROUTER_MODEL || `anthropic/${String(model).replace(/-(\d+)-(\d+)$/, "-$1.$2")}`;
export const llmKey = (env = process.env) => env.ANTHROPIC_API_KEY || env.OPENROUTER_API_KEY || "";

// How much hidden thinking the model does before it answers: CLAUDE_THINKING in Vercel.
// Most of a check's cost is what the model writes, and most of that is thinking (Nov 25, live:
// about 1,500 of 1,800 written tokens per check). Unset keeps the model's own default; "low"
// asks for less; "off" asks for none. Anything else is ignored, so a typo cannot break checks.
// Change it only together with an eval run: less thinking may cost accuracy.
export function thinkingMode(env = process.env) {
  const v = String(env.CLAUDE_THINKING || "").trim().toLowerCase();
  return v === "off" || v === "low" ? v : "default";
}
// Anthropic's own API. Haiku 5.5 turns thinking off with "disabled"; Sonnet 5.5 rejects that and
// takes "between_tools" (thinking only between tool calls, so none on a one-turn check); Opus 5.5
// cannot turn it off at all, so it gets the lowest effort instead.
export function anthropicThinking(model, mode) {
  if (mode === "low") return { output_config: { effort: "low" } };
  if (mode !== "off") return {};
  if (/sonnet-5-5/.test(model)) return { thinking: { type: "between_tools" } };
  if (/opus-5-5/.test(model)) return { output_config: { effort: "low" } };
  return { thinking: { type: "disabled" } };
}
// OpenRouter's "reasoning" field, which it maps onto the model's thinking settings.
export function openRouterThinking(mode) {
  if (mode === "off") return { reasoning: { enabled: false } };
  if (mode === "low") return { reasoning: { effort: "low" } };
  return {};
}

// Anthropic request pieces -> OpenRouter messages. System blocks keep their cache_control, which
// OpenRouter passes on to Claude, so the long skill prompt is still cached.
export function toOpenRouter({ model, system, user, messages, maxTokens }, env = process.env) {
  const out = [];
  if (system) out.push({ role: "system", content: typeof system === "string" ? system : system.map((b) => ({ type: "text", text: b.text, ...(b.cache_control ? { cache_control: b.cache_control } : {}) })) });
  for (const m of messages || [{ role: "user", content: user }]) {
    out.push({ role: m.role, content: typeof m.content === "string" ? m.content : m.content.filter((c) => c.type === "text").map((c) => ({ type: "text", text: c.text })) });
  }
  // Through OpenRouter, Claude's thinking counts against max_tokens too, and a long quote used the
  // whole 4,000 on thinking and returned no answer (Nov 23: 3 of 20 checks, stop_reason max_tokens).
  // A real answer gets that much more room; a tiny call (the health check) keeps its own limit.
  return { model: openRouterModel(model, env), max_tokens: maxTokens >= 1000 ? maxTokens + OR_THINKING_ROOM : maxTokens, messages: out, ...openRouterThinking(thinkingMode(env)) };
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
  const body = toOpenRouter({ model, system, user, messages, maxTokens });
  let res = await postOpenRouter(key, body, timeoutMs);
  // A thinking setting the model refuses must never stop checks. On Nov 25, CLAUDE_THINKING=off on
  // Sonnet 5.5 got "Reasoning is mandatory for this endpoint and cannot be disabled." for every
  // check until the setting was removed. Now the call is sent again without it, once, and the
  // answer says so in usage.thinking_dropped.
  if (!res.ok && res.status === 400 && body.reasoning && /reasoning/i.test(res.detail || "")) {
    const { reasoning, ...plain } = body;
    res = await postOpenRouter(key, plain, timeoutMs);
    if (res.ok) res.data.usage.thinking_dropped = `CLAUDE_THINKING refused by OpenRouter for this model, so the model's own default was used.`;
  }
  return res;
}
async function postOpenRouter(key, body, timeoutMs) {
  let r;
  try {
    r = await fetch(OR_URL, {
      method: "POST",
      headers: { Authorization: `Bearer ${key}`, "content-type": "application/json", "X-Title": "Quote Auditor" },
      body: JSON.stringify(body),
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
export async function callClaude({ key, model, system, user, messages, tools, toolChoice, maxTokens, timeoutMs = 60000, retried = false, plainPayload = null }) {
  if (isOpenRouter(key)) return callOpenRouter({ key, model, system, user, messages, tools, maxTokens, timeoutMs });
  // No temperature field on purpose: the 5-series models reject it. Do not add one.
  const payload = { model, max_tokens: maxTokens, messages: messages || [{ role: "user", content: user }] };
  if (system) payload.system = system;
  if (!plainPayload) Object.assign(payload, anthropicThinking(model, thinkingMode()));
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
    // Same safety net as OpenRouter: a refused thinking setting is dropped once, never fatal.
    if (r.status === 400 && (payload.thinking || payload.output_config) && !retried && /thinking|effort|reasoning/i.test(data?.error?.message || "")) {
      const { thinking, output_config, ...plain } = payload;
      const again = await callClaude({ key, model, system, user, messages, tools, toolChoice, maxTokens, timeoutMs, retried: true, plainPayload: plain });
      if (again.ok) again.data.usage = { ...(again.data.usage || {}), thinking_dropped: "CLAUDE_THINKING refused by the API for this model, so the model's own default was used." };
      return again;
    }
    return { ok: false, status: r.status, problem: data?.error?.type || "unknown", detail: data?.error?.message || "" };
  }
  return { ok: true, data };
}

// The text the model wrote, with the non-text parts dropped.
// Returns "" when the model wrote nothing, which the check route reports as empty_answer.
export function textOf(data) {
  return (data?.content || []).filter((c) => c.type === "text").map((c) => c.text).join("\n").trim();
}
