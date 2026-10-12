import type { APIRoute } from "astro";
import { allEvents } from "../lib/data";
import { calendar, icsHeaders } from "../lib/ics";

/** Every game and practice in one file — "add the whole season". */
export const GET: APIRoute = () =>
  new Response(calendar(allEvents as any, "Lewisville Lightning 2026–27"), {
    headers: icsHeaders("lewisville-lightning-season.ics"),
  });
