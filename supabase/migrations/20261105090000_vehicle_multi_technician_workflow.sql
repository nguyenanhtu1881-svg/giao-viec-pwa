-- A work order is the repair case for one intake. Each technician has an
-- independent assignment and an append-only status history.
create or replace function public.protect_primary_admin()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  if old.email = 'tu.nguyen@hyundaimiennam.com'
     and (new.role <> 'admin' or new.active = false or new.email is distinct from old.email) then
    raise exception 'Không thể hạ quyền, khóa hoặc đổi email hồ sơ Admin chính.';
  end if;
  return new;
end;
$$;

create table if not exists public.work_orders (
  id uuid primary key default gen_random_uuid(),
  vehicle_intake_id uuid not null unique references public.vehicle_intakes(id) on delete cascade,
  status text not null default 'active'
    check (status in ('active', 'completed', 'completed_override')),
  created_by uuid not null references public.profiles(id),
  created_at timestamptz not null default now(),
  completed_at timestamptz,
  completed_by uuid references public.profiles(id),
  override_reason text,
  retention_claimed_at timestamptz,
  check (
    (status = 'completed_override' and completed_at is not null and completed_by is not null
      and nullif(btrim(override_reason), '') is not null)
    or status <> 'completed_override'
  )
);

create table if not exists public.work_assignments (
  id uuid primary key default gen_random_uuid(),
  work_order_id uuid not null references public.work_orders(id) on delete cascade,
  technician_id uuid not null references public.profiles(id),
  status text not null default 'todo' check (status in ('todo', 'doing', 'paused', 'done')),
  pause_reason text,
  due_at timestamptz,
  assigned_by uuid not null references public.profiles(id),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (work_order_id, technician_id),
  check (
    (status = 'paused' and nullif(btrim(pause_reason), '') is not null)
    or (status <> 'paused' and pause_reason is null)
  )
);

create index if not exists work_assignments_technician_status_idx
  on public.work_assignments (technician_id, status, due_at);
create index if not exists work_assignments_work_order_idx
  on public.work_assignments (work_order_id);
create index if not exists work_orders_completed_retention_idx
  on public.work_orders (completed_at)
  where status in ('completed', 'completed_override');

create table if not exists public.work_assignment_events (
  id uuid primary key default gen_random_uuid(),
  assignment_id uuid not null references public.work_assignments(id) on delete cascade,
  actor_id uuid references public.profiles(id) on delete set null,
  from_status text,
  to_status text not null check (to_status in ('todo', 'doing', 'paused', 'done')),
  pause_reason text,
  created_at timestamptz not null default now()
);
create index if not exists work_assignment_events_assignment_time_idx
  on public.work_assignment_events (assignment_id, created_at);

create table if not exists public.work_order_events (
  id uuid primary key default gen_random_uuid(),
  work_order_id uuid not null references public.work_orders(id) on delete cascade,
  actor_id uuid references public.profiles(id) on delete set null,
  from_status text,
  to_status text not null check (to_status in ('active', 'completed', 'completed_override')),
  reason text,
  created_at timestamptz not null default now()
);
create index if not exists work_order_events_order_time_idx
  on public.work_order_events (work_order_id, created_at);

create or replace function public.is_assigned_to_intake(p_intake_id uuid)
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
revoke all on function public.is_assigned_to_intake(uuid) from public, anon;
grant execute on function public.is_assigned_to_intake(uuid) to authenticated;

alter table public.work_orders enable row level security;
alter table public.work_assignments enable row level security;
alter table public.work_assignment_events enable row level security;
alter table public.work_order_events enable row level security;

drop policy if exists "work orders visible to admins and assigned technicians" on public.work_orders;
create policy "work orders visible to admins and assigned technicians"
on public.work_orders for select to authenticated
using (
  public.is_admin()
  or exists (
    select 1 from public.work_assignments a
    where a.work_order_id = work_orders.id and a.technician_id = (select auth.uid())
  )
);

drop policy if exists "work assignments visible to admins and assignee" on public.work_assignments;
create policy "work assignments visible to admins and assignee"
on public.work_assignments for select to authenticated
using (public.is_admin() or technician_id = (select auth.uid()));

drop policy if exists "assignment events visible to admins and assignee" on public.work_assignment_events;
create policy "assignment events visible to admins and assignee"
on public.work_assignment_events for select to authenticated
using (
  public.is_admin()
  or exists (
    select 1 from public.work_assignments a
    where a.id = assignment_id and a.technician_id = (select auth.uid())
  )
);

drop policy if exists "work order events visible to admins and assigned technicians" on public.work_order_events;
create policy "work order events visible to admins and assigned technicians"
on public.work_order_events for select to authenticated
using (
  public.is_admin()
  or exists (
    select 1 from public.work_assignments a
    where a.work_order_id = work_order_events.work_order_id and a.technician_id = (select auth.uid())
  )
);

grant select on public.work_orders, public.work_assignments,
  public.work_assignment_events, public.work_order_events to authenticated;

drop policy if exists "assigned technicians read vehicle intake" on public.vehicle_intakes;
create policy "assigned technicians read vehicle intake" on public.vehicle_intakes
for select to authenticated
using (public.is_assigned_to_intake(id));

drop policy if exists "intake users and admins read intake images" on storage.objects;
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
        and public.is_assigned_to_intake(vi.id)
    )
  )
);

create or replace function public.record_assignment_status_event()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  if tg_op = 'INSERT' then
    insert into public.work_assignment_events(assignment_id, actor_id, from_status, to_status, pause_reason)
    values (new.id, (select auth.uid()), null, new.status, new.pause_reason);
    return new;
  end if;

  if old.status is distinct from new.status or old.pause_reason is distinct from new.pause_reason then
    insert into public.work_assignment_events(assignment_id, actor_id, from_status, to_status, pause_reason)
    values (new.id, (select auth.uid()), old.status, new.status, new.pause_reason);
  end if;
  return new;
end;
$$;

drop trigger if exists work_assignment_status_event on public.work_assignments;
create trigger work_assignment_status_event
after insert or update of status, pause_reason on public.work_assignments
for each row execute function public.record_assignment_status_event();

create or replace function public.record_work_order_status_event()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  if tg_op = 'INSERT' then
    insert into public.work_order_events(work_order_id, actor_id, from_status, to_status, reason)
    values (new.id, (select auth.uid()), null, new.status,
      case when new.status = 'completed_override' then new.override_reason else null end);
    return new;
  end if;

  if old.status is distinct from new.status then
    insert into public.work_order_events(work_order_id, actor_id, from_status, to_status, reason)
    values (new.id, (select auth.uid()), old.status, new.status,
      case when new.status = 'completed_override' then new.override_reason else null end);
  end if;
  return new;
end;
$$;

drop trigger if exists work_order_status_event on public.work_orders;
create trigger work_order_status_event
after insert or update of status on public.work_orders
for each row execute function public.record_work_order_status_event();

create or replace function public.refresh_work_order_completion()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  target_order_id uuid;
  current_order_status text;
  all_done boolean;
begin
  target_order_id := case when tg_op = 'DELETE' then old.work_order_id else new.work_order_id end;

  select status into current_order_status
  from public.work_orders where id = target_order_id for update;

  if not found or current_order_status = 'completed_override' then
    if tg_op = 'DELETE' then return old; else return new; end if;
  end if;

  select exists (
    select 1 from public.work_assignments where work_order_id = target_order_id
  ) and not exists (
    select 1 from public.work_assignments
    where work_order_id = target_order_id and status <> 'done'
  ) into all_done;

  if all_done then
    update public.work_orders
       set status = 'completed',
           completed_at = coalesce(completed_at, now()),
           completed_by = null,
           override_reason = null
     where id = target_order_id;
    update public.vehicle_intakes vi
       set status = 'closed'
      where vi.id = (select vehicle_intake_id from public.work_orders where id = target_order_id);
  else
    update public.work_orders
       set status = 'active', completed_at = null, completed_by = null, override_reason = null
     where id = target_order_id and status is distinct from 'active';
    update public.vehicle_intakes vi
       set status = 'assigned'
      where vi.id = (select vehicle_intake_id from public.work_orders where id = target_order_id);
  end if;

  if tg_op = 'DELETE' then return old; else return new; end if;
end;
$$;

drop trigger if exists work_order_recompute_after_assignment on public.work_assignments;
create trigger work_order_recompute_after_assignment
after insert or update of status or delete on public.work_assignments
for each row execute function public.refresh_work_order_completion();

create or replace function public.assign_vehicle_technicians(
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
  if (select auth.uid()) is null or not public.is_admin() then
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
    select distinct u.technician_id
    from unnest(p_technician_ids) as u(technician_id)
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

create or replace function public.set_work_assignment_status(
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
  if (select auth.uid()) is null then
    raise exception 'Bạn cần đăng nhập.';
  end if;
  if p_status not in ('todo', 'doing', 'paused', 'done') then
    raise exception 'Trạng thái không hợp lệ.';
  end if;
  if p_status = 'paused' and nullif(btrim(p_pause_reason), '') is null then
    raise exception 'Cần ghi lý do khi tạm dừng.';
  end if;

  select a.work_order_id, a.technician_id, o.status
    into target_order_id, assigned_technician, order_status
  from public.work_assignments a
  join public.work_orders o on o.id = a.work_order_id
  where a.id = p_assignment_id
  for update of a, o;

  if not found then raise exception 'Không tìm thấy phân công.'; end if;
  if not public.is_admin() and assigned_technician <> (select auth.uid()) then
    raise exception 'Bạn không được phân công công việc này.';
  end if;
  if order_status <> 'active' then
    raise exception 'Work order đã hoàn tất và không nhận cập nhật trạng thái.';
  end if;

  update public.work_assignments
     set status = p_status,
         pause_reason = case when p_status = 'paused' then btrim(p_pause_reason) else null end,
         updated_at = now()
   where id = p_assignment_id;
end;
$$;

create or replace function public.admin_complete_work_order(
  p_work_order_id uuid,
  p_reason text
)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  intake_id uuid;
begin
  if (select auth.uid()) is null or not public.is_admin() then
    raise exception 'Chỉ Admin đang hoạt động mới được xác nhận hoàn thành.';
  end if;
  if nullif(btrim(p_reason), '') is null then
    raise exception 'Cần ghi lý do hoàn thành ngoại lệ.';
  end if;

  update public.work_orders
     set status = 'completed_override',
         completed_at = now(),
         completed_by = (select auth.uid()),
         override_reason = btrim(p_reason)
   where id = p_work_order_id and status = 'active'
  returning vehicle_intake_id into intake_id;

  if not found then
    raise exception 'Không tìm thấy hồ sơ đang xử lý để hoàn tất.';
  end if;

  update public.vehicle_intakes set status = 'closed' where id = intake_id;
end;
$$;

revoke all on function public.record_assignment_status_event() from public, anon, authenticated;
revoke all on function public.record_work_order_status_event() from public, anon, authenticated;
revoke all on function public.refresh_work_order_completion() from public, anon, authenticated;
revoke all on function public.assign_vehicle_technicians(uuid, uuid[], timestamptz) from public, anon;
revoke all on function public.set_work_assignment_status(uuid, text, text) from public, anon;
revoke all on function public.admin_complete_work_order(uuid, text) from public, anon;
grant execute on function public.assign_vehicle_technicians(uuid, uuid[], timestamptz) to authenticated;
grant execute on function public.set_work_assignment_status(uuid, text, text) to authenticated;
grant execute on function public.admin_complete_work_order(uuid, text) to authenticated;

create index if not exists vehicle_intakes_active_plate_idx
  on public.vehicle_intakes (upper(regexp_replace(coalesce(plate_number, ''), '[^A-Za-z0-9]', '', 'g')))
  where status <> 'closed';

do $$
begin
  if not exists (
    select 1 from pg_publication_tables
    where pubname = 'supabase_realtime' and schemaname = 'public' and tablename = 'work_orders'
  ) then
    alter publication supabase_realtime add table public.work_orders;
  end if;
  if not exists (
    select 1 from pg_publication_tables
    where pubname = 'supabase_realtime' and schemaname = 'public' and tablename = 'work_assignments'
  ) then
    alter publication supabase_realtime add table public.work_assignments;
  end if;
  if not exists (
    select 1 from pg_publication_tables
    where pubname = 'supabase_realtime' and schemaname = 'public' and tablename = 'vehicle_intakes'
  ) then
    alter publication supabase_realtime add table public.vehicle_intakes;
  end if;
end
$$;

-- The scheduled Edge Function claims only completed work orders past 45 days.
-- Claims prevent reassignment while the private Storage object is being removed.
create or replace function public.claim_expired_vehicle_intakes(p_limit integer default 25)
returns table(intake_id uuid, image_path text)
language plpgsql
security definer
set search_path = ''
as $$
begin
  return query
  with eligible as (
    select wo.id as work_order_id, vi.id as vehicle_intake_id, vi.image_path
    from public.work_orders wo
    join public.vehicle_intakes vi on vi.id = wo.vehicle_intake_id
    where wo.status in ('completed', 'completed_override')
      and wo.completed_at <= now() - interval '45 days'
      and (wo.retention_claimed_at is null or wo.retention_claimed_at < now() - interval '1 hour')
      and vi.status = 'closed'
    order by wo.completed_at asc
    limit least(greatest(coalesce(p_limit, 25), 1), 100)
    for update of wo skip locked
  ), claimed as (
    update public.work_orders wo
       set retention_claimed_at = now()
      from eligible e
     where wo.id = e.work_order_id
    returning e.vehicle_intake_id, e.image_path
  )
  select c.vehicle_intake_id, c.image_path from claimed c;
end;
$$;

create or replace function public.complete_retention_for_intake(p_intake_id uuid)
returns boolean
language plpgsql
security definer
set search_path = ''
as $$
declare
  deleted_count integer;
begin
  delete from public.vehicle_intakes vi
   using public.work_orders wo
   where wo.vehicle_intake_id = vi.id
     and vi.id = p_intake_id
     and vi.status = 'closed'
     and wo.status in ('completed', 'completed_override')
     and wo.completed_at <= now() - interval '45 days'
     and wo.retention_claimed_at is not null;
  get diagnostics deleted_count = row_count;
  return deleted_count = 1;
end;
$$;

create or replace function public.release_retention_claim(p_intake_id uuid)
returns void
language sql
security definer
set search_path = ''
as $$
  update public.work_orders
     set retention_claimed_at = null
   where vehicle_intake_id = p_intake_id and retention_claimed_at is not null;
$$;

revoke all on function public.claim_expired_vehicle_intakes(integer) from public, anon, authenticated;
revoke all on function public.complete_retention_for_intake(uuid) from public, anon, authenticated;
revoke all on function public.release_retention_claim(uuid) from public, anon, authenticated;
grant execute on function public.claim_expired_vehicle_intakes(integer) to service_role;
grant execute on function public.complete_retention_for_intake(uuid) to service_role;
grant execute on function public.release_retention_claim(uuid) to service_role;
