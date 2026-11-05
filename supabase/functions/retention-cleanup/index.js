const projectUrl = Deno.env.get("SUPABASE_URL");
const serviceRoleKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
const retentionSecret = Deno.env.get("RETENTION_CRON_SECRET");

async function digest(value) {
  return new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value)));
}

async function matchesSecret(supplied, expected) {
  const [left, right] = await Promise.all([digest(supplied), digest(expected)]);
  let difference = 0;
  for (let i = 0; i < left.length; i++) difference |= left[i] ^ right[i];
  return difference === 0;
}

Deno.serve(async (request) => {
  if (request.method !== "POST") return new Response("Method not allowed", { status: 405 });
  if (!projectUrl || !serviceRoleKey || !retentionSecret) {
    return Response.json({ error: "Retention function is not configured." }, { status: 500 });
  }

  const suppliedSecret = request.headers.get("x-retention-secret") ?? "";
  if (!await matchesSecret(suppliedSecret, retentionSecret)) {
    return Response.json({ error: "Unauthorized." }, { status: 401 });
  }

  const headers = {
    apikey: serviceRoleKey,
    authorization: `Bearer ${serviceRoleKey}`,
    "content-type": "application/json",
  };
  const rpc = (name, body) => fetch(
    `${projectUrl}/rest/v1/rpc/${name}`,
    { method: "POST", headers, body: JSON.stringify(body) },
  );

  const claimResponse = await rpc("claim_expired_vehicle_intakes", { p_limit: 25 });
  if (!claimResponse.ok) {
    console.error("Could not claim expired records:", claimResponse.status);
    return Response.json({ error: "Could not claim expired records." }, { status: 502 });
  }

  const claims = await claimResponse.json();
  let deleted = 0;
  let failed = 0;

  for (const claim of claims) {
    try {
      const storageResponse = await fetch(`${projectUrl}/storage/v1/object/vehicle-intakes`, {
        method: "DELETE",
        headers,
        body: JSON.stringify({ prefixes: [claim.image_path] }),
      });
      if (!storageResponse.ok && storageResponse.status !== 404) {
        throw new Error(`Storage deletion failed (${storageResponse.status}).`);
      }

      const deleteResponse = await rpc("complete_retention_for_intake", { p_intake_id: claim.intake_id });
      if (!deleteResponse.ok || await deleteResponse.json() !== true) {
        throw new Error(`Database deletion failed (${deleteResponse.status}).`);
      }
      deleted++;
    } catch (error) {
      failed++;
      console.error("Could not finish a claimed retention record:", error);
      await rpc("release_retention_claim", { p_intake_id: claim.intake_id }).catch(() => undefined);
    }
  }

  return Response.json({ claimed: claims.length, deleted, failed });
});

