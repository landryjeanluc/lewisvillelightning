"""Self-service account details. Identity and roster ownership stay server-owned."""
import json
import re
from typing import Literal

import asyncpg
import bcrypt
from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel, ConfigDict, Field, field_validator
from starlette.concurrency import run_in_threadpool

from security import rate_limit


class PlayerProfile(BaseModel):
    model_config = ConfigDict(extra="forbid", str_strip_whitespace=True)
    position: Literal["C", "LW", "RW", "F", "D", "G"]
    shoots: Literal["L", "R"] | None = None
    nickname: str | None = Field(None, max_length=100)
    bio: str | None = Field(None, max_length=5000)


class ContactDetails(BaseModel):
    model_config = ConfigDict(extra="forbid")
    display_name: str = Field(min_length=1, max_length=100)
    email: str = Field(min_length=3, max_length=254)
    phone: str | None = Field(None, max_length=40)
    # Do not strip spaces from passwords.
    current_password: str = Field(default="", max_length=72)

    @field_validator("display_name", "email", mode="before")
    @classmethod
    def trim_text(cls, value):
        return value.strip() if isinstance(value, str) else value

    @field_validator("phone")
    @classmethod
    def phone_number(cls, value):
        if not value:
            return None
        if not re.fullmatch(r"[+\d(). xX-]+", value) or not 7 <= len(re.sub(r"\D", "", value)) <= 20:
            raise ValueError("enter a phone number with 7–20 digits")
        return value


def build_router(current_user, db, contract, screen):
    router = APIRouter(prefix="/account")

    def require_user(user):
        if user is None:
            raise HTTPException(401, "sign in to manage your account")
        return user

    def own_player(user):
        require_user(user)
        if user.role not in ("player", "parent") or user.player_id not in contract.players:
            raise HTTPException(403, "your account needs a linked player; ask your coach")
        return user.player_id

    @router.get("")
    async def account(user=Depends(current_user), pool=Depends(db)):
        require_user(user)
        contact = await pool.fetchrow("SELECT display_name,email,phone FROM users WHERE id=$1", user.id)
        pid = user.player_id if user.role in ("player", "parent") else None
        player = contract.players.get(pid)
        profile = None
        assignments = []
        if player:
            stored = await pool.fetchrow("SELECT position,shoots,nickname,bio FROM player_profiles WHERE player_id=$1", pid)
            values = dict(stored) if stored else {}
            profile = {"id": pid, "name": f"{player['firstName']} {player['lastName']}", "number": player["number"],
                       "position": values.get("position") or player["position"],
                       "shoots": values.get("shoots") if stored else player.get("shoots"),
                       "nickname": values.get("nickname"), "bio": values.get("bio")}
            rows = await pool.fetch("""SELECT j.game_id,t.name,j.note,u.display_name AS claimed_by
                FROM game_jobs j JOIN job_types t ON t.id=j.job_type_id
                LEFT JOIN users u ON u.id=j.claimed_by
                WHERE j.player_id=$1 AND t.active ORDER BY t.sort,t.name""", pid)
            assignments = [dict(row) for row in rows if row["game_id"] in contract.games]
        statuses = await pool.fetch("SELECT game_id,status FROM game_results")
        return {"contact": dict(contact), "player": profile, "assignments": assignments,
                "schedule_statuses": {row["game_id"]: row["status"] for row in statuses}}

    @router.put("/profile")
    async def update_profile(body: PlayerProfile, user=Depends(current_user), pool=Depends(db)):
        pid = own_player(user)
        await rate_limit(pool, "account-profile", str(user.id), 20, 60)
        values = body.model_dump()
        values["nickname"] = values["nickname"] or None
        values["bio"] = values["bio"] or None
        screened = [await screen(pool, author_id=user.id, surface=surface, ref_id=pid, body=values[field])
                    for field, surface in (("bio", "bio"), ("nickname", "profile:nickname")) if values[field]]
        if any(item["held"] for item in screened):
            # No part of a rejected save was published, including lower-severity fields.
            await pool.execute("UPDATE flagged_content SET held=true WHERE id=ANY($1::bigint[])",
                               [item["flag_id"] for item in screened if item["flag_id"]])
            raise HTTPException(422, "This profile was held for coach review. Your previous profile is unchanged.")
        async with pool.acquire() as c, c.transaction():
            owner = await c.fetchrow("SELECT role,player_id FROM users WHERE id=$1 FOR UPDATE", user.id)
            if owner["role"] not in ("parent", "player") or owner["player_id"] != pid:
                raise HTTPException(409, "your player link changed; reload before saving")
            await c.execute("""INSERT INTO player_profiles(player_id,position,shoots,nickname,bio,updated_by)
                VALUES($1,$2,$3,$4,$5,$6) ON CONFLICT(player_id) DO UPDATE SET
                position=EXCLUDED.position,shoots=EXCLUDED.shoots,nickname=EXCLUDED.nickname,
                bio=EXCLUDED.bio,updated_by=EXCLUDED.updated_by,updated_at=now()""",
                pid, values["position"], values["shoots"], values["nickname"], values["bio"], user.id)
            await c.execute("INSERT INTO audit_log(user_id,action,payload) VALUES($1,'self_profile_update',$2)",
                            user.id, json.dumps({"player_id": pid}))
        return {"ok": True}

    @router.put("/contact")
    async def update_contact(body: ContactDetails, user=Depends(current_user), pool=Depends(db)):
        require_user(user)
        if user.role == "player":
            raise HTTPException(403, "ask your coach to change player sign-in details")
        await rate_limit(pool, "account-contact", str(user.id), 5, 900)
        email = body.email.lower()
        screened = await screen(pool, author_id=user.id, surface="account:name", ref_id=str(user.id), body=body.display_name)
        if screened["held"]:
            raise HTTPException(422, "This name was held for coach review. Your account is unchanged.")
        try:
            async with pool.acquire() as c, c.transaction():
                row = await c.fetchrow("SELECT email,password_hash FROM users WHERE id=$1 FOR UPDATE", user.id)
                changed = email != row["email"].lower()
                if changed:
                    if not re.fullmatch(r"[^\s@<>]+@[^\s@<>]+\.[^\s@<>]+", email):
                        raise HTTPException(422, "enter a valid email address")
                    if len(body.current_password.encode()) > 72 or not await run_in_threadpool(
                            bcrypt.checkpw, body.current_password.encode(), row["password_hash"].encode()):
                        raise HTTPException(403, "enter your current password to change your email")
                await c.execute("UPDATE users SET display_name=$1,email=$2,phone=$3 WHERE id=$4",
                                body.display_name, email, body.phone, user.id)
                if changed:
                    await c.execute("DELETE FROM password_resets WHERE user_id=$1", user.id)
                await c.execute("INSERT INTO audit_log(user_id,action,payload) VALUES($1,'self_contact_update',$2)",
                                user.id, json.dumps({"email_changed": changed}))
        except HTTPException:
            if screened["flag_id"]:
                await pool.execute("UPDATE flagged_content SET held=true WHERE id=$1", screened["flag_id"])
            raise
        except asyncpg.UniqueViolationError:
            if screened["flag_id"]:
                await pool.execute("UPDATE flagged_content SET held=true WHERE id=$1", screened["flag_id"])
            raise HTTPException(409, "that email address is unavailable") from None
        return {"ok": True}

    return router
