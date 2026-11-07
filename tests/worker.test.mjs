import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

const source = await readFile(new URL("../worker.js", import.meta.url), "utf8");
const { default: worker } = await import("data:text/javascript;charset=utf-8," + encodeURIComponent(source));
const env = {
  SUPABASE_URL: "https://example.supabase.co",
  SUPABASE_SERVICE_ROLE_KEY: "test-service-key",
  RESEND_API_KEY: "test-resend-key",
  DELIVERY_CREATED_AFTER: "2026-11-07T00:00:00Z"
};
const id = "123e4567-e89b-12d3-a456-426614174000";
const item = { id, recipient_email: "recipient@example.org", message: "Hello <world> & friends", photo_paths: [] };
const json = (data, status = 200) => new Response(JSON.stringify(data), { status, headers: { "Content-Type": "application/json" } });

async function invokeScheduled(mockFetch) {
  const oldFetch = globalThis.fetch;
  globalThis.fetch = mockFetch;
  try {
    const tasks = [];
    await worker.scheduled({}, env, { waitUntil: (promise) => tasks.push(promise) });
    await Promise.all(tasks);
  } finally { globalThis.fetch = oldFetch; }
}

test("public endpoint never sends arbitrary email", async () => {
  const response = await worker.fetch(new Request("https://until-email.example", {
    method: "POST",
    body: JSON.stringify({ to: "victim@example.org", html: "spam", subject: "spam" })
  }));
  assert.equal(response.status, 405);
});
test("the delivery query excludes messages before the launch cutoff", async () => {
  await invokeScheduled(async (url) => {
    assert.match(String(url), /created_at=gte\.2026-11-07T00%3A00%3A00Z/);
    assert.match(String(url), /status=eq\.scheduled/);
    return json([]);
  });
});
test("successful email is marked delivered and content is HTML escaped", async () => {
  let currentStatus = "scheduled";
  let sends = 0;
  await invokeScheduled(async (url, options = {}) => {
    const u = String(url);
    if (u.includes("/rest/v1/messages?") && !options.method) return json([item]);
    if (u.includes("/rest/v1/messages?") && options.method === "PATCH") {
      const from = new URL(u).searchParams.get("status").replace("eq.", "");
      if (from !== currentStatus) return json([]);
      currentStatus = JSON.parse(options.body).status;
      return json([{ id }]);
    }
    if (u === "https://api.resend.com/emails") {
      sends++;
      const body = JSON.parse(options.body);
      assert.match(body.html, /Hello &lt;world&gt; &amp; friends/);
      assert.doesNotMatch(body.html, /Hello <world>/);
      return json({ id: "sent-1" });
    }
    throw Error("Unexpected fetch " + u);
  });
  assert.equal(sends, 1);
  assert.equal(currentStatus, "delivered");
});
test("an already claimed message is not sent again", async () => {
  let sends = 0;
  await invokeScheduled(async (url, options = {}) => {
    if (!options.method) return json([item]);
    if (options.method === "PATCH") return json([]);
    if (String(url).includes("resend.com")) { sends++; return json({ id: "bad" }); }
    throw Error("Unexpected fetch");
  });
  assert.equal(sends, 0);
});
test("failed provider response restores scheduled state for retry", async () => {
  let currentStatus = "scheduled";
  await invokeScheduled(async (url, options = {}) => {
    const u = String(url);
    if (u.includes("/rest/v1/messages?") && !options.method) return json([item]);
    if (options.method === "PATCH") {
      const from = new URL(u).searchParams.get("status").replace("eq.", "");
      assert.equal(from, currentStatus);
      currentStatus = JSON.parse(options.body).status;
      return json([{ id }]);
    }
    if (u.includes("resend.com")) return json({ error: "service unavailable" }, 503);
    throw Error("Unexpected fetch " + u);
  });
  assert.equal(currentStatus, "scheduled");
});

test("private photo link is included only after successful signing", async () => {
  let currentStatus = "scheduled";
  let emailHtml = "";
  const withPhoto = { ...item, photo_paths: [id + "/photo.png"] };
  await invokeScheduled(async (url, options = {}) => {
    const u = String(url);
    if (u.includes("/rest/v1/messages?") && !options.method) return json([withPhoto]);
    if (u.includes("/storage/v1/object/sign/")) {
      assert.equal(options.method, "POST");
      return json({ signedURL: "/object/sign/message-photos/" + id + "/photo.png?token=private-test-token" });
    }
    if (options.method === "PATCH") {
      const from = new URL(u).searchParams.get("status").replace("eq.", "");
      assert.equal(from, currentStatus);
      currentStatus = JSON.parse(options.body).status;
      return json([{ id }]);
    }
    if (u.includes("api.resend.com")) {
      emailHtml = JSON.parse(options.body).html;
      return json({ id: "sent-with-photo" });
    }
    throw Error("Unexpected fetch: " + u);
  });
  assert.equal(currentStatus, "delivered");
  assert.match(emailHtml, /\/storage\/v1\/object\/sign\/message-photos\//);
  assert.match(emailHtml, /private-test-token/);
});
test("failed photo signing prevents incomplete email and schedules retry", async () => {
  let currentStatus = "scheduled";
  let sendCount = 0;
  const withPhoto = { ...item, photo_paths: [id + "/photo.png"] };
  await invokeScheduled(async (url, options = {}) => {
    const u = String(url);
    if (u.includes("/rest/v1/messages?") && !options.method) return json([withPhoto]);
    if (u.includes("/storage/v1/object/sign/")) return json({ error: "storage unavailable" }, 503);
    if (options.method === "PATCH") {
      const from = new URL(u).searchParams.get("status").replace("eq.", "");
      assert.equal(from, currentStatus);
      currentStatus = JSON.parse(options.body).status;
      return json([{ id }]);
    }
    if (u.includes("api.resend.com")) { sendCount++; return json({ id: "unexpected" }); }
    throw Error("Unexpected fetch: " + u);
  });
  assert.equal(sendCount, 0);
  assert.equal(currentStatus, "scheduled");
});
