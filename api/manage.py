#!/usr/bin/env python3
"""
lvlnb account management, for the box.

The very first admin cannot be created through the API — the API requires an
admin to create users. This is that bootstrap, plus the shell-level escape
hatch for the day someone locks themselves out.

  python manage.py bootstrap                      # create jl@hexpi.ca as admin
  python manage.py add jl@hexpi.ca "JL" --admin
  python manage.py list
  python manage.py set-role coach@example.ca admin
  python manage.py set-password jl@hexpi.ca
"""
from __future__ import annotations

import argparse
import asyncio
import getpass
import os
import secrets
import sys

import asyncpg
import bcrypt

DATABASE_URL = os.environ.get("DATABASE_URL", "postgresql:///lvlnb")
FIRST_ADMIN_EMAIL = "jl@hexpi.ca"
FIRST_ADMIN_NAME = "JL"
MIN_PASSWORD = 8


def read_password(confirm: bool = True) -> str:
    """Prompt twice, or mint one when there is no terminal to prompt on."""
    if not sys.stdin.isatty():
        pw = secrets.token_urlsafe(12)
        print(f"  no tty — generated password: {pw}")
        return pw
    while True:
        pw = getpass.getpass("  password: ")
        if len(pw) < MIN_PASSWORD:
            print(f"  must be at least {MIN_PASSWORD} characters")
            continue
        if confirm and pw != getpass.getpass("  again: "):
            print("  they did not match")
            continue
        return pw


def hash_password(raw: str) -> str:
    return bcrypt.hashpw(raw.encode(), bcrypt.gensalt()).decode()


async def main() -> int:
    ap = argparse.ArgumentParser(description="lvlnb accounts")
    sub = ap.add_subparsers(dest="cmd", required=True)

    sub.add_parser("bootstrap", help=f"create {FIRST_ADMIN_EMAIL} as the first admin")
    sub.add_parser("list", help="list accounts")

    a = sub.add_parser("add", help="add an account")
    a.add_argument("email"); a.add_argument("name")
    a.add_argument("--admin", action="store_true", help="grant the admin role")

    r = sub.add_parser("set-role", help="change someone's role")
    r.add_argument("email"); r.add_argument("role", choices=["admin", "viewer"])

    s = sub.add_parser("set-password", help="reset someone's password")
    s.add_argument("email")

    d = sub.add_parser("remove", help="delete an account")
    d.add_argument("email")

    args = ap.parse_args()
    conn = await asyncpg.connect(DATABASE_URL)
    try:
        if args.cmd == "list":
            rows = await conn.fetch(
                "SELECT email, display_name, role, last_login_at FROM users"
                " ORDER BY role, lower(display_name)")
            if not rows:
                print("no accounts yet — run: python manage.py bootstrap")
                return 0
            for r_ in rows:
                seen = r_["last_login_at"].strftime("%Y-%m-%d") if r_["last_login_at"] else "never"
                print(f"  {r_['role']:<6} {r_['email']:<30} {r_['display_name']:<20} last login {seen}")
            return 0

        if args.cmd == "bootstrap":
            n = await conn.fetchval("SELECT count(*) FROM users")
            if n:
                print(f"{n} account(s) already exist — bootstrap is for an empty database.")
                print("Use: python manage.py add <email> <name> --admin")
                return 1
            print(f"Creating the first admin: {FIRST_ADMIN_EMAIL}")
            pw = read_password()
            await conn.execute(
                "INSERT INTO users (email, display_name, password_hash, role)"
                " VALUES ($1,$2,$3,'admin')",
                FIRST_ADMIN_EMAIL, FIRST_ADMIN_NAME, hash_password(pw))
            print(f"  done. Sign in at /admin as {FIRST_ADMIN_EMAIL}.")
            print("  Everyone else can be added from there — no shell needed.")
            return 0

        if args.cmd == "add":
            email = args.email.strip().lower()
            if await conn.fetchval("SELECT 1 FROM users WHERE lower(email) = $1", email):
                print(f"{email} already has an account"); return 1
            pw = read_password()
            await conn.execute(
                "INSERT INTO users (email, display_name, password_hash, role)"
                " VALUES ($1,$2,$3,$4)",
                email, args.name, hash_password(pw), "admin" if args.admin else "viewer")
            print(f"  added {email} as {'admin' if args.admin else 'viewer'}")
            return 0

        if args.cmd == "set-role":
            email = args.email.strip().lower()
            cur = await conn.fetchval("SELECT role FROM users WHERE lower(email) = $1", email)
            if cur is None:
                print(f"no account for {email}"); return 1
            if cur == "admin" and args.role != "admin":
                admins = await conn.fetchval("SELECT count(*) FROM users WHERE role='admin'")
                if admins <= 1:
                    print("refusing: that is the only admin, and nobody could manage the team")
                    return 1
            await conn.execute("UPDATE users SET role=$1 WHERE lower(email)=$2", args.role, email)
            print(f"  {email} is now {args.role}")
            return 0

        if args.cmd == "set-password":
            email = args.email.strip().lower()
            if not await conn.fetchval("SELECT 1 FROM users WHERE lower(email) = $1", email):
                print(f"no account for {email}"); return 1
            pw = read_password()
            await conn.execute("UPDATE users SET password_hash=$1 WHERE lower(email)=$2",
                               hash_password(pw), email)
            print(f"  password reset for {email}")
            return 0

        if args.cmd == "remove":
            email = args.email.strip().lower()
            row = await conn.fetchrow("SELECT id, role FROM users WHERE lower(email) = $1", email)
            if row is None:
                print(f"no account for {email}"); return 1
            if row["role"] == "admin":
                admins = await conn.fetchval("SELECT count(*) FROM users WHERE role='admin'")
                if admins <= 1:
                    print("refusing: that is the only admin"); return 1
            await conn.execute("UPDATE audit_log    SET user_id   =NULL WHERE user_id   =$1", row["id"])
            await conn.execute("UPDATE game_stats   SET updated_by=NULL WHERE updated_by=$1", row["id"])
            await conn.execute("UPDATE game_results SET updated_by=NULL WHERE updated_by=$1", row["id"])
            await conn.execute("DELETE FROM users WHERE id=$1", row["id"])
            print(f"  removed {email} (their entries are kept, authorship cleared)")
            return 0
    finally:
        await conn.close()
    return 0


if __name__ == "__main__":
    raise SystemExit(asyncio.run(main()))
