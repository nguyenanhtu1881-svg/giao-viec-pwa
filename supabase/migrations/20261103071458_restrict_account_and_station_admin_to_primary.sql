
create or replace function public.is_primary_admin()
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select exists (
    select 1 from public.profiles
    where id = auth.uid()
      and email = 'tu.nguyen@hyundaimiennam.com'
      and role = 'admin'
      and active = true
  );
$$;

revoke execute on function public.is_primary_admin() from public, anon;
grant execute on function public.is_primary_admin() to authenticated;

drop policy if exists "admin can update profiles" on public.profiles;
create policy "primary admin can update profiles"
on public.profiles
for update
to authenticated
using (public.is_primary_admin())
with check (public.is_primary_admin());

-- Limit intake station configuration to the designated primary admin.
drop policy if exists "admins manage intake station users" on public.intake_station_users;
create policy "primary admin manages intake station users"
on public.intake_station_users
for all
to authenticated
using (public.is_primary_admin())
with check (public.is_primary_admin());


