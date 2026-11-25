// Undo the OSHA Check field writes (lib/undo.js). Behind the site passcode, like "Run now":
//   /api/clickup/undo?manual=1            dry run: how many work orders it would put back, nothing touched
//   /api/clickup/undo?manual=1&confirm=1  put back up to 40; call again until "remaining" is 0
// Undo is itself a write to the one field, so it follows the same rules as writing: CLICKUP_WRITE=on
// and the list in CLICKUP_WRITE_LISTS. Undo first, then narrow the lists.
import { getTask } from "../../../../lib/clickup";
import { undoField } from "../../../../lib/fieldwrite";
import { undoRun } from "../../../../lib/undo";
import { ensureTables } from "../../../../lib/sync";
import { getSql } from "../../../../lib/db";
export const dynamic = "force-dynamic";
export const maxDuration = 300;

export async function GET(req) {
  const url = new URL(req.url);
  if (!(url.searchParams.get("manual") === "1" && process.env.SITE_PASSCODE)) {
    return Response.json({ ok: false, problem: "Not allowed: undo runs only behind the site passcode." }, { status: 401 });
  }
  const token = process.env.CLICKUP_API_TOKEN, sql = getSql();
  if (!token || !sql) return Response.json({ ok: false, problem: "Undo needs CLICKUP_API_TOKEN and DATABASE_URL in Vercel." }, { status: 501 });
  await ensureTables(sql);
  const out = await undoRun({
    sql, confirm: url.searchParams.get("confirm") === "1",
    undo: (r, wrote) => undoField({ token, taskId: r.task_id, wrote, prev: r.field_prev, getTask: (id) => getTask({ token, id }) }),
  });
  return Response.json({ ok: true, ...out });
}
