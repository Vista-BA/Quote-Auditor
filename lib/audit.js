// More quote checks, all worked out in code from data the tool already has (no model call, nothing
// written to ClickUp). Shown in the tool only; the owner's rule allows one ClickUp field.
//   completenessOf  the standard parts of a quote that are missing
//   confirmList     the facts the answer says to confirm before sending
//   duplicatesOf    another checked quote for the same client, store and job within 30 days
//   daysWaiting     how long a quote has sat in its waiting status, as far as the tool has seen
//   clientRule      a client's own rules (CLIENT_RULES), so overtime reads "allowed", not "for review"

// The parts a quote is written with. Each test runs on the stored quote, which has its dollar
// amounts removed, so the total is found by its label, not its amount.
const PARTS = [
  ["What the tech found", /tech(?:nician)?\s*report/i],
  ["The scope (Required is to)", /required\s+is\s+to|scope\s+of\s+work|\bscope\s*:/i],
  ["Labor lines", /^[^\n]*\d+(?:\.\d+)?\s*(?:labou?r\s*)?(?:hours?|hrs?|h)\b[^\n]*(?:labou?r|tech|helper)/im],
  ["A total", /^[ \t]*(?:grand[ \t]+)?total\b/im],
];
export function completenessOf(quote) {
  const q = String(quote || "");
  if (q.trim().length < 20) return { complete: false, missing: ["The quote itself"] };
  const missing = PARTS.filter(([, re]) => !re.test(q)).map(([name]) => name);
  return { complete: missing.length === 0, missing };
}

// "Need the mirror's weight" in the summary line, and the "Worth checking" line, as a short list.
export function confirmList(answer) {
  const text = String(answer || "");
  const out = [];
  for (const m of text.matchAll(/OSHA:\s*([^|\n]*)\|\s*Safety:\s*([^|\n]*)\|\s*Two-person step:\s*([^\n]*)/gi)) {
    for (const v of [m[1], m[2], m[3]]) {
      const s = v.trim();
      if (/^need\b/i.test(s)) out.push(s.replace(/^need\s+(?:to know\s+)?/i, "").replace(/[.\s]+$/, ""));
    }
  }
  for (const m of text.matchAll(/^worth checking:\s*(.+)$/gim)) out.push(m[1].trim().replace(/[.\s]+$/, ""));
  const seen = new Set();
  return out.filter((s) => s && !seen.has(s.toLowerCase()) && seen.add(s.toLowerCase())).slice(0, 4)
    .map((s) => s.charAt(0).toUpperCase() + s.slice(1));
}

// Two checked quotes for the same client, the same site and the same job type within `days`.
// Rows without a site are left out: without it two different sites would look the same. A brand
// name alone ("Dollar Tree", no address or store number) is not a site, so it needs a digit.
const norm = (s) => String(s || "").trim().toLowerCase().replace(/\s+/g, " ");
export function duplicatesOf(rows, days = 30) {
  const groups = new Map();
  for (const r of rows) {
    if (!/\d/.test(r.store || "") || !r.job || r.job === "Other") continue;
    const k = `${norm(r.fm)}|${norm(r.store)}|${r.job}`;
    (groups.get(k) || groups.set(k, []).get(k)).push(r);
  }
  const out = {};
  const span = days * 86400000;
  for (const list of groups.values()) {
    if (list.length < 2) continue;
    for (const r of list) {
      const near = list.filter((o) => o.task_id !== r.task_id && Math.abs(new Date(o.checked_at) - new Date(r.checked_at)) <= span);
      if (near.length) out[r.task_id] = near.map((o) => ({ task_id: o.task_id, task_name: o.task_name, task_url: o.task_url || null, checked_at: o.checked_at }));
    }
  }
  return out;
}

// Whole days since the tool first saw the quote in its current status. A lower bound: the tool
// only knows from the day it started keeping it (Nov 23).
export function daysWaiting(since, now = Date.now()) {
  if (!since) return null;
  return Math.max(0, Math.floor((now - new Date(since).getTime()) / 86400000));
}
export const isWaitingApproval = (status) => /waiting for approval/i.test(String(status || ""));

// CLIENT_RULES in Vercel: {"EMCOR": {"overtime": "allowed" | "not allowed" | "with reason"}}.
// Matched on the client name, case and spacing aside. Unset: the overtime note stays "for review".
export function readRules(env = process.env) {
  try { return env.CLIENT_RULES ? JSON.parse(env.CLIENT_RULES) : null; } catch { return null; }
}
export function clientRule(rules, client) {
  if (!rules || !client) return null;
  const key = Object.keys(rules).find((k) => norm(k) === norm(client));
  return key ? { client: key, ...rules[key] } : null;
}
// The overtime note when the client has a rule; null means use the general note.
export function overtimeRuleText(ot, rule) {
  if (!ot?.billed || !rule?.overtime) return null;
  const who = rule.client;
  if (rule.overtime === "not allowed") return `${who} does not allow overtime: quote regular time.`;
  if (rule.overtime === "with reason") return ot.reason ? `${who} allows overtime with a reason, and the reason is written.` : `${who} allows overtime only with a written reason: add why (store hours, emergency, client request).`;
  if (rule.overtime === "allowed") return `${who} allows overtime.`;
  return null;
}
