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

## Publishing a content update

Content changes need no rebuild — only an rsync:

```
cd site && npm run build
rsync -a --delete dist/ arachnea:/srv/lvlnb/
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
