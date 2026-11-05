import assert from "node:assert/strict";
import { test } from "node:test";

const calls = [];
let handler;
const originalFetch = globalThis.fetch;
globalThis.Deno = {
  env: { get: (key) => ({ SUPABASE_URL: "https://project.example", SUPABASE_SERVICE_ROLE_KEY: "service-key", RETENTION_CRON_SECRET: "cron-secret" })[key] },
  serve: (callback) => { handler = callback; },
};
await import("../supabase/functions/retention-cleanup/index.js");

test("retention endpoint rejects requests without the cron secret", async () => {
  globalThis.fetch = async (...args) => { calls.push(args); throw new Error("fetch should not run"); };
  const response = await handler(new Request("https://function.example", { method: "POST" }));
  assert.equal(response.status, 401);
  assert.equal(calls.length, 0);
});

test("retention endpoint only accepts POST", async () => {
  calls.length = 0;
  globalThis.fetch = async (...args) => { calls.push(args); throw new Error("fetch should not run"); };
  const response = await handler(new Request("https://function.example", {
    method: "GET",
    headers: { "x-retention-secret": "cron-secret" },
  }));
  assert.equal(response.status, 405);
  assert.equal(calls.length, 0);
});

test("retention deletes Storage before the database record", async () => {
  calls.length = 0;
  globalThis.fetch = async (url, init) => {
    calls.push({ url, init });
    if (url.endsWith("/claim_expired_vehicle_intakes")) {
      return Response.json([{ intake_id: "intake-1", image_path: "user-1/photo.jpg" }]);
    }
    if (url.endsWith("/storage/v1/object/vehicle-intakes")) return new Response(null, { status: 200 });
    if (url.endsWith("/complete_retention_for_intake")) return Response.json(true);
    throw new Error(`Unexpected request: ${url}`);
  };

  const response = await handler(new Request("https://function.example", {
    method: "POST",
    headers: { "x-retention-secret": "cron-secret" },
  }));
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), { claimed: 1, deleted: 1, failed: 0 });
  assert.ok(calls.findIndex((call) => call.url.includes("/storage/")) < calls.findIndex((call) => call.url.endsWith("/complete_retention_for_intake")));
});

test("failed Storage deletion leaves the intake record and releases its claim", async () => {
  calls.length = 0;
  globalThis.fetch = async (url, init) => {
    calls.push({ url, init });
    if (url.endsWith("/claim_expired_vehicle_intakes")) {
      return Response.json([{ intake_id: "intake-1", image_path: "user-1/photo.jpg" }]);
    }
    if (url.endsWith("/storage/v1/object/vehicle-intakes")) return new Response("unavailable", { status: 503 });
    if (url.endsWith("/release_retention_claim")) return Response.json(null);
    throw new Error(`Unexpected request: ${url}`);
  };

  const response = await handler(new Request("https://function.example", {
    method: "POST",
    headers: { "x-retention-secret": "cron-secret" },
  }));
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), { claimed: 1, deleted: 0, failed: 1 });
  assert.equal(calls.some((call) => call.url.endsWith("/complete_retention_for_intake")), false);
  assert.equal(calls.some((call) => call.url.endsWith("/release_retention_claim")), true);
});

test.after(() => {
  globalThis.fetch = originalFetch;
  delete globalThis.Deno;
});
