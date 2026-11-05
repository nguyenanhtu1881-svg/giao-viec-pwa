import { readFile } from "node:fs/promises";
import assert from "node:assert/strict";
const { PGlite } = await import(process.env.PGLITE_MODULE_PATH || "@electric-sql/pglite");

const database = await PGlite.create();
const migrationsUrl = new URL("../supabase/migrations/", import.meta.url);

try {
  await database.exec(`
    create role anon;
    create role authenticated;
    create role service_role;
    create role supabase_auth_admin;
    create schema auth;
    create schema storage;
    grant usage on schema storage to authenticated;
    create table auth.users (
      id uuid primary key,
      email text,
      raw_user_meta_data jsonb default '{}'::jsonb
    );
    create function auth.uid() returns uuid language sql stable as $$
      select nullif(current_setting('request.jwt.claim.sub', true), '')::uuid
    $$;
    create table storage.buckets (
      id text primary key,
      name text,
      public boolean,
      file_size_limit bigint,
      allowed_mime_types text[]
    );
    create table storage.objects (
      id uuid primary key default gen_random_uuid(),
      bucket_id text,
      name text
    );
    alter table storage.objects enable row level security;
    grant select, insert, delete on storage.objects to authenticated;
    create function storage.foldername(name text) returns text[]
      language sql immutable as $$ select string_to_array(name, '/') $$;
  `);

  const migrationFiles = [
    "20261102000000_core_task_schema.sql",
    "20261103065414_vehicle_intake_foundation.sql",
    "20261103065555_fix_intake_station_policy_and_upload_rollback.sql",
    "20261103071430_admin_staff_roles_and_pending_activation.sql",
    "20261103071458_restrict_account_and_station_admin_to_primary.sql",
    "20261105090000_vehicle_multi_technician_workflow.sql",
    "20261105100000_harden_api_security_definers.sql",
  ];

  for (const filename of migrationFiles) {
    let sql = await readFile(new URL(filename, migrationsUrl), "utf8");
    if (filename === "20261105090000_vehicle_multi_technician_workflow.sql") {
      // PGlite does not implement PostgreSQL publications; the Supabase Realtime block is checked separately.
      sql = sql.replace(/do \$\$[\s\S]*?alter publication supabase_realtime[\s\S]*?\$\$;/i, "");
    }
    await database.exec(sql);
    console.log(`PASS ${filename}`);
  }

  const checks = await database.query(`
    select to_regclass('public.work_orders') as work_orders,
           to_regclass('public.work_assignments') as work_assignments,
           to_regclass('public.work_assignment_events') as assignment_events,
           to_regclass('public.work_order_events') as order_events,
           exists (select 1 from information_schema.columns
                   where table_schema = 'public' and table_name = 'vehicle_intakes'
                     and column_name = 'plate_confirmed') as plate_confirmation_column,
           (select count(*) from pg_policies
            where schemaname in ('public', 'storage')) as policy_count
  `);
  console.log("SCHEMA", JSON.stringify(checks.rows[0]));

  const users = [
    ["00000000-0000-4000-8000-000000000001", "tu.nguyen@hyundaimiennam.com", "Admin chính"],
    ["00000000-0000-4000-8000-000000000002", "admin2@example.test", "Admin phụ"],
    ["00000000-0000-4000-8000-000000000003", "intake@example.test", "Tiếp nhận"],
    ["00000000-0000-4000-8000-000000000004", "tech1@example.test", "Kỹ thuật viên 1"],
    ["00000000-0000-4000-8000-000000000005", "tech2@example.test", "Kỹ thuật viên 2"],
    ["00000000-0000-4000-8000-000000000006", "employee@example.test", "Nhân viên khác"],
  ];
  for (const [id, email, name] of users) {
    await database.query(
      "insert into auth.users(id,email,raw_user_meta_data) values ($1,$2,jsonb_build_object('full_name',$3::text))",
      [id, email, name],
    );
  }
  await database.exec(`
    update public.profiles set active=true, role='admin' where id='${users[0][0]}';
    update public.profiles set active=true, role='admin' where id='${users[1][0]}';
    update public.profiles set active=true, work_role='intake' where id='${users[2][0]}';
    update public.profiles set active=true, work_role='technician' where id in ('${users[3][0]}','${users[4][0]}');
    update public.profiles set active=true where id='${users[5][0]}';
    insert into public.intake_station_users(profile_id,station_no) values ('${users[2][0]}',1);
  `);

  const intakeUser = users[2][0];
  await database.query("select set_config('request.jwt.claim.sub',$1,false)", [intakeUser]);
  await database.exec("set role authenticated");
  await assert.rejects(
    database.query("insert into storage.objects(bucket_id,name) values ('vehicle-intakes','someone-else/bad.jpg')"),
    /row-level security|violates row-level security/i,
  );
  await database.query("insert into storage.objects(bucket_id,name) values ('vehicle-intakes',$1)", [`${intakeUser}/bad.jpg`]);
  await assert.rejects(
    database.query(`insert into public.vehicle_intakes(plate_number,document_type,image_path,station_no,received_by,plate_confirmed)
      values ('51A-111.11','quotation','${intakeUser}/bad.jpg',1,'${intakeUser}',false)`),
    /row-level security|violates row-level security/i,
  );
  await database.query("delete from storage.objects where bucket_id='vehicle-intakes' and name=$1", [`${intakeUser}/bad.jpg`]);
  const rolledBackImage = await database.query("select count(*)::int as n from storage.objects where name=$1", [`${intakeUser}/bad.jpg`]);
  assert.equal(rolledBackImage.rows[0].n, 0);
  await database.query("insert into storage.objects(bucket_id,name) values ('vehicle-intakes',$1)", [`${intakeUser}/good.jpg`]);
  const submitted = await database.query(`insert into public.vehicle_intakes
    (plate_number,document_type,image_path,station_no,received_by,plate_confirmed)
    values ('51A-111.11','quotation','${intakeUser}/good.jpg',1,'${intakeUser}',true) returning id`);
  const intakeId = submitted.rows[0].id;
  await database.exec("reset role");
  console.log("PASS intake and Storage RLS require plate confirmation and own upload path");

  const adminId = users[0][0];
  await database.query("select set_config('request.jwt.claim.sub',$1,false)", [adminId]);
  await database.exec("set role authenticated");
  const order = await database.query(
    "select public.assign_vehicle_technicians($1,$2::uuid[],null) as id",
    [intakeId, [users[3][0], users[4][0]]],
  );
  const orderId = order.rows[0].id;
  const assignments = await database.query(
    "select id, technician_id, status from public.work_assignments where work_order_id=$1 order by technician_id",
    [orderId],
  );
  assert.equal(assignments.rows.length, 2);
  const assignmentByTech = new Map(assignments.rows.map((row) => [row.technician_id, row.id]));
  await database.query("select set_config('request.jwt.claim.sub',$1,false)", [users[3][0]]);
  const visibleImage = await database.query("select count(*)::int as n from storage.objects where name=$1", [`${intakeUser}/good.jpg`]);
  assert.equal(visibleImage.rows[0].n, 1, "an assigned technician must read the intake image");
  await database.query("select set_config('request.jwt.claim.sub',$1,false)", [users[5][0]]);
  const hiddenOrder = await database.query("select count(*)::int as n from public.work_orders where id=$1", [orderId]);
  const hiddenImage = await database.query("select count(*)::int as n from storage.objects where name=$1", [`${intakeUser}/good.jpg`]);
  assert.equal(hiddenOrder.rows[0].n, 0, "an unrelated employee must not see the work order");
  assert.equal(hiddenImage.rows[0].n, 0, "an unrelated employee must not read the intake image");
  await database.query("select set_config('request.jwt.claim.sub',$1,false)", [users[3][0]]);
  await database.query("select public.set_work_assignment_status($1,'doing',null)", [assignmentByTech.get(users[3][0])]);
  await database.exec("reset role");
  let statuses = await database.query("select technician_id,status from public.work_assignments where work_order_id=$1", [orderId]);
  assert.deepEqual(new Set(statuses.rows.map((row) => row.status)), new Set(["doing", "todo"]));
  await database.exec("set role authenticated");
  const visibleOrder = await database.query("select count(*)::int as n from public.work_orders where id=$1", [orderId]);
  assert.equal(visibleOrder.rows[0].n, 1, "a technician must see a work order linked to their assignment");
  await assert.rejects(
    database.query("select public.set_work_assignment_status($1,'paused',null)", [assignmentByTech.get(users[3][0])]),
    /lý do/i,
  );
  await database.query("select public.set_work_assignment_status($1,'paused','Chờ phụ tùng')", [assignmentByTech.get(users[3][0])]);
  const history = await database.query("select pause_reason from public.work_assignment_events where assignment_id=$1 order by created_at desc limit 1", [assignmentByTech.get(users[3][0])]);
  assert.equal(history.rows[0].pause_reason, "Chờ phụ tùng");
  await database.query("select public.set_work_assignment_status($1,'done',null)", [assignmentByTech.get(users[3][0])]);
  let state = await database.query("select status from public.work_orders where id=$1", [orderId]);
  assert.equal(state.rows[0].status, "active");
  await database.query("select set_config('request.jwt.claim.sub',$1,false)", [users[4][0]]);
  await database.query("select public.set_work_assignment_status($1,'done',null)", [assignmentByTech.get(users[4][0])]);
  state = await database.query(`select wo.status,vi.status as intake_status,wo.completed_at
    from public.work_orders wo join public.vehicle_intakes vi on vi.id=wo.vehicle_intake_id where wo.id=$1`, [orderId]);
  assert.equal(state.rows[0].status, "completed");
  assert.equal(state.rows[0].intake_status, "closed");
  assert.ok(state.rows[0].completed_at);
  await database.exec("reset role");
  const eventCount = await database.query("select count(*)::int as n from public.work_assignment_events where assignment_id=$1", [assignmentByTech.get(users[3][0])]);
  assert.ok(eventCount.rows[0].n >= 4);
  await database.exec("set role authenticated");
  console.log("PASS independent technician states, pause reason/history, and all-done completion");

  await database.exec("reset role");
  await database.query("select set_config('request.jwt.claim.sub',$1,false)", [adminId]);
  const overrideIntake = await database.query(`insert into public.vehicle_intakes
    (plate_number,document_type,image_path,station_no,received_by,plate_confirmed,status)
    values ('51A-222.22','inspection','${intakeUser}/override.jpg',1,'${intakeUser}',true,'assigned') returning id`);
  await database.exec("set role authenticated");
  const overrideOrder = await database.query(
    "select public.assign_vehicle_technicians($1,$2::uuid[],null) as id",
    [overrideIntake.rows[0].id, [users[4][0]]],
  );
  await database.query("select public.admin_complete_work_order($1,'Khách đổi lịch')", [overrideOrder.rows[0].id]);
  const overridden = await database.query("select status,override_reason from public.work_orders where id=$1", [overrideOrder.rows[0].id]);
  assert.equal(overridden.rows[0].status, "completed_override");
  assert.equal(overridden.rows[0].override_reason, "Khách đổi lịch");
  console.log("PASS administrator exception completion requires and records reason");

  await database.exec("reset role");
  const activeIntake = await database.query(`insert into public.vehicle_intakes
    (plate_number,document_type,image_path,station_no,received_by,plate_confirmed,status)
    values ('51A-333.33','quotation','${intakeUser}/active.jpg',1,'${intakeUser}',true,'assigned') returning id`);
  await database.query("select set_config('request.jwt.claim.sub',$1,false)", [adminId]);
  await database.exec("set role authenticated");
  await database.query(
    "select public.assign_vehicle_technicians($1,$2::uuid[],null)",
    [activeIntake.rows[0].id, [users[3][0]]],
  );
  await database.exec("reset role");
  await database.exec(`update public.work_orders set completed_at=now()-interval '46 days'
    where id='${orderId}';`);
  await database.exec("set role service_role");
  const claimed = await database.query("select * from public.claim_expired_vehicle_intakes(25)");
  assert.deepEqual(claimed.rows.map((row) => row.intake_id), [intakeId]);
  assert.ok(!claimed.rows.some((row) => row.intake_id === activeIntake.rows[0].id));
  const removed = await database.query("select public.complete_retention_for_intake($1) as deleted", [intakeId]);
  assert.equal(removed.rows[0].deleted, true);
  await database.exec("reset role");
  const left = await database.query("select count(*)::int as n from public.vehicle_intakes where id=$1", [intakeId]);
  assert.equal(left.rows[0].n, 0);
  const activeLeft = await database.query(`select vi.status as intake_status,wo.status as order_status
    from public.vehicle_intakes vi join public.work_orders wo on wo.vehicle_intake_id=vi.id
    where vi.id=$1`, [activeIntake.rows[0].id]);
  assert.deepEqual(activeLeft.rows[0], { intake_status: "assigned", order_status: "active" });
  console.log("PASS 45-day retention deletes only completed closed intake and preserves active work");
} finally {
  await database.close();
}
