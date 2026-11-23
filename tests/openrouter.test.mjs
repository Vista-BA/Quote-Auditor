// The OpenRouter switch in lib/anthropic.js, with fetch faked: no network, no credit.
//   node tests/openrouter.test.mjs
import { callClaude, isOpenRouter, openRouterModel, llmKey, toOpenRouter, fromOpenRouter } from "../lib/anthropic.js";

let pass = 0, fail = 0;
const eq = (name, got, want) => {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  ok ? pass++ : fail++;
  if (!ok) console.log(`FAIL ${name}: got ${JSON.stringify(got)}, want ${JSON.stringify(want)}`);
};

eq("an sk-or- key goes to OpenRouter", [isOpenRouter("sk-or-v1-abc", {}), isOpenRouter("sk-ant-api03-x", {})], [true, false]);
eq("or by setting", isOpenRouter("anything", { LLM_PROVIDER: "openrouter" }), true);
eq("model id on OpenRouter", openRouterModel("claude-haiku-5-5", {}), "anthropic/claude-haiku-5.5");
eq("model id override", openRouterModel("claude-haiku-5-5", { OPENROUTER_MODEL: "anthropic/x" }), "anthropic/x");
eq("key from either variable", [llmKey({ ANTHROPIC_API_KEY: "a" }), llmKey({ OPENROUTER_API_KEY: "b" }), llmKey({})], ["a", "b", ""]);

const body = toOpenRouter({ model: "claude-haiku-5-5", system: [{ type: "text", text: "SKILL", cache_control: { type: "ephemeral" } }, { type: "text", text: "cards" }], user: "quote", maxTokens: 4000 }, {});
eq("system blocks keep the cache mark", body.messages[0], { role: "system", content: [{ type: "text", text: "SKILL", cache_control: { type: "ephemeral" } }, { type: "text", text: "cards" }] });
eq("user message and limits", [body.messages[1], body.max_tokens, body.model], [{ role: "user", content: "quote" }, 16000, "anthropic/claude-haiku-5.5"]);

const reply = fromOpenRouter({ model: "anthropic/claude-haiku-5.5", choices: [{ message: { content: "This quote doesn't show a reason." }, finish_reason: "stop" }], usage: { prompt_tokens: 5000, completion_tokens: 300, prompt_tokens_details: { cached_tokens: 4200 } } });
eq("reply in Anthropic's shape", [reply.content, reply.stop_reason], [[{ type: "text", text: "This quote doesn't show a reason." }], "end_turn"]);
eq("usage keeps the cached part apart", reply.usage, { input_tokens: 800, output_tokens: 300, cache_read_input_tokens: 4200, cache_creation_input_tokens: 0 });
eq("a tiny call keeps its own limit", toOpenRouter({ model: "m", user: "x", maxTokens: 5 }, {}).max_tokens, 5);
eq("cut off answer reads as max_tokens", fromOpenRouter({ choices: [{ message: { content: "x" }, finish_reason: "length" }] }).stop_reason, "max_tokens");

// the whole call, fetch faked
const calls = [];
globalThis.fetch = async (url, init) => { calls.push({ url, auth: init.headers.Authorization, body: JSON.parse(init.body) }); return new Response(JSON.stringify({ choices: [{ message: { content: "ok" }, finish_reason: "stop" }], usage: { prompt_tokens: 10, completion_tokens: 1 } }), { status: 200 }); };
let r = await callClaude({ key: "sk-or-v1-test", model: "claude-haiku-5-5", user: "Reply with: ok", maxTokens: 5 });
eq("calls OpenRouter with a Bearer key", [r.ok, calls[0].url, calls[0].auth], [true, "https://openrouter.ai/api/v1/chat/completions", "Bearer sk-or-v1-test"]);
eq("answer text comes back", r.data.content[0].text, "ok");
globalThis.fetch = async () => new Response(JSON.stringify({ error: { message: "No auth credentials found", code: 401 } }), { status: 401 });
r = await callClaude({ key: "sk-or-v1-bad", model: "claude-haiku-5-5", user: "x", maxTokens: 5 });
eq("a refused key is named, with OpenRouter's reason", [r.ok, r.problem, r.detail], [false, "authentication_error", "OpenRouter: No auth credentials found"]);
r = await callClaude({ key: "sk-or-v1-x", model: "claude-haiku-5-5", messages: [], tools: [{}], maxTokens: 5 });
eq("tool calls are refused, so agentic falls back to the fixed search", [r.ok, r.problem], [false, "not_supported"]);
globalThis.fetch = async (url, init) => { calls.push({ url, key: init.headers["x-api-key"] }); return new Response(JSON.stringify({ content: [{ type: "text", text: "ok" }] }), { status: 200 }); };
r = await callClaude({ key: "sk-ant-api03-x", model: "claude-haiku-5-5", user: "x", maxTokens: 5 });
eq("an Anthropic key still goes to Anthropic", [calls.at(-1).url, calls.at(-1).key], ["https://api.anthropic.com/v1/messages", "sk-ant-api03-x"]);

console.log(`${pass}/${pass + fail} passed`);
process.exit(fail ? 1 : 0);
