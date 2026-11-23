// Vol 2: the stored results of the daily automatic check, newest first, for /queue.
// Behind the site passcode like every other route.
// Each row's history line is redrawn here from the current ENTITY_HISTORY, so loading newer
// numbers in Vercel updates every row at once. Rows saved before the quote was stored get it here,
// fetched from ClickUp (GET only, no new check).
import { getSql } from "../../../../lib/db";
import { historyLine } from "../../../../lib/history";
import { getTask } from "../../../../lib/clickup";
import { ensureTables, fillQuotes } from "../../../../lib/sync";
import { writeSettings } from "../../../../lib/fieldwrite";
import { recentCalls } from "../../../../lib/webhook";
import { crewCheckLine } from "../../../../lib/fieldline";
import { nteText, overtimeOf, overtimeText } from "../../../../lib/quotefacts";
import { completenessOf, confirmList, duplicatesOf, daysWaiting, isWaitingApproval, readRules, clientRule, overtimeRuleText } from "../../../../lib/audit";
export const dynamic = "force-dynamic";

export async function GET() {
  const sql = getSql();
  const ws = writeSettings();
  const flags = { auto: !!process.env.CRON_SECRET, manual: !!process.env.SITE_PASSCODE, hook: !!process.env.WEBHOOK_SECRET,
    write: { on: ws.on, field: ws.fieldId || ws.fieldName, lists: ws.lists } };
  if (!sql) return Response.json({ ok: false, problem: "DATABASE_URL is not set in Vercel." });
  let history = null;
  try { history = process.env.ENTITY_HISTORY ? JSON.parse(process.env.ENTITY_HISTORY) : null; } catch { history = null; }
  // The last webhook calls from ClickUp and what became of each, so a call that arrived but
  // stored nothing shows its reason here instead of only in the Vercel log.
  let webhook = [];
  try { webhook = await recentCalls(sql, 10); } catch { webhook = []; }
  try {
    await ensureTables(sql);
    const rows = await sql.query(
      `select task_id, task_name, task_url, status, entity, fm, state, headline, answer, history, job, quote, ok, problem, checked_at,
         field_written_at, field_note, quote_check, nte_state, nte_pct, quote_hash, now_hash, store, status_since
       from auto_checks order by checked_at desc limit 200`);
    // Every version of these quotes the tool has checked, oldest first, for the drawer's timeline.
    let versions = [];
    try {
      versions = await sql.query(`select task_id, line, t2_hours, status, checked_at from check_versions
        where task_id = any($1::text[]) order by checked_at`, [rows.map((r) => r.task_id)]);
    } catch { versions = []; }
    const token = process.env.CLICKUP_API_TOKEN;
    if (token) await fillQuotes({ rows, sql, getTask: (id) => getTask({ token, id }) });
    // Possible duplicates are looked for across every checked quote with a store, not only these 200.
    let dupes = {};
    try { dupes = duplicatesOf(await sql.query(`select task_id, task_name, task_url, fm, store, job, checked_at from auto_checks where store is not null`)); } catch { dupes = {}; }
    const rules = readRules();
    for (const r of rows) {
      r.history = (r.job && historyLine(history, r.entity, r.job, r.fm)) || r.history;
      // What the "Crew check" field in ClickUp would say. Preview only: nothing is written to ClickUp.
      r.field = r.ok ? crewCheckLine(r.answer, r.quote) : null;
      // Shown in the tool only, never written to ClickUp (the owner's rule allows one field).
      r.nte = r.nte_state ? { state: r.nte_state, pct: r.nte_pct, text: nteText({ state: r.nte_state, pct: r.nte_pct }) } : null;
      const ot = overtimeOf(r.quote);
      const rule = clientRule(rules, r.fm);
      // Flagged unless the client's rule allows overtime: no rule means a reason must be written.
      const otFlag = ot.billed && (rule?.overtime === "not allowed" || (rule?.overtime !== "allowed" && !ot.reason));
      r.ot = ot.billed ? { reason: ot.reason, flag: otFlag, text: overtimeRuleText(ot, rule) || overtimeText(ot), rule: rule?.overtime || null } : null;
      r.complete = completenessOf(r.quote);
      r.confirm = r.ok ? confirmList(r.answer) : [];
      r.duplicates = dupes[r.task_id] || [];
      r.days_waiting = isWaitingApproval(r.status) ? daysWaiting(r.status_since) : null;
      r.changed_since = !!(r.now_hash && r.quote_hash && r.now_hash !== r.quote_hash);
      r.versions = versions.filter((v) => v.task_id === r.task_id).map(({ task_id, ...v }) => v);
      delete r.quote_hash; delete r.now_hash; delete r.nte_state; delete r.nte_pct; delete r.status_since;
    }
    return Response.json({ ok: true, rows, webhook, ...flags, history_entities: Object.keys(history?.entities || {}), history_built: history?.built || null });
  } catch (e) {
    // The table appears on the first run.
    return Response.json({ ok: true, rows: [], webhook, ...flags });
  }
}
