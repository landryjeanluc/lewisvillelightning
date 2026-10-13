"""Private player goals, pooled team goals, and retry-safe activity entries."""
from datetime import date, datetime
from typing import Literal
from uuid import UUID
from zoneinfo import ZoneInfo
import json

from security import DatabaseId

from fastapi import APIRouter, Depends, HTTPException, Response
from pydantic import BaseModel, Field, field_validator, model_validator


def today():
    return datetime.now(ZoneInfo("America/Moncton")).date()


class GoalIn(BaseModel):
    title: str = Field(min_length=1, max_length=100)
    scope: Literal["team", "player"]
    player_id: str | None = None
    unit: Literal["shots", "reps", "minutes", "seconds"]
    target: int = Field(strict=True, ge=1, le=1_000_000)
    starts_on: date
    ends_on: date
    archived: bool = False

    @field_validator("title")
    @classmethod
    def trim(cls, value):
        if not value.strip():
            raise ValueError("Enter a goal title")
        return value.strip()

    @model_validator(mode="after")
    def coherent(self):
        if (self.scope == "team" and self.player_id is not None or
                self.scope == "player" and not self.player_id):
            raise ValueError("Player goals need a player; team goals have no assigned player")
        if self.ends_on < self.starts_on:
            raise ValueError("End date must be on or after start date")
        return self


class EntryIn(BaseModel):
    player_id: str
    amount: int = Field(strict=True, ge=1, le=1_000_000)
    performed_on: date
    client_id: UUID


def build_router(current_user, require_admin, db, contract):
    async def no_store(response: Response):
        response.headers["Cache-Control"] = "no-store"

    router = APIRouter(prefix="/goals", dependencies=[Depends(no_store)])

    async def member(user=Depends(current_user), pool=Depends(db)):
        if user is None:
            raise HTTPException(401, "Sign in to see goals")
        # Read the family link from the database, never from the request body.
        pid = await pool.fetchval("SELECT player_id FROM users WHERE id=$1", user.id)
        return user, pid if user.role in ("parent", "player") else None

    def can_log(user, family, pid):
        return user.role == "admin" or (family is not None and family == pid)

    def visible(goal, user, family):
        return goal["scope"] == "team" or user.role == "admin" or goal["player_id"] == family

    async def audit(c, user, action, payload):
        await c.execute("INSERT INTO audit_log (user_id, action, payload) VALUES ($1,$2,$3)",
                        user.id, action, json.dumps(payload))

    async def get_goal(c, gid, user, family, lock=False):
        row = await c.fetchrow("SELECT * FROM training_goals WHERE id=$1" +
                               (" FOR UPDATE" if lock else ""), gid)
        if row is None or not visible(row, user, family):
            raise HTTPException(404, "No such goal")
        return row

    @router.get("")
    async def board(identity=Depends(member), pool=Depends(db)):
        user, family = identity
        rows = await pool.fetch("""
            SELECT g.*, coalesce(sum(e.amount),0)::bigint AS total,
                   coalesce(sum(e.amount) FILTER (WHERE e.player_id=$2),0)::bigint AS family_total
            FROM training_goals g LEFT JOIN goal_entries e
              ON e.goal_id=g.id AND e.removed_at IS NULL
            WHERE g.scope='team' OR $1 OR g.player_id=$2
            GROUP BY g.id ORDER BY g.starts_on DESC, g.id DESC
        """, user.role == "admin", family)
        players = [{"id": pid, "name": f"{p['firstName']} {p['lastName']}", "number": p["number"]}
                   for pid, p in contract.players.items()
                   if user.role == "admin" or pid == family]
        return {"goals": [dict(r) for r in rows], "players": players,
                "admin": user.role == "admin", "today": today(), "player_id": family}

    @router.post("", status_code=201)
    async def create(body: GoalIn, actor=Depends(require_admin), pool=Depends(db)):
        if body.player_id and body.player_id not in contract.players:
            raise HTTPException(400, "Unknown player")
        async with pool.acquire() as c, c.transaction():
            row = await c.fetchrow("""INSERT INTO training_goals
                (title,scope,player_id,unit,target,starts_on,ends_on,archived,created_by)
                VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9) RETURNING *""",
                body.title, body.scope, body.player_id, body.unit, body.target,
                body.starts_on, body.ends_on, body.archived, actor.id)
            await audit(c, actor, "goal_create", {"id": row["id"]})
        return dict(row)

    @router.put("/{goal_id}")
    async def update(goal_id: DatabaseId, body: GoalIn, actor=Depends(require_admin), pool=Depends(db)):
        if body.player_id and body.player_id not in contract.players:
            raise HTTPException(400, "Unknown player")
        async with pool.acquire() as c, c.transaction():
            old = await get_goal(c, goal_id, actor, None, lock=True)
            # Historical activity cannot silently change units, owner or period.
            if await c.fetchval("SELECT 1 FROM goal_entries WHERE goal_id=$1 LIMIT 1", goal_id):
                if any(old[k] != getattr(body, k) for k in
                       ("scope", "player_id", "unit", "starts_on", "ends_on")):
                    raise HTTPException(409, "This goal has activity. Create a new goal to change its player, unit or dates.")
            row = await c.fetchrow("""UPDATE training_goals SET title=$2,scope=$3,player_id=$4,
                unit=$5,target=$6,starts_on=$7,ends_on=$8,archived=$9,updated_at=now()
                WHERE id=$1 RETURNING *""", goal_id, body.title, body.scope, body.player_id,
                body.unit, body.target, body.starts_on, body.ends_on, body.archived)
            await audit(c, actor, "goal_update", {"id": goal_id, "archived": body.archived})
        return dict(row)

    @router.get("/{goal_id}/entries")
    async def history(goal_id: DatabaseId, identity=Depends(member), pool=Depends(db)):
        user, family = identity
        await get_goal(pool, goal_id, user, family)
        # Families see their own contribution history, not other children's logs.
        rows = await pool.fetch("""SELECT e.id,e.player_id,e.amount,e.performed_on,e.created_at,
                coalesce(u.display_name, 'Former member') AS recorded_by FROM goal_entries e LEFT JOIN users u ON u.id=e.created_by
                WHERE e.goal_id=$1 AND e.removed_at IS NULL AND ($2 OR e.player_id=$3)
                ORDER BY e.id DESC LIMIT 100""", goal_id, user.role == "admin", family)
        return [dict(r) for r in rows]

    @router.post("/{goal_id}/entries", status_code=201)
    async def add_entry(goal_id: DatabaseId, body: EntryIn, identity=Depends(member), pool=Depends(db)):
        user, family = identity
        if not can_log(user, family, body.player_id):
            raise HTTPException(403, "You can only record activity for your linked player")
        if body.player_id not in contract.players:
            raise HTTPException(400, "Unknown player")
        async with pool.acquire() as c, c.transaction():
            # Serialize writes to a goal with updates/archiving and retry requests.
            goal = await get_goal(c, goal_id, user, family, lock=True)
            if goal["scope"] == "player" and goal["player_id"] != body.player_id:
                raise HTTPException(403, "This goal belongs to a different player")
            existing = await c.fetchrow("SELECT * FROM goal_entries WHERE created_by=$1 AND client_id=$2",
                                        user.id, body.client_id)
            if existing:
                if any(existing[k] != v for k, v in {"goal_id": goal_id, "player_id": body.player_id,
                        "amount": body.amount, "performed_on": body.performed_on}.items()):
                    raise HTTPException(409, "This activity request was already used")
                return {"id": existing["id"], "replayed": True, "removed": existing["removed_at"] is not None}
            if goal["archived"]:
                raise HTTPException(409, "This goal is archived")
            if not goal["starts_on"] <= body.performed_on <= goal["ends_on"] or body.performed_on > today():
                raise HTTPException(400, "Activity date must be within the goal dates and cannot be in the future")
            # ON CONFLICT also handles the same key arriving for two different goals.
            eid = await c.fetchval("""INSERT INTO goal_entries
                (goal_id,player_id,amount,performed_on,created_by,client_id) VALUES ($1,$2,$3,$4,$5,$6)
                ON CONFLICT (created_by,client_id) DO NOTHING RETURNING id""",
                goal_id, body.player_id, body.amount, body.performed_on, user.id, body.client_id)
            if eid is None:
                raise HTTPException(409, "This activity request was already used")
            await audit(c, user, "goal_progress", {"goal_id": goal_id, "entry_id": eid})
        return {"id": eid, "replayed": False}

    @router.delete("/{goal_id}/entries/{entry_id}")
    async def remove_entry(goal_id: DatabaseId, entry_id: DatabaseId, identity=Depends(member), pool=Depends(db)):
        user, family = identity
        async with pool.acquire() as c, c.transaction():
            await get_goal(c, goal_id, user, family, lock=True)
            entry = await c.fetchrow("SELECT * FROM goal_entries WHERE id=$1 AND goal_id=$2", entry_id, goal_id)
            if entry is None:
                raise HTTPException(404, "No such activity")
            if not can_log(user, family, entry["player_id"]):
                raise HTTPException(403, "You can only correct your linked player's activity")
            if entry["removed_at"] is None:
                await c.execute("UPDATE goal_entries SET removed_at=now(),removed_by=$2 WHERE id=$1", entry_id, user.id)
                await audit(c, user, "goal_progress_remove", {"goal_id": goal_id, "entry_id": entry_id})
        return {"ok": True}

    return router
