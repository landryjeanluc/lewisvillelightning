import type { APIRoute } from "astro";
import { allEvents } from "../../lib/data";
import { calendar, icsHeaders } from "../../lib/ics";

export function getStaticPaths() {
  return allEvents.map((e: any) => ({ params: { id: e.id }, props: { event: e } }));
}

export const GET: APIRoute = ({ props }) => {
  const e = (props as any).event;
  return new Response(calendar([e], "Lewisville Lightning"), {
    headers: icsHeaders(`${e.id}.ics`),
  });
};
