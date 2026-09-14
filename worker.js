export default {
  async fetch(request, env) {
    const corsHeaders = {
      "Access-Control-Allow-Origin": "https://until.dr-assal01.workers.dev",
      "Access-Control-Allow-Methods": "POST, OPTIONS",
      "Access-Control-Allow-Headers": "Content-Type"
    };

    if (request.method === "OPTIONS") {
      return new Response(null, {
        status: 204,
        headers: corsHeaders
      });
    }

    if (request.method === "POST") {
      try {
        const data = await request.json();

        if (!data.to || !data.subject || !data.html) {
          return new Response(
            JSON.stringify({ error: "Missing required fields." }),
            {
              status: 400,
              headers: {
                "Content-Type": "application/json",
                ...corsHeaders
              }
            }
          );
        }

        const resendResponse = await fetch(
          "https://api.resend.com/emails",
          {
            method: "POST",
            headers: {
              "Authorization": `Bearer ${env.RESEND_API_KEY}`,
              "Content-Type": "application/json"
            },
            body: JSON.stringify({
              from: "UNTIL <onboarding@resend.dev>",
              to: data.to,
              subject: data.subject,
              html: data.html
            })
          }
        );

        const result = await resendResponse.json();

        return new Response(JSON.stringify(result), {
          status: resendResponse.status,
          headers: {
            "Content-Type": "application/json",
            ...corsHeaders
          }
        });

      } catch (error) {
        return new Response(
          JSON.stringify({ error: error.message }),
          {
            status: 500,
            headers: {
              "Content-Type": "application/json",
              ...corsHeaders
            }
          }
        );
      }
    }

    return new Response("UNTIL email service is running.", {
      status: 200,
      headers: corsHeaders
    });
  },

  async scheduled(event, env, ctx) {
    try {
      const now = new Date().toISOString();

      const response = await fetch(
        `${env.SUPABASE_URL}/rest/v1/messages?status=eq.scheduled&delivery_date=lte.${encodeURIComponent(now)}&select=id,recipient_email,message,delivery_date`,
        {
          headers: {
            "apikey": env.SUPABASE_SERVICE_ROLE_KEY,
            "Authorization": `Bearer ${env.SUPABASE_SERVICE_ROLE_KEY}`
          }
        }
      );

      if (!response.ok) {
        console.log(
          "Supabase query failed:",
          await response.text()
        );
        return;
      }

      const messages = await response.json();

      console.log(
        `Found ${messages.length} message(s) ready for delivery.`
      );

      for (const item of messages) {

        await fetch(
          `${env.SUPABASE_URL}/rest/v1/messages?id=eq.${item.id}`,
          {
            method: "PATCH",
            headers: {
              "apikey": env.SUPABASE_SERVICE_ROLE_KEY,
              "Authorization": `Bearer ${env.SUPABASE_SERVICE_ROLE_KEY}`,
              "Content-Type": "application/json"
            },
            body: JSON.stringify({
              status: "sending"
            })
          }
        );

        const resendResponse = await fetch(
          "https://api.resend.com/emails",
          {
            method: "POST",
            headers: {
              "Authorization": `Bearer ${env.RESEND_API_KEY}`,
              "Content-Type": "application/json"
            },
            body: JSON.stringify({
              from: "UNTIL <onboarding@resend.dev>",
              to: item.recipient_email,
              subject: "A message from UNTIL",
              html: `
                <div style="
                  font-family:Arial,sans-serif;
                  max-width:600px;
                  margin:auto;
                  padding:40px;
                ">
                  <h1 style="font-weight:400;">
                    Until now.
                  </h1>

                  <p style="color:#666;">
                    Someone left this message for you.
                  </p>

                  <div style="
                    margin:30px 0;
                    padding:30px;
                    background:#f5f5f5;
                    border-radius:12px;
                    font-size:18px;
                    line-height:1.7;
                    white-space:pre-wrap;
                  ">${escapeHtml(item.message)}</div>

                  <p style="
                    color:#888;
                    font-size:13px;
                  ">
                    Delivered by UNTIL.
                  </p>
                </div>
              `
            })
          }
        );

        if (resendResponse.ok) {

          await fetch(
            `${env.SUPABASE_URL}/rest/v1/messages?id=eq.${item.id}`,
            {
              method: "PATCH",
              headers: {
                "apikey": env.SUPABASE_SERVICE_ROLE_KEY,
                "Authorization": `Bearer ${env.SUPABASE_SERVICE_ROLE_KEY}`,
                "Content-Type": "application/json"
              },
              body: JSON.stringify({
                status: "delivered"
              })
            }
          );

          console.log(
            `Message ${item.id} delivered.`
          );

        } else {

          console.log(
            `Failed to send message ${item.id}:`,
            await resendResponse.text()
          );

          await fetch(
            `${env.SUPABASE_URL}/rest/v1/messages?id=eq.${item.id}`,
            {
              method: "PATCH",
              headers: {
                "apikey": env.SUPABASE_SERVICE_ROLE_KEY,
                "Authorization": `Bearer ${env.SUPABASE_SERVICE_ROLE_KEY}`,
                "Content-Type": "application/json"
              },
              body: JSON.stringify({
                status: "scheduled"
              })
            }
          );
        }
      }

    } catch (error) {
      console.log(
        "Scheduled delivery error:",
        error
      );
    }
  }
};


function escapeHtml(text) {
  return String(text)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#039;");
}
