# Deploying lvlnb.ca

The site is a static build served by nginx on **arachnea** (192.168.1.20) on
port **8111**, behind HTTP basic auth, with TLS terminated upstream by NPM.

## One-time setup — status

| step | state |
|---|---|
| `hexpi.sites.lvlnb` in `nixos-builds/hosts/arachnea/guests/default.nix` | done, commit `d5bc682` |
| `/srv/lvlnb` created, `jl:users` | done |
| `/var/lib/lvlnb/htpasswd` (user `lightning`, bcrypt) | done |
| site rsynced to `/srv/lvlnb` | done |
| **`nixos-rebuild switch` on arachnea** | **not run — see below** |
| NPM proxy-host `lvlnb.ca` → `http://192.168.1.20:8111` | not done (JL, NPM UI) |
| DNS `lvlnb.ca` → public IP | not done (JL, registrar) |

## The rebuild is deliberately not run

arachnea's current system generation was built **2026-10-10**. `flake.lock` was
updated **2026-10-11** (`flake.lock: update inputs (helios)`). A
`nixos-rebuild switch` today therefore ships that input bump to **all 51 running
services** on the box — nextcloud, immich, postgres, cdecb, honda, the arr
stack — not just this new vhost. That is a fleet update, and it is JL's to
time, not something to trigger as a side effect of adding a team website.

When you want it:

```
cd ~/repos/HexPi/nixos-builds
nixos-rebuild switch --flake .#arachnea --target-host arachnea \
  --build-host arachnea --use-remote-sudo
```

`--build-host arachnea` matters: this workstation does not have arachnea's
closure, so building locally would fetch an enormous amount for nothing.

Rollback if anything misbehaves:

```
ssh arachnea 'sudo nixos-rebuild switch --rollback'
```

The nginx config is validated at *build* time by NixOS, so a syntax error fails
the build rather than taking pa-web and dpt-plans down at switch time. The
config was evaluated already and emits the expected vhost, headers, auth and
firewall port.

## The stats API (lvlnb-api)

Declared in `nixos-builds/hosts/arachnea/guests/lvlnb.nix` (commit `18d9279`):
FastAPI on loopback **:8112**, database `lvlnb` on the shared Postgres, with the
static vhost proxying `^~ /api/` to it so the browser sees one origin.

First install on the host, after the rebuild:

```
sudo mkdir -p /opt/lvlnb && sudo chown lvlnb:lvlnb /opt/lvlnb
sudo -u lvlnb rsync -a ~/repos/LewisvilleLightning/api/ /opt/lvlnb/
sudo -u lvlnb sh -c 'cd /opt/lvlnb && uv venv && uv pip install -r <(uv export --no-hashes)'

# secrets — the app refuses to start without SESSION_SECRET
sudo -u lvlnb tee /opt/lvlnb/.env >/dev/null <<EOF
DATABASE_URL=postgresql:///lvlnb
SESSION_SECRET=$(head -c 32 /dev/urandom | base64)
DATA_DIR=/srv/lvlnb-data
COOKIE_SECURE=1
EOF
sudo chmod 600 /opt/lvlnb/.env

# the API validates ids against the data contract
sudo mkdir -p /srv/lvlnb-data && sudo chown jl:users /srv/lvlnb-data
rsync -a data/ arachnea:/srv/lvlnb-data/

sudo systemctl enable --now lvlnb-api
curl -s localhost:8112/health      # {"ok":true,"games":2,"players":19}
```

### The first admin

The API requires an admin to create users, so the very first one comes from the
box. `manage.py bootstrap` creates **jl@hexpi.ca** and refuses to run once any
account exists:

```
cd /opt/lvlnb && sudo -u lvlnb .venv/bin/python manage.py bootstrap
```

It prompts for a password (or mints one if there's no terminal). After that,
everyone else is added from **/admin → Team access** in the browser — no shell.

The CLI stays available as the lockout escape hatch:

```
manage.py list
manage.py add coach@example.ca "Coach" --admin
manage.py set-role coach@example.ca viewer
manage.py set-password jl@hexpi.ca
manage.py remove someone@example.ca
```

Both the CLI and the API refuse to demote or delete the **last** admin — losing
it would mean nobody could manage the team without shell access.

## Publishing a content update

Content changes need no rebuild — only an rsync:

```
cd site && npm run build
rsync -a --delete dist/ arachnea:/srv/lvlnb/
rsync -a data/ arachnea:/srv/lvlnb-data/     # if the contract changed
```

## Changing the team password

```
nix shell nixpkgs#apacheHttpd -c htpasswd -nbB lightning 'NEW-PASSWORD' \
  | ssh arachnea 'sudo tee /var/lib/lvlnb/htpasswd >/dev/null
                  && sudo chown nginx:nginx /var/lib/lvlnb/htpasswd
                  && sudo chmod 640 /var/lib/lvlnb/htpasswd'
```

No nginx reload is needed — `auth_basic_user_file` is read per request.

## Why basic auth

The roster is nineteen 12-year-olds rendered with full names and photo cards,
next to the exact arena and time of every game. JL's call (2026-10-12) was full
detail behind a login. `data/roster.json`'s `privacy` block can still reduce
what renders if that changes — it is one line, and the site rebuilds from it.
