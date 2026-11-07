// UNTIL delivery worker. Public email sending is deliberately disabled:
// the previous POST endpoint could be used to send arbitrary email.
const jsonHeaders = { "Content-Type": "application/json" };
const escapeHtml = (value) => String(value ?? "").replace(/[&<>"']/g, (c) => ({
  "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;"
}[c]));

function dbHeaders(env, extra = {}) {
  return {
    apikey: env.SUPABASE_SERVICE_ROLE_KEY,
    Authorization: `Bearer ${env.SUPABASE_SERVICE_ROLE_KEY}`,
    ...extra
  };
}

async function dbRequest(env, path, options = {}) {
  const response = await fetch(`${env.SUPABASE_URL}/rest/v1/${path}`, {
    ...options,
    headers: { ...dbHeaders(env), ...(options.headers || {}) }
  });
  if (!response.ok) throw new Error(`Database HTTP ${response.status}: ${(await response.text()).slice(0, 300)}`);
  return response;
}

async function markStatus(env, id, from, to) {
  const query = `messages?id=eq.${encodeURIComponent(id)}&status=eq.${from}`;
  const response = await dbRequest(env, query, {
    method: "PATCH",
    headers: { "Content-Type": "application/json", Prefer: "return=representation" },
    body: JSON.stringify({ status: to })
  });
  return (await response.json()).length === 1;
}

async function photoLinks(env, item) {
  if (!Array.isArray(item.photo_paths) || !item.photo_paths.length) return "";
  const links = [];
  for (const path of item.photo_paths.slice(0, 10)) {
    if (typeof path !== "string" || !path.startsWith(item.id + "/")) continue;
    const response = await fetch(
      `${env.SUPABASE_URL}/storage/v1/object/sign/message-photos/${path.split("/").map(encodeURIComponent).join("/")}`,
      {
        method: "POST",
        headers: { ...dbHeaders(env), "Content-Type": "application/json" },
        body: JSON.stringify({ expiresIn: 604800 })
      }
    );
    if (!response.ok) {
      console.error("Unable to sign photo", item.id, response.status);
      continue;
    }
    const result = await response.json();
    if (!result.signedURL) continue;
    const url = new URL(result.signedURL, env.SUPABASE_URL);
    if (url.origin !== new URL(env.SUPABASE_URL).origin) continue;
    links.push(`<li><a href="${escapeHtml(url.href)}">View attached photo ${links.length + 1}</a></li>`);
  }
  return links.length
    ? `<p>Photos (links expire after 7 days):</p><ul>${links.join("")}</ul>`
    : "";
}

async function deliver(env, item) {
  // Claim exactly once: only a scheduled message can transition to sending.
  if (!(await markStatus(env, item.id, "scheduled", "sending"))) return;
  let sent = false;
  try {
    const attachments = await photoLinks(env, item);
    const html = `<div style="font-family:Arial,sans-serif;max-width:600px;margin:auto;padding:40px">
      <h1>Until now.</h1><p>Someone left this message for you.</p>
      <div style="margin:30px 0;padding:30px;background:#f5f5f5;white-space:pre-wrap">${escapeHtml(item.message)}</div>
      <p style="color:#888">Delivered by UNTIL.</p>${attachments}</div>`;
    const response = await fetch("https://api.resend.com/emails", {
      method: "POST",
      headers: { Authorization: `Bearer ${env.RESEND_API_KEY}`, "Content-Type": "application/json" },
      body: JSON.stringify({
        from: env.RESEND_FROM_EMAIL || "UNTIL <onboarding@resend.dev>",
        to: item.recipient_email,
        subject: "A message from UNTIL",
        html
      })
    });
    if (!response.ok) throw new Error(`Resend HTTP ${response.status}: ${(await response.text()).slice(0, 300)}`);
    sent = true;
    if (!(await markStatus(env, item.id, "sending", "delivered"))) {
      throw new Error("Sent email but could not confirm delivery status");
    }
    console.log("Delivered message", item.id);
  } catch (error) {
    console.error("Delivery error for", item.id, String(error));
    // Retry only if we KNOW sending failed. Once accepted by Resend,
    // never automatically resend: doing so could duplicate delivery.
    if (!sent) {
      try { await markStatus(env, item.id, "sending", "scheduled"); }
      catch (resetError) { console.error("Failed to restore scheduled state", item.id, String(resetError)); }
    }
  }
}

export default {
  async fetch(request) {
    if (request.method === "GET") {
      return new Response(JSON.stringify({ service: "UNTIL delivery", status: "running" }), { headers: jsonHeaders });
    }
    return new Response(JSON.stringify({ error: "Public email sending is disabled" }), {
      status: 405, headers: { ...jsonHeaders, Allow: "GET" }
    });
  },
  async scheduled(event, env, ctx) {
    ctx.waitUntil((async () => {
      if (!env.SUPABASE_URL || !env.SUPABASE_SERVICE_ROLE_KEY || !env.RESEND_API_KEY) {
        console.error("Missing required delivery environment variables");
        return;
      }
      try {
        const now = new Date().toISOString();
        const response = await dbRequest(env,
          `messages?status=eq.scheduled&created_at=gte.${encodeURIComponent(env.DELIVERY_CREATED_AFTER || "2026-11-07T00:00:00Z")}&delivery_date=lte.${encodeURIComponent(now)}&select=id,recipient_email,message,delivery_date,photo_paths&order=delivery_date.asc&limit=50`);
        const items = await response.json();
        for (const item of items) await deliver(env, item);
      } catch (error) { console.error("Scheduled processing failed", String(error)); }
    })());
  }
};
