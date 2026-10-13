# Game assignment email plan

The Account page shows current family assignments immediately, including the task,
upcoming game, venue, note and claiming volunteer. Assignment emails are **not yet
sent**. Account contact editing allows parents to replace their seeded login handle
with an email address; changing it requires their current password. Phone numbers
are optional, private account fields and are not a messaging subscription.

Implement delivery using the existing SMTP transport with these prerequisites:

1. Verify each parent's email address using an expiring, single-use hashed token.
   Do not deliver children's schedules to an unverified address. Keep login email
   changes and notification verification separate; changing the address clears its
   verification. Provide an assignment-email preference and explain its purpose.
2. In the same database transaction as a changed game assignment, insert an outbox
   event with an assignment revision and a unique idempotency key. Notify eligible
   linked parents on a new assignment or reassignment; repeated saves of the same
   assignment must not create duplicate mail. Notify the previous family when
   their responsibility is removed. Claiming a task is a separate event, not a new
   family assignment. Schedule changes/cancellations need corresponding updates.
3. A background worker reads committed outbox records and resolves the current
   family links, verified addresses, preferences and assignment revision again.
   Suppress superseded assignments and removed recipients. Retry temporary SMTP
   failures with bounded backoff; record delivered/failed state, without logging
   message bodies, reset tokens, phone numbers or private email addresses.
4. Send one private message per parent with the task name and a sign-in link to
   the game. Avoid putting a child's name or location into the subject or sending
   roster-wide recipient lists. The authenticated site remains the source of truth.
5. Give admins delivery status and a controlled retry action. Test duplicate saves,
   reassignment, cancellation, missing/unverified email, changed player links,
   worker restarts and SMTP outages. Use a local mail sink before enabling live
   delivery; enable only after verification and SMTP configuration are confirmed.

The existing password-reset SMTP helper alone is insufficient: fire-and-forget mail
from the assignment request would lose notifications on failure and send duplicates
on retries. An outbox also keeps a mail outage from blocking a coach's assignment.
