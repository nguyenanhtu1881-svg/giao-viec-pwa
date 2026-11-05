-- Bootstrap the original task and profile schema before the recorded intake migrations.
-- Safe on the already-provisioned project: tables and indexes are created only when absent.

create table if not exists public.profiles (
  id uuid primary key references auth.users(id) on delete cascade,
  full_name text not null default '',
  email text,
  role text not null default 'employee' check (role in ('admin', 'employee')),
  active boolean not null default false,
  created_at timestamptz not null default now()
);

create table if not exists public.tasks (
  id uuid primary key default gen_random_uuid(),
  title text not null check (char_length(title) between 1 and 140),
  notes text,
  status text not null default 'todo' check (status in ('todo', 'doing', 'done')),
  priority text not null default 'normal' check (priority in ('normal', 'high')),
  due_at timestamptz not null,
  assignee_id uuid not null references public.profiles(id),
  created_by uuid not null references public.profiles(id),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists tasks_assignee_due_idx on public.tasks (assignee_id, due_at);
create index if not exists tasks_status_idx on public.tasks (status);
create index if not exists tasks_created_by_idx on public.tasks (created_by);

alter table public.profiles enable row level security;
alter table public.tasks enable row level security;

create or replace function public.is_admin()
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
revoke all on function public.is_admin() from public, anon;
grant execute on function public.is_admin() to authenticated;

create or replace function public.handle_new_user()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  insert into public.profiles(id, full_name, email, role, active)
  values (new.id, coalesce(new.raw_user_meta_data->>'full_name', ''), new.email, 'employee', false)
  on conflict (id) do nothing;
  return new;
end;
$$;
revoke all on function public.handle_new_user() from public, anon, authenticated;
grant execute on function public.handle_new_user() to supabase_auth_admin;

drop trigger if exists on_auth_user_created on auth.users;
create trigger on_auth_user_created
after insert on auth.users
for each row execute function public.handle_new_user();

drop policy if exists "profiles read own or admin" on public.profiles;
create policy "profiles read own or admin" on public.profiles
for select to authenticated
using (id = (select auth.uid()) or public.is_admin());

drop policy if exists "admin can update profiles" on public.profiles;
create policy "admin can update profiles" on public.profiles
for update to authenticated
using (public.is_admin())
with check (public.is_admin());

drop policy if exists "admin inserts tasks" on public.tasks;
create policy "admin inserts tasks" on public.tasks
for insert to authenticated
with check (public.is_admin() and created_by = (select auth.uid()));

drop policy if exists "admin sees all tasks employee sees assigned" on public.tasks;
create policy "admin sees all tasks employee sees assigned" on public.tasks
for select to authenticated
using (public.is_admin() or assignee_id = (select auth.uid()));

drop policy if exists "admin updates tasks" on public.tasks;
create policy "admin updates tasks" on public.tasks
for update to authenticated
using (public.is_admin())
with check (public.is_admin());

grant select, update on public.profiles to authenticated;
grant select, insert, update on public.tasks to authenticated;

create or replace function public.update_task_status(p_task_id uuid, p_status text)
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
     set status = p_status, updated_at = now()
   where id = p_task_id
     and (public.is_admin() or assignee_id = (select auth.uid()));

  if not found then
    raise exception 'Không tìm thấy công việc hoặc bạn không có quyền cập nhật.';
  end if;
end;
$$;
revoke all on function public.update_task_status(uuid, text) from public, anon;
grant execute on function public.update_task_status(uuid, text) to authenticated;

