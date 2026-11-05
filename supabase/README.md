# Supabase migrations and scheduled retention

The four `20261103...` migrations restore the SQL recorded in the connected project. The earlier `20261102...` migration bootstraps the original profiles and generic task tables that predated the tracked intake migrations. The `20261105090000...` migration adds vehicle work orders and technician assignments. The `20261105100000...` migration moves authorization and workflow write functions into the non-exposed `private` schema, leaves invoker-rights wrappers in `public`, and grants no direct write access to task/workflow tables.

For a brand-new project, first create the primary administrator through Supabase Auth sign-up, then promote that exact account once in the Supabase SQL Editor:

```sql
update public.profiles
set role = 'admin', active = true
where email = 'tu.nguyen@hyundaimiennam.com';
```

The primary administrator can then activate employees and assign the secondary administrator role in the app. Never place a service role key in the static frontend.

The cleanup function is intentionally separate from migrations. After its schema migration is reviewed and applied in the intended Supabase environment, deploy `functions/retention-cleanup` and set the `RETENTION_CRON_SECRET` function secret. Supabase provides `SUPABASE_URL` and `SUPABASE_SERVICE_ROLE_KEY` to deployed Edge Functions.

Schedule a `POST` to `/functions/v1/retention-cleanup` every five minutes with the header `x-retention-secret: <RETENTION_CRON_SECRET>`. The function claims at most 25 records per run, removes each private Storage object first, then asks the database to delete only a closed vehicle intake whose work order has been completed for at least 45 days. Active work orders cannot be claimed, and an active retention claim prevents an administrator from reassigning that work order while cleanup is in progress.

Do not put the service role key or retention secret in the frontend, repository, or a committed schedule definition.

