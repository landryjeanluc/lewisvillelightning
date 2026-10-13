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

## The rebuild — what it actually changes

An earlier version of this doc warned that switching would carry a `flake.lock`
bump to all 51 services on the box. **That was wrong.** Building the new system
and diffing it against the running one shows:

```
Added packages:
[A.]  #1  unit-lvlnb-api.service  <none>
Closure size: 2075 -> 2076 (25 added, 24 removed, delta +1, disk usage +6.4KiB)
```

One added systemd unit. Both systems carry the same nixpkgs revision
(`25.11.20260630.b6018f8`), so nextcloud, immich, postgres, cdecb, honda and the
arr stack are untouched. The only restart is nginx picking up the new vhost.

Always diff before switching a box like this:

```
cd ~/repos/HexPi/nixos-builds
nixos-rebuild build --flake .#arachnea --build-host arachnea
ssh arachnea nix run nixpkgs#nvd -- diff /run/current-system ./result
```

Then switch:

```
nixos-rebuild switch --flake .#arachnea --target-host arachnea \
  --build-host arachnea --use-remote-sudo
```

Rollback: `ssh arachnea 'sudo nixos-rebuild switch --rollback'`.

### Already staged on the box (done)

| | |
|---|---|
| `/opt/lvlnb` | API code + `.venv` with all deps, `.env` (0600, secret generated on-box) |
| `/srv/lvlnb` | the static site build |
| `/srv/lvlnb-data` | `data/*.json` — the API validates ids against this |
| `/srv/lvlnb-uploads` | empty, for admin photo uploads |

### After the switch

```
ssh arachnea 'sudo chown -R lvlnb:lvlnb /opt/lvlnb /srv/lvlnb-uploads'
ssh arachnea 'sudo systemctl restart lvlnb-api && systemctl is-active lvlnb-api'
ssh arachnea 'cd /opt/lvlnb && sudo -u lvlnb .venv/bin/python manage.py bootstrap'
curl -s localhost:8112/health   # on the box
```

Then the two steps only JL can do: an NPM proxy-host
`lvlnb.ca -> http://192.168.1.20:8111`, and a DNS record for lvlnb.ca.

## Re-labelling the family logins (one-off, 2026-10-13)

Parent accounts seeded before this now read "Mom to Olivier" for two different
Oliviers. `deploy.sh` ships `manage.py`, so after a deploy:

```
ssh arachnea 'cd /opt/lvlnb && sudo -u lvlnb .venv/bin/python manage.py rename-families --dry-run'
ssh arachnea 'cd /opt/lvlnb && sudo -u lvlnb .venv/bin/python manage.py rename-families'
```

Display names only — no passwords, no sessions, nobody is signed out. Safe to
re-run; the second run reports nothing to do. See `api/README.md`.

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
