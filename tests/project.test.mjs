import assert from "node:assert/strict";
import { readFile, readdir } from "node:fs/promises";
import { test } from "node:test";

const read = (path) => readFile(new URL(`../${path}`, import.meta.url), "utf8");

test("static DOM references in app.js exist in index.html", async () => {
  const [html, app] = await Promise.all([read("index.html"), read("app.js")]);
  const ids = [...html.matchAll(/\bid="([^"]+)"/g)].map((match) => match[1]);
  const idSet = new Set(ids);
  assert.equal(idSet.size, ids.length, "index.html must not contain duplicate IDs");

  const references = [...app.matchAll(/(?:\$\(|show\(|msg\()\s*["']([^"']+)["']/g)]
    .map((match) => match[1]);
  const missing = [...new Set(references.filter((id) => !idSet.has(id)))];
  assert.deepEqual(missing, []);
});

test("tracked database history and new workflow migration are present", async () => {
  const files = (await readdir(new URL("../supabase/migrations/", import.meta.url))).sort();
  for (const version of [
    "20261102000000_core_task_schema.sql",
    "20261103065414_vehicle_intake_foundation.sql",
    "20261103065555_fix_intake_station_policy_and_upload_rollback.sql",
    "20261103071430_admin_staff_roles_and_pending_activation.sql",
    "20261103071458_restrict_account_and_station_admin_to_primary.sql",
    "20261105090000_vehicle_multi_technician_workflow.sql",
    "20261105100000_harden_api_security_definers.sql",
  ]) assert.ok(files.includes(version), `Missing migration ${version}`);
});

test("workflow SQL keeps assignments independent and pauses auditable", async () => {
  const sql = await read("supabase/migrations/20261105090000_vehicle_multi_technician_workflow.sql");
  assert.match(sql, /unique\s*\(work_order_id, technician_id\)/i);
  assert.match(sql, /status in \('todo', 'doing', 'paused', 'done'\)/i);
  assert.match(sql, /status = 'paused' and nullif\(btrim\(pause_reason\), ''\) is not null/i);
  assert.match(sql, /work_assignment_events/);
  assert.match(sql, /exists \(\s*select 1 from public\.work_assignments where work_order_id = target_order_id\s*\) and not exists/i);
  assert.match(sql, /revoke all on function public\.set_work_assignment_status\(uuid, text, text\) from public, anon/i);
});

test("API hardening keeps authorization helpers private and writes least-privilege", async () => {
  const sql = await read("supabase/migrations/20261105100000_harden_api_security_definers.sql");
  assert.match(sql, /create schema if not exists private/i);
  assert.match(sql, /create or replace function private\.is_admin\(\)[\s\S]*?security definer/i);
  assert.match(sql, /create or replace function private\.is_assigned_to_intake\(p_intake_id uuid\)[\s\S]*?security definer/i);
  assert.match(sql, /revoke all on function public\.is_admin\(\) from public, anon, authenticated/i);
  assert.match(sql, /revoke all on function public\.is_assigned_to_intake\(uuid\) from public, anon, authenticated/i);
  assert.match(sql, /create or replace function public\.update_task_status[\s\S]*?language plpgsql\s+security invoker\s+set search_path/i);
  assert.match(sql, /revoke all privileges on table public\.profiles, public\.tasks[\s\S]*?public\.work_order_events\s+from public, anon, authenticated/i);
  assert.match(sql, /revoke all privileges \(id, title, notes, status, priority, due_at, assignee_id, created_by, created_at, updated_at\)\s+on table public\.tasks from public, anon, authenticated/i);
  assert.match(sql, /grant update \(status\) on public\.tasks to authenticated/i);
  assert.match(sql, /private\.assignment_due_at_unchanged\(id, due_at\)/i);
  assert.match(sql, /create trigger touch_work_assignment_updated_at/i);
  assert.match(sql, /create policy "assigned technicians update own active assignment"/i);
});

test("retention removes Storage files before deleting eligible closed intakes", async () => {
  const [sql, functionSource] = await Promise.all([
    read("supabase/migrations/20261105090000_vehicle_multi_technician_workflow.sql"),
    read("supabase/functions/retention-cleanup/index.js"),
  ]);
  assert.match(sql, /wo\.status in \('completed', 'completed_override'\)/i);
  assert.match(sql, /wo\.completed_at <= now\(\) - interval '45 days'/i);
  assert.match(sql, /vi\.status = 'closed'/i);
  assert.match(sql, /retention_claimed_at/);
  assert.ok(functionSource.indexOf("/storage/v1/object/vehicle-intakes") < functionSource.indexOf("complete_retention_for_intake"));
  assert.match(functionSource, /x-retention-secret/);
});

