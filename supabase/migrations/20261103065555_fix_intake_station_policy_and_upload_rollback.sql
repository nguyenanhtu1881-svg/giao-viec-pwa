
drop policy if exists "intake users create own vehicle intake" on public.vehicle_intakes;
create policy "intake users create own vehicle intake"
on public.vehicle_intakes
for insert
to authenticated
with check (
  received_by = (select auth.uid())
  and exists (
    select 1 from public.intake_station_users s
    where s.profile_id = (select auth.uid())
      and s.station_no = vehicle_intakes.station_no
  )
);

drop policy if exists "intake users delete own intake images" on storage.objects;
create policy "intake users delete own intake images"
on storage.objects
for delete
to authenticated
using (
  bucket_id = 'vehicle-intakes'
  and (storage.foldername(name))[1] = (select auth.uid())::text
);


