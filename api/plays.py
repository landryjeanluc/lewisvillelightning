"""
The coach's whiteboard: plays of the week.

A play is one versioned *diagram document* plus a little metadata. The document
describes where the pieces start, the paths they run, and which numbered step
each movement belongs to; the website replays it on an SVG rink.

Two rules shape everything here:

- **A diagram is saved whole.** It is drawn as one picture and edited as one
  picture. There is no "patch token 7" — the editor PUTs the document it has.
- **The document is validated, not trusted.** It arrives as JSON from a browser
  and lands in JSONB, so every coordinate is bounds-checked against the rink and
  every collection is capped. A play that cannot be drawn cannot be stored.

Coordinates are in **feet on a standard 200 × 85 sheet**, origin at the top-left
corner of the left-end boards. Real units mean the rink furniture (blue lines at
75 and 125, dots 20 ft off the goal line) sits where a coach expects it, and a
diagram drawn on the full sheet still reads correctly when cropped to one zone.
"""
from __future__ import annotations

import json
from datetime import date
from typing import Annotated, Literal

from security import DatabaseId

from fastapi import APIRouter, Depends, HTTPException, Response, status
from pydantic import BaseModel, Field, field_validator, model_validator

RINK_LENGTH = 200.0
RINK_WIDTH = 85.0

# Caps. A U13 play is a dozen pieces and four steps; these are ten times that,
# which is generous for a coach and still far too small to be a payload attack.
MAX_STEPS = 12
MAX_TOKENS = 40
MAX_PATHS = 60
MAX_NOTES = 24
MAX_PEN = 40
MAX_POINTS = 240          # per path, after the editor's simplification pass

Surface = Literal["full", "ozone", "nzone", "dzone"]
Category = Literal["breakout", "forecheck", "powerplay", "penaltykill",
                   "faceoff", "neutralzone", "dzone", "drill", "other"]


# allow_inf_nan=False everywhere a coordinate is declared: a browser that has
# lost its transform produces NaN, NaN compares false against every bound, and
# an unbounded coordinate would otherwise be stored as a piece nobody can see.
class Point(BaseModel):
    x: float = Field(ge=0, le=RINK_LENGTH, allow_inf_nan=False)
    y: float = Field(ge=0, le=RINK_WIDTH, allow_inf_nan=False)


class Step(BaseModel):
    """One beat of the play. The caption is what the kids actually read."""
    id: str = Field(min_length=1, max_length=40)
    caption: str = Field(default="", max_length=200)
    duration: int = Field(default=1400, ge=200, le=10_000)   # ms

    @field_validator("caption")
    @classmethod
    def _trim(cls, v: str) -> str:
        return v.strip()


class Token(BaseModel):
    """A piece on the ice: one of ours, one of theirs, the puck, a cone, a net."""
    id: str = Field(min_length=1, max_length=40)
    kind: Literal["us", "them", "puck", "cone", "goalie", "goalieThem"]
    x: float = Field(ge=0, le=RINK_LENGTH, allow_inf_nan=False)
    y: float = Field(ge=0, le=RINK_WIDTH, allow_inf_nan=False)
    label: str = Field(default="", max_length=4)
    # Optional binding to a real roster id, so the coach can say "this is you".
    playerId: str | None = None

    @field_validator("label")
    @classmethod
    def _trim(cls, v: str) -> str:
        return v.strip()


class Path(BaseModel):
    """A line in standard hockey notation.

    `tokenId` is what turns a drawing into an animation: a bound path carries
    that piece along it during its step. An unbound path is just an arrow —
    useful for showing pressure or a rim the coach does not want to animate.
    """
    id: str = Field(min_length=1, max_length=40)
    kind: Literal["skate", "pass", "shot", "backward"]
    step: int = Field(ge=0, lt=MAX_STEPS)
    tokenId: str | None = None
    points: list[Point] = Field(min_length=2, max_length=MAX_POINTS)


class Note(BaseModel):
    id: str = Field(min_length=1, max_length=40)
    step: int = Field(ge=0, lt=MAX_STEPS)
    x: float = Field(ge=0, le=RINK_LENGTH, allow_inf_nan=False)
    y: float = Field(ge=0, le=RINK_WIDTH, allow_inf_nan=False)
    text: str = Field(min_length=1, max_length=80)

    @field_validator("text")
    @classmethod
    def _trim(cls, v: str) -> str:
        v = v.strip()
        if not v:
            raise ValueError("an empty label is not a label")
        return v


class Pen(BaseModel):
    """Freehand scribble — a circled area, a squiggle, whatever he draws."""
    id: str = Field(min_length=1, max_length=40)
    step: int = Field(ge=0, lt=MAX_STEPS)
    points: list[Point] = Field(min_length=2, max_length=MAX_POINTS)


class Diagram(BaseModel):
    v: Literal[1] = 1
    steps: list[Step] = Field(default_factory=list, max_length=MAX_STEPS)
    tokens: list[Token] = Field(default_factory=list, max_length=MAX_TOKENS)
    paths: list[Path] = Field(default_factory=list, max_length=MAX_PATHS)
    notes: list[Note] = Field(default_factory=list, max_length=MAX_NOTES)
    pen: list[Pen] = Field(default_factory=list, max_length=MAX_PEN)

    @model_validator(mode="after")
    def _coherent(self) -> "Diagram":
        """Ids unique, references resolvable, steps in range.

        A dangling tokenId or an out-of-range step would not crash the player —
        it would silently drop the movement, and the coach would be left
        wondering why his winger never leaves the wall. Reject it here instead.
        """
        ids: set[str] = set()
        for group in (self.steps, self.tokens, self.paths, self.notes, self.pen):
            for item in group:
                if item.id in ids:
                    raise ValueError(f"duplicate id {item.id!r} in the diagram")
                ids.add(item.id)

        token_ids = {t.id for t in self.tokens}
        n_steps = len(self.steps)
        for p in self.paths:
            if p.tokenId is not None and p.tokenId not in token_ids:
                raise ValueError(f"path {p.id} is bound to a piece that is not on the ice")
        for item in (*self.paths, *self.notes, *self.pen):
            if item.step >= max(n_steps, 1):
                raise ValueError(f"{item.id} belongs to step {item.step + 1}, "
                                 f"but the play only has {n_steps}")

        # One token may not run two paths in the same step: it cannot be in two
        # places at once, and the player would have to pick one arbitrarily.
        seen: set[tuple[str, int]] = set()
        for p in self.paths:
            if p.tokenId is None:
                continue
            if (p.tokenId, p.step) in seen:
                raise ValueError(f"a piece has two paths in step {p.step + 1}")
            seen.add((p.tokenId, p.step))
        return self


class PlayIn(BaseModel):
    title: str = Field(min_length=1, max_length=120)
    subtitle: str | None = Field(default=None, max_length=200)
    category: Category = "other"
    surface: Surface = "full"
    status: Literal["draft", "published"] = "draft"
    # A real date, not a string: asyncpg binds a DATE column by type, and a
    # bare "2026-10-12" is refused at the protocol level rather than coerced.
    week_of: date | None = None                  # null means evergreen
    game_id: str | None = None
    diagram: Diagram = Field(default_factory=Diagram)

    @field_validator("title", "subtitle")
    @classmethod
    def _trim(cls, v: str | None) -> str | None:
        if v is None:
            return None
        v = v.strip()
        return v or None

    @field_validator("title")
    @classmethod
    def _needs_title(cls, v: str | None) -> str:
        if not v:
            raise ValueError("a play needs a name")
        return v


COLUMNS = """p.id, p.slug, p.title, p.subtitle, p.category, p.surface, p.diagram,
             p.status, p.week_of, p.game_id, p.published_at, p.updated_at,
             u.display_name AS author"""


def _row(r) -> dict:
    d = dict(r)
    # asyncpg hands JSONB back as text unless a codec is registered; the rest of
    # this service never needed one, so decode here rather than at pool setup.
    if isinstance(d.get("diagram"), str):
        d["diagram"] = json.loads(d["diagram"])
    if d.get("week_of") is not None:
        d["week_of"] = d["week_of"].isoformat()
    return d


def plays_router(current_user, require_admin, db, slugify, contract):
    """Built as a factory for the same reason chat is: app.py owns the
    dependencies, and importing them back would close the circle."""

    async def reader(response: Response, user=Depends(current_user)):
        # Systems are the one thing on this site worth gating properly: a
        # scoresheet is public record, a breakout is not. Signed-in only.
        response.headers["Cache-Control"] = "no-store"
        if user is None:
            raise HTTPException(status.HTTP_401_UNAUTHORIZED, "sign in to see the plays")
        return user

    router = APIRouter(prefix="/plays", tags=["plays"])

    def _check_game(game_id: str | None) -> None:
        if game_id and game_id not in contract.games:
            raise HTTPException(status.HTTP_404_NOT_FOUND, f"unknown game {game_id}")

    @router.get("")
    async def list_plays(user=Depends(reader), pool=Depends(db)):
        """Everything the caller may see, newest week first.

        Diagrams come down with the list on purpose: the index draws a real
        miniature of each play rather than a grey placeholder, and the whole
        season's worth of documents is a few tens of kilobytes.
        """
        admin = user.role == "admin"
        rows = await pool.fetch(
            f"""SELECT {COLUMNS} FROM plays p LEFT JOIN users u ON u.id = p.author_id
                 WHERE $1 OR p.status = 'published'
                 ORDER BY p.week_of DESC NULLS LAST,
                          coalesce(p.published_at, p.updated_at) DESC""",
            admin)
        return [_row(r) for r in rows]

    @router.get("/{slug}")
    async def get_play(slug: str, user=Depends(reader), pool=Depends(db)):
        row = await pool.fetchrow(
            f"SELECT {COLUMNS} FROM plays p LEFT JOIN users u ON u.id = p.author_id"
            " WHERE p.slug = $1", slug)
        if row is None or (row["status"] != "published" and user.role != "admin"):
            raise HTTPException(status.HTTP_404_NOT_FOUND, "no such play")
        return _row(row)

    @router.post("", status_code=status.HTTP_201_CREATED)
    async def create_play(body: PlayIn, actor=Depends(require_admin), pool=Depends(db)):
        _check_game(body.game_id)
        base = slugify(body.title) or "play"
        async with pool.acquire() as c, c.transaction():
            await c.execute("SELECT pg_advisory_xact_lock(71004)")
            slug, n = base, 1
            while await c.fetchval("SELECT 1 FROM plays WHERE slug = $1", slug):
                n += 1
                slug = f"{base}-{n}"
            row = await c.fetchrow(
                """INSERT INTO plays (slug, title, subtitle, category, surface, diagram,
                                      status, week_of, game_id, published_at, author_id)
                   VALUES ($1,$2,$3,$4,$5,$6::jsonb,$7,$8,$9,
                           CASE WHEN $7 = 'published' THEN now() END, $10)
                   RETURNING id, slug, title, status""",
                slug, body.title, body.subtitle, body.category, body.surface,
                body.diagram.model_dump_json(), body.status, body.week_of,
                body.game_id, actor.id)
            await c.execute(
                "INSERT INTO audit_log (user_id, action, game_id, payload)"
                " VALUES ($1,'play_create',$2,$3)",
                actor.id, body.game_id,
                json.dumps({"slug": slug, "status": body.status}))
        return dict(row)

    @router.put("/{play_id}")
    async def update_play(play_id: DatabaseId, body: PlayIn,
                          actor=Depends(require_admin), pool=Depends(db)):
        _check_game(body.game_id)
        async with pool.acquire() as c, c.transaction():
            row = await c.fetchrow(
                """UPDATE plays SET
                     title = $2, subtitle = $3, category = $4, surface = $5,
                     diagram = $6::jsonb, status = $7, week_of = $8, game_id = $9,
                     -- first publication stamps the date; re-saving a published
                     -- play must not keep bumping it to the top of the list
                     published_at = CASE WHEN $7 = 'published'
                                         THEN coalesce(published_at, now()) END,
                     author_id = $10, updated_at = now()
                   WHERE id = $1
                   RETURNING id, slug, title, status""",
                play_id, body.title, body.subtitle, body.category, body.surface,
                body.diagram.model_dump_json(), body.status, body.week_of,
                body.game_id, actor.id)
            if row is None:
                raise HTTPException(status.HTTP_404_NOT_FOUND, "no such play")
            await c.execute(
                "INSERT INTO audit_log (user_id, action, game_id, payload)"
                " VALUES ($1,'play_update',$2,$3)",
                actor.id, body.game_id,
                json.dumps({"id": play_id, "status": body.status,
                            "pieces": len(body.diagram.tokens),
                            "steps": len(body.diagram.steps)}))
        return dict(row)

    @router.delete("/{play_id}")
    async def delete_play(play_id: DatabaseId, actor=Depends(require_admin), pool=Depends(db)):
        async with pool.acquire() as c, c.transaction():
            slug = await c.fetchval("DELETE FROM plays WHERE id = $1 RETURNING slug", play_id)
            if slug is None:
                raise HTTPException(status.HTTP_404_NOT_FOUND, "no such play")
            await c.execute(
                "INSERT INTO audit_log (user_id, action, payload) VALUES ($1,'play_delete',$2)",
                actor.id, json.dumps({"slug": slug}))
        return {"ok": True, "slug": slug}

    return router
