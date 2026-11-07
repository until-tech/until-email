# UNTIL deployment and verification checklist

These changes are staged on a development branch and are NOT automatically deployed.

## Before deploying
1. Back up the Supabase `messages` table and storage metadata.
2. Confirm the `messages` table contains `id`, `status`, `delivery_date`, `recipient_email`, `message`, and `photo_paths` columns.
3. Confirm Cloudflare Worker secrets: `SUPABASE_URL`, `SUPABASE_SERVICE_ROLE_KEY`, `RESEND_API_KEY`; optional `RESEND_FROM_EMAIL` must be a verified sending identity.
4. Confirm the Supabase Storage bucket `message-photos` exists and private signed URLs are permitted.
5. Confirm Resend domain verification: `onboarding@resend.dev` is normally limited to testing/authorized recipients.
6. Confirm Cloudflare Cron Trigger is enabled for the email worker. Cron: every minute.
7. Confirm Supabase row-level security allows anonymous message insert, scoped photo upload, and the intended `photo_paths` update. Do not disable RLS broadly to work around failures.

## Test before production
- Send a message without photos, scheduled a few minutes ahead.
- Send a message with one supported photo and check its signed link from the received email.
- Check invalid dates and oversized/unsupported photos are rejected.
- Check that a failed photo upload does not prompt the user to submit a duplicate message.
- Confirm only one email is delivered if two scheduled invocations overlap.
- Confirm email failures return status to `scheduled` for retry.
- Confirm public POST to the email worker returns 405.
- Confirm no personal message data appears in Worker logs.

## Operational caveats
- Messages stuck in `sending` from an older version are intentionally NOT automatically retried. Before manually resetting any such row, verify in Resend that it was not already sent. Blind resets can duplicate messages.
- A crash after Resend accepts a message but before Supabase marks it delivered may leave `sending`. Reconcile manually using provider logs. Exactly-once delivery cannot be guaranteed by the current schema.
- Signed photo links expire after seven days.
- The current form inserts the message before uploading photos; if photo processing fails, the message remains scheduled and may deliver without photos. This needs a transactional server-side scheduling API for a full fix.
- Confirmation emails were disabled in this patch because the former unauthenticated POST endpoint allowed arbitrary email sending. Reintroduce confirmation only through a protected server-side route.
- Do not merge/deploy until Cloudflare and Supabase integration testing is completed.
