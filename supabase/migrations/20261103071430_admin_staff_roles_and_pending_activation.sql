
alter table public.profiles
  add column if not exists work_role text not null default 'unassigned'
  check (work_role in ('unassigned','intake','technician','manager'));

alter table public.profiles alter column active set default false;

create or replace function public.handle_new_user()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  insert into public.profiles(id, full_name, email, role, active, work_role)
  values (
    new.id,
    coalesce(new.raw_user_meta_data->>'full_name',''),
    new.email,
    'employee',
    false,
    'unassigned'
  )
  on conflict (id) do nothing;
  return new;
end;
$$;

-- Protect the designated primary administrator from accidental demotion/deactivation.
create or replace function public.protect_primary_admin()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  if old.email = 'tu.nguyen@hyundaimiennam.com'
     and (new.role <> 'admin' or new.active = false) then
    raise exception 'Không thể hạ quyền hoặc khóa tài khoản Admin chính.';
  end if;
  return new;
end;
$$;

drop trigger if exists protect_primary_admin_trigger on public.profiles;
create trigger protect_primary_admin_trigger
before update on public.profiles
for each row execute function public.protect_primary_admin();

grant execute on function public.handle_new_user() to supabase_auth_admin;
revoke execute on function public.handle_new_user() from public, anon, authenticated;


