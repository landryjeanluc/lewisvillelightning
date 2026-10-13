# Deploying lvlnb.ca

The site is an authenticated team application. Astro builds private static HTML
and media; nginx checks the API session for each private request. FastAPI also
requires sessions independently. TLS terminates at the upstream proxy; the API
must listen only on loopback. The old shared-basic-auth setup is obsolete.

## Validate locally

```sh
nix develop --command bash tools/check.sh
nix develop --command ./deploy.sh --check-only
```

The first command is the full quality gate, including browser suites. The second
runs deployment's API/site checks without publishing. No test uses the live
production database. Tests create and destroy their own PostgreSQL cluster.

`site/package-lock.json` and `api/uv.lock` are the dependency sources of truth.
Use `npm ci` and `uv sync --frozen`, not an unpinned install during deployment.

## Runtime configuration

Store `/opt/lvlnb/.env` with mode 0600, readable by the service account:

```ini
DATABASE_URL=postgresql:///lvlnb
SESSION_SECRET=<at least 32 random bytes, generated on the host>
DATA_DIR=/srv/lvlnb-data
UPLOAD_DIR=/srv/lvlnb-uploads
PUBLIC_BASE_URL=https://lvlnb.ca
COOKIE_SECURE=1
CHAT_PLAYER_DMS=peers
```

Configure `SMTP_HOST`, `SMTP_PORT`, `SMTP_USER`, `SMTP_PASS`, and `SMTP_FROM` for
email recovery. Without SMTP, the endpoint gives the same generic response and
creates no token. Handle-only family accounts use an admin-assisted reset.

`CHAT_PLAYER_DMS=peers` allows player-to-player DMs and guardian/child DMs within
a linked family. `family` disables peer DMs. Neither setting permits unrelated
adult/child DMs, including admins. Team-room messages remain available to members.
All messages are screened; flagged and reported messages enter the admin queue.

The service starts with:

```sh
uv sync --frozen --no-dev
.venv/bin/uvicorn app:app --host 127.0.0.1 --port 8112
```

For NixOS, the service's `ReadWritePaths` must include `/srv/lvlnb-uploads`;
`ProtectSystem=strict` otherwise prevents image saves. Keep code read-only to the
service where practical. uv's native dependencies may need the existing
`LD_LIBRARY_PATH` configuration. Configure Uvicorn's trusted proxy addresses to
match the actual proxy chain, never `*`. Authentication uses Uvicorn's resolved
client address and does not trust raw forwarded headers itself.

## Hosting boundary

Public ingress (as of 2026-10-13) is the `hexpi-lan` **Cloudflare tunnel** on
ct170, not a port-forward and not NPM: Zero Trust → Public Hostname `lvlnb.ca` →
`http://192.168.1.20:8111`. Cloudflare terminates TLS; the public DNS record is a
proxied CNAME onto the tunnel. The tunnel's service type must be **HTTP** — the
arachnea vhost is a plain-HTTP listener and an `https://` origin fails the
handshake. Nothing inbound is open on the WAN, and the house FibreOp address is
dynamic, so no A record should ever be pointed at it again.

Because a CDN now sits in front of the gate, cache headers are load-bearing in a
way they were not on the LAN: Cloudflare caches by URL and will serve a cached
object **without consulting `auth_request`**. Images are in its default
cache-by-extension list, so removing an `expires` directive is not sufficient —
private media must send `Cache-Control: no-store` explicitly.

`ops/nginx.conf` is a validated reference server block. Integrate its requirements
into `HexPi/nixos-builds/hosts/arachnea/guests/default.nix`; it is not automatically
installed by `deploy.sh`. The deployed vhost currently satisfies the `no-store`,
`/uploads/` and 13 MB body-size requirements below, but still diverges from the
reference on CSP (absent), `X-Frame-Options` (`SAMEORIGIN`, not `DENY`),
`Referrer-Policy` (`strict-origin-when-cross-origin`, not `no-referrer`),
`X-Robots-Tag` (absent) and site-wide `no-store` on private HTML. It also gates
`/api/` at nginx — more restrictive than the JSON-401 rule below, at the cost of
feeding HTML to `fetch()` when a session expires.

- Gate HTML, photos, team images, calendars, rendered posters and uploads.
- Serve `/uploads/` from `/srv/lvlnb-uploads/` behind the same session gate.
- Let `/login`, `/forgot`, `/reset`, the manifest, worker, icons, fonts and public
  compiled assets load while signed out. The build checks the compiled bundles
  for full player names and private asset paths.
- Return `Cache-Control: no-store` for every private response, including media.
  Remove the old seven-day `expires` directives for `/photos/` and `/team/`.
- API authorization failures must remain JSON 401/403 responses, not redirects
  to an HTML sign-in page. The reference proxy delegates API authorization to the
  application, which denies by default.
- Set no-referrer, nosniff, framing protection and a content security policy.
  Disable reset-query logging at both proxies. Configure HTTPS redirect/HSTS on
  the TLS terminator and firewall the internal listener from public access.
- Permit 13 MB request bodies at the proxy for 12 MB image uploads plus multipart
  overhead. The app independently enforces request size, format and pixel limits.

Never publish `site/dist` to a public static host without a server-side login
gate. Client-side hiding is not authorization. Privacy flags reduce the content
rendered but do not make the schedule, artifacts or repository public-safe.

## Publish

```sh
nix develop --command ./deploy.sh
# Or backend only / include game posters:
nix develop --command ./deploy.sh --api-only
nix develop --command ./deploy.sh --posters
```

The script tests, builds, creates an owner-only on-host database dump, transfers
site/API/data, synchronizes the frozen production dependencies, restarts the
API, and verifies health and the external login gate. Failures return nonzero.
`.env`, the virtual environment, private handouts and logs remain host-owned.

The deployment account needs narrowly scoped permission to create the backup
directory, run `pg_dump` as `lvlnb`, sync the application directories and restart
`lvlnb-api`. Provision those permissions before deploying; the script must not
silently skip a failed backup or dependency sync. The API service must be able to
read the deployed files and write the upload directory.

Do not run two publishes concurrently. CI's deployment concurrency group covers
CI runs; coordinate manual deployments separately. Transfers are delayed within
each rsync, but this is not an atomic release of site, data and API together.
Use a maintenance window for schema or authorization changes.

Before publishing, the script checks every local Git worktree for unpublished
application edits. Review and commit the intended changes before creating the
release checkout; a clean isolated checkout must not silently omit newer work.
Static releases include `deployment.json` with the deployed Git revision so the
served version can be identified without guessing from its appearance.

After deployment, verify anonymously from the external origin that private
routes/media redirect or reject, and that login/manifest/worker/icons still work.
With a test account, check no-store headers, uploads, peer chat, unrelated
adult/child DM rejection, report removal, password changes and logout.

## Credential transition after the audit

Existing family passwords used a small generator. Reissue them after the updated
CLI is installed:

```sh
cd /opt/lvlnb
sudo -u lvlnb .venv/bin/python manage.py seed-families --force
```

This resets seeded accounts and signs out their existing sessions. Distribute
the new handouts privately and retire the old ones. Manually created guardians
need individual resets with `manage.py set-password HANDLE` or Admin. Do not put
passwords in shell arguments or CI output. The CLI displays a generated password
when no terminal is available; use it only in a private interactive session.

Invalidate any remaining old reset links and rotate `SESSION_SECRET` during the
transition to revoke all old sessions. Do not claim this happened merely because
the generator changed. The audit made no live account changes.

## Backup and recovery

Pre-deploy dumps are in `/var/backups/lvlnb/`, owned by the service account with
restricted permissions. This is a deployment safeguard, not a complete backup
policy: separately back up uploads, the data contract, secrets and the deployed
revision to restricted storage, and test a restore in an isolated database.

If a deployment fails, stop publishing, preserve error output without secrets,
and check `systemctl status lvlnb-api` and the service journal. To roll back code,
redeploy the previous known-good revision with its lockfiles. Schema changes are
additive, but inspect compatibility before starting an older binary. If a database
restore is needed, stop the API and restore the selected dump to a separate
replacement database, verify it, then switch the connection string. Never overwrite
the only live database or the only backup as an experiment.
