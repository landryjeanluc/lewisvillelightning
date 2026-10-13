# Security and correctness audit — October 13, 2026

This audit reviewed the FastAPI service, PostgreSQL schema, account CLI, Astro
pages and client scripts, PWA caching, Spordle import pipeline, deployment script,
and tests. The fixes are in this checkout. **This document is not a production
security sign-off:** the running service has not been updated by this audit.

The existing architecture is worth keeping: SQL is parameterized, invitations
control membership, goals have family-level authorization, play documents are
validated, and the integration suite uses real PostgreSQL. A rewrite would
throw away those working boundaries. The changes concentrate security rules
in shared request/image/client modules and test the concrete failures below.

## Findings and fixes

| Priority | Finding | Correction and evidence |
| --- | --- | --- |
| High | Stats, profiles, news, notes and jobs did not authenticate at the API boundary. | Session required by default, with an explicit public authentication/health allowlist. Anonymous access regressions cover the sensitive routes. The live site's proxy did gate the two paths tested before changes. |
| High | Family passwords came from 12 × 12 × 90 choices: 12,960 combinations. | New credentials use 144 random bits. Handout directories/files are 0700/0600. **Existing credentials still require reissue.** |
| High | Password recovery disclosed successful delivery, stored raw reset links in audit rows and logs, and had no request limit. | Identical responses, database throttles before account lookup, SMTP after the response, hash-only storage, no token creation without configured SMTP, and no raw-link logging. SMTP uses certificate verification. |
| High | Concurrent login/reset requests could defeat attempt limits or redeem a token twice. Password changes through the CLI did not revoke sessions. | Database locks reserve attempts and serialize resets; all password-change paths revoke sessions and outstanding reset links. Concurrency tests and CLI regressions cover these cases. |
| High | Admin user/news tables interpolated stored text into HTML; Markdown allowed unsafe link schemes; embedded JSON could terminate its script element. | Escaped HTML/attributes, sanitized generated Markdown, escaped script JSON, safe same-origin redirects. Unit and browser tests exercise payloads. |
| High | Chat bypassed moderation, allowed unrelated adult–child DMs, and offered no reporting. | All sends are screened, high-severity content is withheld, members can report messages, and admins can remove reported content. Players can message each other and linked guardians, as requested; unrelated adults use the shared room. The policy applies to existing rooms too. |
| High | Moderation's “remove” action only changed the flag, leaving the harmful content published. News edits bypassed screening. | Removal updates the underlying message/note/profile/news/job content when it still matches the reviewed text. Stale flags cannot erase newer edits. News creates and edits both screen text. Clearing a held flag does not silently republish it. |
| High | CSRF checks existed only in chat; other cookie-authenticated writes had no origin checks. | Shared middleware checks Origin and Fetch Metadata for writes, including authentication. SameSite and HttpOnly cookies remain enabled. |
| High | HTTP caching and browser state could preserve private content after logout. | API responses, including errors, use no-store. Logout revokes sessions and requests cache/storage clearing. Restored pages recheck the login gate. Draft plays use tab-scoped session storage; old persistent drafts are removed. **Static hosting headers must be updated separately.** |
| High | Photo cards bypassed the photo-privacy flag; synchronization reset privacy to full names/photos; jersey reuse could attach one child's history to another. | Components respect privacy, opted-out builds remove photo/team directories, sync preserves the configured privacy, and imports refuse identity changes under an existing player ID. |
| Medium | Admin-created accounts accepted but discarded family-link fields. Unlinked viewers could claim unassigned jobs; claims raced reassignment. | Family links persist and validate; claims require an admin or linked parent, lock the assignment, and refuse stealing another guardian's claim. |
| Medium | Deleting an account failed when it had authored content or activity history; last-admin checks could race. | Nullable author foreign keys preserve history; CLI/API administration shares a database lock; self-deletion is refused. |
| Medium | Unbounded bodies, bcrypt inputs, image dimensions and numeric IDs could consume resources or trigger server errors. | Request byte limits, UTF-8 password limits, image pixel/format checks, bounded identifiers/fields, and validation responses without echoed input. Image decoding and bcrypt run outside the event loop. |
| Medium | Duplicate scoresheet rows failed at SQL insertion; partial scores crashed season totals; unfinished games counted in skater totals. | Validate unique players, derive totals from complete final results, bound score inputs. Concurrent slug and captain writes also serialize their uniqueness checks. |
| Medium | Several admin saves had no corresponding team-page reads. Family accounts had no password-change UI. | Game pages load scores/notes/jobs and allow authorized claims; team/player stats load completed scoresheets; cards/bios load profile updates; Account supports password changes and sign-out. |
| Medium | Importing a partial schedule discarded older events; the adapter copied one ambiguous score to both teams; calendar escaping missed semicolons. | Preserve events outside partial captures, require separate home/away scores, reject duplicate IDs, escape calendar text and verify UTF-8 line folding. |
| Medium | “Validate” only built the site; Python dependencies were unpinned; deploy continued after a failed restart or gate check. | Type checking, adversarial tests, a public-bundle privacy check, uv.lock, one quality-gate script, pre-deploy database backup, frozen dependency sync, and fatal deploy verification failures. |

## Verification

The final full gate passed **514 checks**: 308 API checks, 20 account-CLI
checks, 160 checks across seven browser suites, and 26 unit/import checks.
Astro reported zero errors and zero warnings and built 40 pages. A subsequent
copy-only correction to the unverified-schedule banner also passed site validation.

Run the complete quality gate from the repository root:

```sh
nix develop --command bash tools/check.sh
```

It installs the locked JavaScript dependencies, runs Astro's strict type check,
unit tests and build, checks public bundles for roster leakage, runs API and CLI
tests against throwaway PostgreSQL, exercises importer tests, and runs all browser
harnesses. Authentication tests include concurrent attempts, token reuse,
malformed cookies, spoofed forwarding headers, oversized bodies and logout
replay. Browsers use controlled API fixtures; the separate API tests execute
against the real database.

Additional audit checks:

- npm and pip-audit found no known vulnerabilities in the dependencies checked.
- Gitleaks scanned repository history. Its one finding was the browser
  extension's public RSA key in `manifest.json`, not a secret. This does not
  establish that every credential or personal detail is absent from history.
- Python undefined-name checks and shell syntax/static checks were run.
- `ops/nginx.conf` passed nginx configuration validation.
- Anonymous HTTPS checks of the running `/` and `/api/stats/season` returned login
  redirects. No authenticated production data was downloaded for the audit.

## Required before declaring the running service hardened

1. Review and deploy the application changes with a restorable database backup.
   The new 32-byte session-secret minimum deliberately rejects weak configuration.
2. Apply the static hosting and upload-serving requirements in `docs/DEPLOY.md`.
   The reference nginx configuration is prepared here; the NixOS host configuration
   is in a separate repository and is not changed by this checkout.
3. Reissue existing family passwords, distribute the new owner-only handouts,
   and invalidate outstanding reset links/sessions. Merely deploying the generator
   does not rotate old credentials. Remove obsolete handouts from controlled storage.
4. Ensure access logs at **both** TLS proxy and inner nginx omit reset query
   strings. Review access to prior application logs/audit exports: earlier versions
   recorded reset links. The new code prevents further writes; it does not rewrite
   historical backups or system logs.
5. Verify the real hosting boundary: anonymous pages, photos, team images,
   calendars, rendered posters and uploads must not be downloadable; authenticated
   private responses must carry no-store. Verify this from the external origin,
   including after logout.

## Remaining limits and operating decisions

- Moderation is a local keyword/pattern filter with reports, not a comprehensive
  abuse detector. English/French terms, Unicode normalization and missing-file
  failure checks improve coverage; context, coded language and new evasions still
  need human review. The Review queue does not send automatic staff notifications.
  A named responsible adult must check it, including reports of private messages.
- Ordinary private conversations remain participant-only. Flagged/reported
  message bodies are visible to admins, and that exception is stated before
  sending. Admin status alone does not unlock unflagged private history.
- Production backups, restoration, staff review cadence, account removal at
  season end, consent records, and chat/flag retention need operational ownership.
  This audit did not delete live messages or create recurring jobs.
- This remains a static site for schedule/roster content. Imports require a build
  and publish; build-time “next game” selections do not advance themselves at
  midnight. Live stats represent coach-entered completed scoresheets; imported
  statistics remain a separate source and are not silently added to them.
- The data contract uses jersey-derived player IDs. The new import guard stops
  silent reassignment; a new season or jersey reassignment still needs an explicit
  identity/history migration. Do not bypass the guard by editing IDs casually.
- Media and full roster data already exist in git. Keep the repository, CI
  artifacts, rendered posters and backups restricted to authorized adults.
  Presentation privacy settings do not redact git history or revoke screenshots.
- Deployment still replaces site/API/data directories in place (with delayed
  rsync updates). It is not an atomic release across all three directories and
  does not automatically roll back a failed database migration. Use a maintenance
  window and the documented restore procedure.

The request-boundary and recovery changes follow the relevant
[OWASP CSRF guidance](https://cheatsheetseries.owasp.org/cheatsheets/Cross-Site_Request_Forgery_Prevention_Cheat_Sheet.html)
and [password recovery guidance](https://cheatsheetseries.owasp.org/cheatsheets/Forgot_Password_Cheat_Sheet.html).
