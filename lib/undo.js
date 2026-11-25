// Undo for the OSHA Check field: put the field back on the work orders where the tool wrote it.
// A dry run by default (counts only, nothing touched); with confirm it acts on up to `limit` work
// orders per call, because each is a ClickUp read and a write. Only the one field is touched, only
// where it still says what the tool wrote (lib/fieldwrite.js, undoField), and an undone field is
// not filled again from the stored answer (lib/sync.js).
import { crewCheckLine } from "./fieldline.js";

export const UNDO_PER_CALL = 40;

export async function undoRun({ sql, undo, confirm = false, limit = UNDO_PER_CALL }) {
  const rows = await sql.query(
    `select task_id, task_name, answer, quote, field_line, field_prev from auto_checks
     where field_written_at is not null and field_undone_at is null order by field_written_at desc`);
  if (!confirm) return { dry_run: true, would_undo: rows.length, examples: rows.slice(0, 10).map((r) => r.task_name) };
  let undone = 0, leftAlone = 0, failed = 0, lastProblem = null;
  for (const r of rows.slice(0, limit)) {
    // Rows written before the text was kept: the line is worked out again from the stored answer.
    const wrote = r.field_line || crewCheckLine(r.answer, r.quote);
    let u;
    try { u = await undo(r, wrote); } catch (e) { failed++; lastProblem = String(e?.message || e).slice(0, 200); continue; }
    if (u.undone) undone++; else leftAlone++;
    await sql.query(
      `update auto_checks set field_undone_at = now(), field_written_at = case when $2::boolean then null else field_written_at end, field_note = $3 where task_id = $1`,
      [r.task_id, !!u.undone, u.undone ? `Undone: ${u.note}` : `Not undone. ${u.note}`]);
  }
  return { dry_run: false, undone, left_alone: leftAlone, failed, problem: lastProblem, remaining: Math.max(0, rows.length - undone - leftAlone) };
}
