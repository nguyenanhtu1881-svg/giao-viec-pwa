import assert from "node:assert/strict";
import { readFile, readdir } from "node:fs/promises";
import vm from "node:vm";
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

test("service worker only caches successful responses and uses offline HTML for navigation", async () => {
  const source = await read("sw.js");

  async function requestThroughWorker(request, networkFetch) {
    const listeners = {};
    const entries = new Map([["./index.html", { source: "cached offline page" }]]);
    const cache = {
      addAll: async () => {},
      put: async (key, value) => entries.set(typeof key === "string" ? key : key.url, value),
    };
    const caches = {
      open: async () => cache,
      match: async (key) => entries.get(typeof key === "string" ? key : key.url),
      keys: async () => [],
      delete: async () => true,
    };
    vm.runInNewContext(source, {
      self: { addEventListener: (name, handler) => { listeners[name] = handler; } },
      caches,
      fetch: networkFetch,
      location: { origin: "https://example.test" },
      URL,
    });

    let responsePromise;
    listeners.fetch({ request, respondWith: (promise) => { responsePromise = promise; } });
    return { responsePromise, entries };
  }

  const failedAsset = await requestThroughWorker(
    { method: "GET", url: "https://example.test/app.js", mode: "no-cors" },
    async () => { throw new Error("offline"); },
  );
  await assert.rejects(failedAsset.responsePromise, /offline/);
  assert.equal(failedAsset.entries.has("https://example.test/app.js"), false);

  const offlineNavigation = await requestThroughWorker(
    { method: "GET", url: "https://example.test/work-orders", mode: "navigate" },
    async () => { throw new Error("offline"); },
  );
  assert.deepEqual(await offlineNavigation.responsePromise, { source: "cached offline page" });

  const failedResponse = await requestThroughWorker(
    { method: "GET", url: "https://example.test/missing.js", mode: "no-cors" },
    async () => ({ ok: false, type: "basic", status: 404, clone() { return this; } }),
  );
  await failedResponse.responsePromise;
  assert.equal(failedResponse.entries.has("https://example.test/missing.js"), false);
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
  const app = await read("app.js");
  assert.match(sql, /unique\s*\(work_order_id, technician_id\)/i);
  assert.match(sql, /status in \('todo', 'doing', 'paused', 'done'\)/i);
  assert.match(sql, /status = 'paused' and nullif\(btrim\(pause_reason\), ''\) is not null/i);
  assert.match(sql, /work_assignment_events/);
  assert.match(sql, /exists \(\s*select 1 from public\.work_assignments where work_order_id = target_order_id\s*\) and not exists/i);
  assert.match(sql, /revoke all on function public\.set_work_assignment_status\(uuid, text, text\) from public, anon/i);
  for (const table of ["work_orders", "work_assignments", "vehicle_intakes"])
    assert.match(sql, new RegExp(`alter publication supabase_realtime add table public\\.${table}`, "i"));
  for (const table of ["work_orders", "work_assignments", "vehicle_intakes"])
    assert.match(app, new RegExp(`table:"${table}"`));
});

test("intake assignment uses a touch-friendly multi-technician checkbox list", async () => {
  const app = await read("app.js");
  const styles = await read("styles.css");
  assert.match(app, /technician-picker/);
  assert.match(app, /type="checkbox" data-technician-id/);
  assert.match(app, /querySelectorAll\("\[data-technician-id\]:checked"\)/);
  assert.match(styles, /\.technician-option\{display:flex/);
  assert.match(styles, /min-height:44px/);
});

test("vehicle intake requires a selected document type and explicit plate confirmation", async () => {
  const [html, app] = await Promise.all([read("index.html"), read("app.js")]);
  assert.match(html, /id="intakeDocumentType" required/);
  assert.match(html, /id="intakePlateConfirmed" type="checkbox" required/);
  assert.match(app, /!\["quotation", "inspection"\]\.includes\(documentType\)/);
  assert.match(app, /!\$\("intakePlateConfirmed"\)\.checked/);
  assert.match(app, /intakePlateConfirmed"\)\.checked = false;/);
  assert.ok(app.includes('plate_confirmed: $("intakePlateConfirmed").checked'));
  assert.match(app, /plate_confirmed,receiver:/);
  assert.match(app, /Chưa ghi nhận xác nhận biển số/);
  assert.match(app, /function clearIntakePreview\(\)[\s\S]*?URL\.revokeObjectURL\(intakePreviewUrl\)/);
  assert.match(app, /\$\("intakeImage"\)\?\.addEventListener\("change", e => \{[\s\S]*?clearIntakePreview\(\)/);
});

test("API hardening keeps authorization helpers private and writes least-privilege", async () => {
  const sql = await read("supabase/migrations/20261105100000_harden_api_security_definers.sql");
  assert.match(sql, /add column if not exists plate_confirmed boolean/i);
  assert.match(sql, /and plate_confirmed is true/i);
  assert.match(sql, /create schema if not exists private/i);
  assert.match(sql, /create or replace function private\.is_admin\(\)[\s\S]*?security definer/i);
  assert.match(sql, /create or replace function private\.is_assigned_to_intake\(p_intake_id uuid\)[\s\S]*?security definer/i);
  assert.match(sql, /where a\.work_order_id = work_orders\.id and a\.technician_id = \(select auth\.uid\(\)\)/i);
  assert.match(sql, /drop policy if exists "admin can update profiles" on public\.profiles/i);
  assert.match(sql, /create policy "intake station users read own or admin"[\s\S]*?private\.is_admin\(\)/i);
  assert.match(sql, /create policy "intake users read own and admins read all"[\s\S]*?private\.is_admin\(\)/i);
  assert.match(sql, /drop policy if exists "admins update vehicle intakes" on public\.vehicle_intakes/i);
  assert.match(sql, /where a\.work_order_id = work_orders\.id and a\.technician_id = \(select auth\.uid\(\)\)/i);
  assert.match(sql, /revoke all on function public\.is_admin\(\) from public, anon, authenticated/i);
  assert.match(sql, /revoke all on function public\.is_assigned_to_intake\(uuid\) from public, anon, authenticated/i);
  assert.match(sql, /create or replace function private\.update_task_status[\s\S]*?language plpgsql\s+security definer/i);
  assert.match(sql, /create or replace function public\.update_task_status[\s\S]*?language sql\s+security invoker/i);
  assert.match(sql, /revoke all privileges on table public\.profiles, public\.tasks[\s\S]*?public\.work_order_events\s+from public, anon, authenticated/i);
  assert.match(sql, /revoke all privileges \(id, title, notes, status, priority, due_at, assignee_id, created_by, created_at, updated_at\)\s+on table public\.tasks from public, anon, authenticated/i);
  assert.doesNotMatch(sql, /grant\s+(?:insert|update|delete|truncate)[^;]+on public\.work_(?:orders|assignments)\s+to authenticated/i);
  assert.doesNotMatch(sql, /create policy "assigned technicians update own active assignment"/i);
  assert.match(sql, /create or replace function private\.assign_vehicle_technicians[\s\S]*?security definer/i);
  assert.match(sql, /create or replace function public\.assign_vehicle_technicians[\s\S]*?language sql\s+security invoker/i);
  assert.match(sql, /create or replace function private\.set_work_assignment_status[\s\S]*?security definer/i);
  assert.match(sql, /create or replace function public\.set_work_assignment_status[\s\S]*?language sql\s+security invoker/i);
  assert.match(sql, /create or replace function private\.admin_complete_work_order[\s\S]*?security definer/i);
  assert.match(sql, /create or replace function public\.admin_complete_work_order[\s\S]*?language sql\s+security invoker/i);
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
