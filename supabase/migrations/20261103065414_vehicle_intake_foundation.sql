
-- Intake station accounts are mapped to one of four fixed stations.
create table if not exists public.intake_station_users (
  profile_id uuid primary key references public.profiles(id) on delete cascade,
  station_no smallint not null unique check (station_no between 1 and 4),
  created_at timestamptz not null default now()
);

alter table public.intake_station_users enable row level security;

drop policy if exists "intake station users read own or admin" on public.intake_station_users;
create policy "intake station users read own or admin"
on public.intake_station_users
for select
to authenticated
using (
  profile_id = (select auth.uid())
  or exists (
    select 1 from public.profiles p
    where p.id = (select auth.uid()) and p.role = 'admin' and p.active = true
  )
);

drop policy if exists "admins manage intake station users" on public.intake_station_users;
create policy "admins manage intake station users"
on public.intake_station_users
for all
to authenticated
using (
  exists (
    select 1 from public.profiles p
    where p.id = (select auth.uid()) and p.role = 'admin' and p.active = true
  )
)
with check (
  exists (
    select 1 from public.profiles p
    where p.id = (select auth.uid()) and p.role = 'admin' and p.active = true
  )
);

grant select, insert, update, delete on public.intake_station_users to authenticated;

-- One intake record contains exactly one source document image.
create table if not exists public.vehicle_intakes (
  id uuid primary key default gen_random_uuid(),
  plate_number text,
  customer_name text,
  vehicle_model text,
  chassis_number text,
  document_type text not null default 'unknown'
    check (document_type in ('quotation', 'inspection', 'unknown')),
  image_path text not null,
  ocr_text text,
  station_no smallint not null check (station_no between 1 and 4),
  received_by uuid not null references public.profiles(id),
  received_at timestamptz not null default now(),
  status text not null default 'new'
    check (status in ('new', 'assigned', 'closed')),
  admin_notes text,
  created_at timestamptz not null default now()
);

create index if not exists vehicle_intakes_received_at_idx
  on public.vehicle_intakes (received_at desc);
create index if not exists vehicle_intakes_plate_idx
  on public.vehicle_intakes (plate_number);

alter table public.vehicle_intakes enable row level security;

drop policy if exists "intake users create own vehicle intake" on public.vehicle_intakes;
create policy "intake users create own vehicle intake"
on public.vehicle_intakes
for insert
to authenticated
with check (
  received_by = (select auth.uid())
  and exists (
    select 1 from public.intake_station_users s
    where s.profile_id = (select auth.uid()) and s.station_no = station_no
  )
);

drop policy if exists "intake users read own and admins read all" on public.vehicle_intakes;
create policy "intake users read own and admins read all"
on public.vehicle_intakes
for select
to authenticated
using (
  received_by = (select auth.uid())
  or exists (
    select 1 from public.profiles p
    where p.id = (select auth.uid()) and p.role = 'admin' and p.active = true
  )
);

drop policy if exists "admins update vehicle intakes" on public.vehicle_intakes;
create policy "admins update vehicle intakes"
on public.vehicle_intakes
for update
to authenticated
using (
  exists (
    select 1 from public.profiles p
    where p.id = (select auth.uid()) and p.role = 'admin' and p.active = true
  )
)
with check (
  exists (
    select 1 from public.profiles p
    where p.id = (select auth.uid()) and p.role = 'admin' and p.active = true
  )
);

grant select, insert, update on public.vehicle_intakes to authenticated;

-- Private bucket: documents are only accessible through authenticated RLS.
insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values ('vehicle-intakes', 'vehicle-intakes', false, 8388608, array['image/jpeg','image/png','image/webp'])
on conflict (id) do nothing;

drop policy if exists "intake users upload own intake images" on storage.objects;
create policy "intake users upload own intake images"
on storage.objects
for insert
to authenticated
with check (
  bucket_id = 'vehicle-intakes'
  and (storage.foldername(name))[1] = (select auth.uid())::text
  and exists (
    select 1 from public.intake_station_users s
    where s.profile_id = (select auth.uid())
  )
);

drop policy if exists "intake users and admins read intake images" on storage.objects;
create policy "intake users and admins read intake images"
on storage.objects
for select
to authenticated
using (
  bucket_id = 'vehicle-intakes'
  and (
    (storage.foldername(name))[1] = (select auth.uid())::text
    or exists (
      select 1 from public.profiles p
      where p.id = (select auth.uid()) and p.role = 'admin' and p.active = true
    )
  )
);


