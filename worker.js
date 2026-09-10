export default {
  async fetch(request, env) {
    if (request.method !== "POST") {
      return new Response("UNTIL email service is running.");
    }

    try {
      const data = await request.json();

      const response = await fetch("https://api.resend.com/emails", {
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
      });

      const result = await response.json();

      return new Response(JSON.stringify(result), {
        status: response.status,
        headers: {
          "Content-Type": "application/json"
        }
      });
    } catch (error) {
      return new Response(
        JSON.stringify({ error: error.message }),
        {
          status: 500,
          headers: {
            "Content-Type": "application/json"
          }
        }
      );
    }
  }
};
