-- Keep SECURITY DEFINER authorization helpers out of PostgREST's exposed schema.
create schema if not exists private;
revoke all on schema private from public, anon, authenticated, service_role;
grant usage on schema private to authenticated, service_role;

create or replace function private.is_admin()
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select exists (
    select 1 from public.profiles
    where id = (select auth.uid()) and role = 'admin' and active = true
  );
$$;

create or replace function private.is_primary_admin()
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select exists (
    select 1 from public.profiles
    where id = (select auth.uid())
      and email = 'tu.nguyen@hyundaimiennam.com'
      and role = 'admin'
      and active = true
  );
$$;

revoke all on function private.is_admin() from public, anon;
revoke all on function private.is_primary_admin() from public, anon;
grant execute on function private.is_admin() to authenticated, service_role;
grant execute on function private.is_primary_admin() to authenticated, service_role;

create or replace function private.is_assigned_to_intake(p_intake_id uuid)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select exists (
    select 1
    from public.work_orders wo
    join public.work_assignments wa on wa.work_order_id = wo.id
    where wo.vehicle_intake_id = p_intake_id
      and wa.technician_id = (select auth.uid())
  );
$$;
revoke all on function private.is_assigned_to_intake(uuid) from public, anon;
grant execute on function private.is_assigned_to_intake(uuid) to authenticated;

-- Preserve the employee's explicit plate confirmation for each newly submitted intake.
alter table public.vehicle_intakes
  add column if not exists plate_confirmed boolean;

-- Remove broad default/table and per-column grants before restoring app-required access.
revoke all privileges on table public.profiles, public.tasks,
  public.intake_station_users, public.vehicle_intakes,
  public.work_orders, public.work_assignments,
  public.work_assignment_events, public.work_order_events
  from public, anon, authenticated;
revoke all privileges (id, full_name, email, role, active, created_at, work_role)
  on table public.profiles from public, anon, authenticated;
revoke all privileges (id, title, notes, status, priority, due_at, assignee_id, created_by, created_at, updated_at)
  on table public.tasks from public, anon, authenticated;
revoke all privileges (profile_id, station_no, created_at)
  on table public.intake_station_users from public, anon, authenticated;
revoke all privileges (id, plate_number, customer_name, vehicle_model, chassis_number,
  document_type, image_path, ocr_text, station_no, received_by, received_at, status, admin_notes, created_at,
  plate_confirmed)
  on table public.vehicle_intakes from public, anon, authenticated;
revoke all privileges (id, vehicle_intake_id, status, created_by, created_at,
  completed_at, completed_by, override_reason, retention_claimed_at)
  on table public.work_orders from public, anon, authenticated;
revoke all privileges (id, work_order_id, technician_id, status, pause_reason,
  due_at, assigned_by, created_at, updated_at)
  on table public.work_assignments from public, anon, authenticated;
revoke all privileges (id, assignment_id, actor_id, from_status, to_status, pause_reason, created_at)
  on table public.work_assignment_events from public, anon, authenticated;
revoke all privileges (id, work_order_id, actor_id, from_status, to_status, reason, created_at)
  on table public.work_order_events from public, anon, authenticated;

grant select on public.profiles, public.tasks, public.intake_station_users,
  public.vehicle_intakes, public.work_orders, public.work_assignments,
  public.work_assignment_events, public.work_order_events to authenticated;
grant update (role, active, work_role) on public.profiles to authenticated;
grant insert (title, notes, priority, due_at, assignee_id, created_by)
  on public.tasks to authenticated;
grant insert (profile_id, station_no) on public.intake_station_users to authenticated;
grant update (profile_id, station_no) on public.intake_station_users to authenticated;
grant insert (plate_number, customer_name, vehicle_model, chassis_number,
  document_type, image_path, station_no, received_by, plate_confirmed)
  on public.vehicle_intakes to authenticated;

-- Task and workflow writes go through validated private SECURITY DEFINER RPCs.

create or replace function public.touch_task_updated_at()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  new.updated_at := now();
  return new;
end;
$$;
revoke all on function public.touch_task_updated_at() from public, anon, authenticated;
drop trigger if exists touch_task_updated_at on public.tasks;
create trigger touch_task_updated_at
before update of status on public.tasks
for each row execute function public.touch_task_updated_at();

create or replace function public.touch_work_assignment_updated_at()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  new.updated_at := now();
  return new;
end;
$$;
revoke all on function public.touch_work_assignment_updated_at() from public, anon, authenticated;
drop trigger if exists touch_work_assignment_updated_at on public.work_assignments;
create trigger touch_work_assignment_updated_at
before update of status, pause_reason, due_at on public.work_assignments
for each row execute function public.touch_work_assignment_updated_at();

drop policy if exists "admins manage work orders" on public.work_orders;
drop policy if exists "admins manage work assignments" on public.work_assignments;
drop policy if exists "assigned technicians update own active assignment" on public.work_assignments;

-- Serialize assignment writes with completion/retention so closed work cannot reopen.
create or replace function public.guard_active_work_order_assignment()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  current_order_status text;
begin
  select status into current_order_status
  from public.work_orders where id = new.work_order_id for update;
  if not found or current_order_status <> 'active' then
    raise exception 'Work order đã hoàn tất và không nhận cập nhật phân công.';
  end if;
  return new;
end;
$$;
revoke all on function public.guard_active_work_order_assignment() from public, anon, authenticated;
drop trigger if exists guard_active_work_order_assignment on public.work_assignments;
create trigger guard_active_work_order_assignment
before insert or update on public.work_assignments
for each row execute function public.guard_active_work_order_assignment();

-- RLS policies use private helpers, so the public RPC helpers can be closed.
drop policy if exists "profiles read own or admin" on public.profiles;
create policy "profiles read own or admin" on public.profiles
for select to authenticated
using (id = (select auth.uid()) or private.is_admin());

drop policy if exists "primary admin can update profiles" on public.profiles;
create policy "primary admin can update profiles" on public.profiles
for update to authenticated
using (private.is_primary_admin())
with check (private.is_primary_admin());

drop policy if exists "admin inserts tasks" on public.tasks;
create policy "admin inserts tasks" on public.tasks
for insert to authenticated
with check (private.is_admin() and created_by = (select auth.uid()));

drop policy if exists "admin sees all tasks employee sees assigned" on public.tasks;
create policy "admin sees all tasks employee sees assigned" on public.tasks
for select to authenticated
using (private.is_admin() or assignee_id = (select auth.uid()));

drop policy if exists "admin updates tasks" on public.tasks;
drop policy if exists "assigned employees update task status" on public.tasks;

create or replace function private.update_task_status(p_task_id uuid, p_status text)
returns void
language plpgsql
security definer
set search_path = ''
as $$
begin
  if (select auth.uid()) is null then
    raise exception 'Bạn cần đăng nhập.';
  end if;
  if p_status not in ('todo', 'doing', 'done') then
    raise exception 'Trạng thái không hợp lệ.';
  end if;

  update public.tasks
     set status = p_status
   where id = p_task_id
     and (private.is_admin() or assignee_id = (select auth.uid()));

  if not found then
    raise exception 'Không tìm thấy công việc hoặc bạn không có quyền cập nhật.';
  end if;
end;
$$;
revoke all on function private.update_task_status(uuid, text) from public, anon;
grant execute on function private.update_task_status(uuid, text) to authenticated;

create or replace function public.update_task_status(p_task_id uuid, p_status text)
returns void
language sql
security invoker
set search_path = ''
as $$
  select private.update_task_status(p_task_id, p_status);
$$;
revoke all on function public.update_task_status(uuid, text) from public, anon;
grant execute on function public.update_task_status(uuid, text) to authenticated;

drop policy if exists "primary admin manages intake station users" on public.intake_station_users;
create policy "primary admin manages intake station users"
on public.intake_station_users for all to authenticated
using (private.is_primary_admin())
with check (private.is_primary_admin());

drop policy if exists "intake users create own vehicle intake" on public.vehicle_intakes;
create policy "intake users create own vehicle intake" on public.vehicle_intakes
for insert to authenticated
with check (
  received_by = (select auth.uid())
  and plate_confirmed is true
  and exists (
    select 1 from public.intake_station_users s
    where s.profile_id = (select auth.uid())
      and s.station_no = vehicle_intakes.station_no
  )
);

drop policy if exists "assigned technicians read vehicle intake" on public.vehicle_intakes;
create policy "assigned technicians read vehicle intake" on public.vehicle_intakes
for select to authenticated
using (private.is_assigned_to_intake(id));

drop policy if exists "intake users and assigned technicians read intake images" on storage.objects;
create policy "intake users and assigned technicians read intake images" on storage.objects
for select to authenticated
using (
  bucket_id = 'vehicle-intakes'
  and (
    (storage.foldername(name))[1] = (select auth.uid())::text
    or exists (
      select 1 from public.profiles p
      where p.id = (select auth.uid()) and p.role = 'admin' and p.active = true
    )
    or exists (
      select 1 from public.vehicle_intakes vi
      where vi.image_path = storage.objects.name
        and private.is_assigned_to_intake(vi.id)
    )
  )
);

drop policy if exists "work orders visible to admins and assigned technicians" on public.work_orders;
create policy "work orders visible to admins and assigned technicians"
on public.work_orders for select to authenticated
using (
  private.is_admin()
  or exists (
    select 1 from public.work_assignments a
    where a.work_order_id = work_orders.id and a.technician_id = (select auth.uid())
  )
);

drop policy if exists "work assignments visible to admins and assignee" on public.work_assignments;
create policy "work assignments visible to admins and assignee"
on public.work_assignments for select to authenticated
using (private.is_admin() or technician_id = (select auth.uid()));

drop policy if exists "assignment events visible to admins and assignee" on public.work_assignment_events;
create policy "assignment events visible to admins and assignee"
on public.work_assignment_events for select to authenticated
using (
  private.is_admin()
  or exists (
    select 1 from public.work_assignments a
    where a.id = assignment_id and a.technician_id = (select auth.uid())
  )
);

drop policy if exists "work order events visible to admins and assigned technicians" on public.work_order_events;
create policy "work order events visible to admins and assigned technicians"
on public.work_order_events for select to authenticated
using (
  private.is_admin()
  or exists (
    select 1 from public.work_assignments a
    where a.work_order_id = work_order_events.work_order_id
      and a.technician_id = (select auth.uid())
  )
);

create or replace function private.assign_vehicle_technicians(
  p_intake_id uuid,
  p_technician_ids uuid[],
  p_due_at timestamptz default null
)
returns uuid
language plpgsql
security definer
set search_path = ''
as $$
declare
  target_order_id uuid;
  current_status text;
  retention_claim timestamptz;
  technician uuid;
begin
  if (select auth.uid()) is null or not private.is_admin() then
    raise exception 'Chỉ Admin đang hoạt động mới được giao việc.';
  end if;
  if coalesce(cardinality(p_technician_ids), 0) = 0 then
    raise exception 'Chọn ít nhất một kỹ thuật viên.';
  end if;
  if not exists (
    select 1 from public.vehicle_intakes where id = p_intake_id and status <> 'closed'
  ) then
    raise exception 'Không tìm thấy hồ sơ tiếp nhận đang xử lý.';
  end if;

  insert into public.work_orders(vehicle_intake_id, created_by)
  values (p_intake_id, (select auth.uid()))
  on conflict (vehicle_intake_id) do nothing;

  select id, status, retention_claimed_at into target_order_id, current_status, retention_claim
  from public.work_orders where vehicle_intake_id = p_intake_id for update;

  if retention_claim is not null then
    raise exception 'Hồ sơ đang được lưu trữ và không thể nhận phân công mới.';
  end if;
  if current_status = 'completed_override' then
    raise exception 'Hồ sơ đã được Admin xác nhận hoàn thành ngoại lệ.';
  end if;
  if current_status <> 'active' then
    raise exception 'Work order đã hoàn thành và không nhận phân công mới.';
  end if;

  for technician in
    select distinct u.technician_id from unnest(p_technician_ids) as u(technician_id)
  loop
    if not exists (
      select 1 from public.profiles
      where id = technician and active = true and work_role = 'technician'
    ) then
      raise exception 'Chỉ được giao cho tài khoản kỹ thuật viên đang hoạt động.';
    end if;

    insert into public.work_assignments as existing (work_order_id, technician_id, assigned_by, due_at)
    values (target_order_id, technician, (select auth.uid()), p_due_at)
    on conflict (work_order_id, technician_id) do update
      set due_at = coalesce(excluded.due_at, existing.due_at);
  end loop;

  return target_order_id;
end;
$$;

create or replace function private.set_work_assignment_status(
  p_assignment_id uuid,
  p_status text,
  p_pause_reason text default null
)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  target_order_id uuid;
  assigned_technician uuid;
  order_status text;
begin
  if (select auth.uid()) is null then raise exception 'Bạn cần đăng nhập.'; end if;
  if p_status not in ('todo', 'doing', 'paused', 'done') then
    raise exception 'Trạng thái không hợp lệ.';
  end if;
  if p_status = 'paused' and nullif(btrim(p_pause_reason), '') is null then
    raise exception 'Cần ghi lý do khi tạm dừng.';
  end if;

  select work_order_id into target_order_id
  from public.work_assignments where id = p_assignment_id;
  if not found then raise exception 'Không tìm thấy phân công.'; end if;

  -- Lock the work order before the assignment to serialize with assignment and completion RPCs.
  select status into order_status
  from public.work_orders where id = target_order_id for update;
  if not found then raise exception 'Không tìm thấy work order.'; end if;
  if order_status <> 'active' then
    raise exception 'Work order đã hoàn tất và không nhận cập nhật trạng thái.';
  end if;

  select technician_id into assigned_technician
  from public.work_assignments where id = p_assignment_id for update;
  if not found then raise exception 'Không tìm thấy phân công.'; end if;
  if not private.is_admin() and assigned_technician <> (select auth.uid()) then
    raise exception 'Bạn không được phân công công việc này.';
  end if;
  update public.work_assignments
     set status = p_status,
         pause_reason = case when p_status = 'paused' then btrim(p_pause_reason) else null end
   where id = p_assignment_id;
end;
$$;

create or replace function private.admin_complete_work_order(p_work_order_id uuid, p_reason text)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  intake_id uuid;
begin
  if (select auth.uid()) is null or not private.is_admin() then
    raise exception 'Chỉ Admin đang hoạt động mới được xác nhận hoàn thành.';
  end if;
  if nullif(btrim(p_reason), '') is null then
    raise exception 'Cần ghi lý do hoàn thành ngoại lệ.';
  end if;

  update public.work_orders
     set status = 'completed_override', completed_at = now(),
         completed_by = (select auth.uid()), override_reason = btrim(p_reason)
   where id = p_work_order_id and status = 'active'
  returning vehicle_intake_id into intake_id;
  if not found then raise exception 'Không tìm thấy hồ sơ đang xử lý để hoàn tất.'; end if;

  update public.vehicle_intakes set status = 'closed' where id = intake_id;
end;
$$;

revoke all on function public.is_admin() from public, anon, authenticated;
revoke all on function public.is_primary_admin() from public, anon, authenticated;
revoke all on function public.is_assigned_to_intake(uuid) from public, anon, authenticated;

create or replace function public.assign_vehicle_technicians(
  p_intake_id uuid,
  p_technician_ids uuid[],
  p_due_at timestamptz default null
)
returns uuid
language sql
security invoker
set search_path = ''
as $$
  select private.assign_vehicle_technicians(p_intake_id, p_technician_ids, p_due_at);
$$;

create or replace function public.set_work_assignment_status(
  p_assignment_id uuid,
  p_status text,
  p_pause_reason text default null
)
returns void
language sql
security invoker
set search_path = ''
as $$
  select private.set_work_assignment_status(p_assignment_id, p_status, p_pause_reason);
$$;

create or replace function public.admin_complete_work_order(p_work_order_id uuid, p_reason text)
returns void
language sql
security invoker
set search_path = ''
as $$
  select private.admin_complete_work_order(p_work_order_id, p_reason);
$$;

revoke all on function private.assign_vehicle_technicians(uuid, uuid[], timestamptz) from public, anon;
revoke all on function private.set_work_assignment_status(uuid, text, text) from public, anon;
revoke all on function private.admin_complete_work_order(uuid, text) from public, anon;
grant execute on function private.assign_vehicle_technicians(uuid, uuid[], timestamptz) to authenticated;
grant execute on function private.set_work_assignment_status(uuid, text, text) to authenticated;
grant execute on function private.admin_complete_work_order(uuid, text) to authenticated;

revoke all on function public.assign_vehicle_technicians(uuid, uuid[], timestamptz) from public, anon;
revoke all on function public.set_work_assignment_status(uuid, text, text) from public, anon;
revoke all on function public.admin_complete_work_order(uuid, text) from public, anon;
grant execute on function public.assign_vehicle_technicians(uuid, uuid[], timestamptz) to authenticated;
grant execute on function public.set_work_assignment_status(uuid, text, text) to authenticated;
grant execute on function public.admin_complete_work_order(uuid, text) to authenticated;

