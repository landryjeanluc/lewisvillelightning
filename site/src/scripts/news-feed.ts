import { md } from "./live";
import { shortDate } from "../lib/format";

type Post = {
  slug: string; title: string; summary: string | null; body: string;
  image: string | null; status: string; published_at: string;
};

async function loadFeed(feed: HTMLElement) {
  const list = feed.querySelector<HTMLElement>("[data-news-list]")!;
  const empty = feed.querySelector<HTMLElement>("[data-news-empty]")!;
  const template = feed.querySelector<HTMLTemplateElement>("[data-news-template]")!;
  const limit = Number(feed.dataset.limit) || Infinity;
  try {
    const response = await fetch("/api/news", { credentials: "same-origin", cache: "no-store", signal: AbortSignal.timeout(10000) });
    if (!response.ok) throw new Error("News unavailable");
    const posts: Post[] = await response.json();
    if (!Array.isArray(posts)) throw new Error("Invalid news response");
    const cards = new Map(Array.from(list.children, node => [(node as HTMLElement).dataset.slug!, node as HTMLElement]));
    for (const post of posts) {
      if (post.status !== "published" || !post.slug || !post.title || !Number.isFinite(Date.parse(post.published_at))) continue;
      const card = template.content.firstElementChild!.cloneNode(true) as HTMLElement;
      card.id = `post-${post.slug}`;
      card.dataset.slug = post.slug;
      card.dataset.published = post.published_at;
      const date = card.querySelector("time")!;
      date.dateTime = post.published_at;
      date.textContent = shortDate(post.published_at);
      const heading = card.querySelector("h2, h3")!;
      (heading.querySelector("a") || heading).textContent = post.title;
      for (const link of card.querySelectorAll<HTMLAnchorElement>("h3 a, .feed-link")) {
        link.href = `/news#${encodeURIComponent(card.id)}`;
      }
      if (post.summary) {
        const summary = card.querySelector<HTMLElement>("[data-summary]")!;
        summary.textContent = post.summary;
        summary.hidden = false;
      }
      if (post.image) {
        // Uploaded images and imported assets are served from this origin.
        const path = "/" + post.image.replace(/^\/?assets\//, "").replace(/^\/+/, "");
        const url = new URL(path, location.origin);
        if (url.origin === location.origin) {
          const image = card.querySelector("img")!;
          image.src = url.href;
          image.hidden = false;
          image.addEventListener("error", () => { image.hidden = true; }, { once: true });
        }
      }
      const body = card.querySelector<HTMLElement>(".feed-body");
      if (body) body.innerHTML = md(post.body || "");
      cards.set(post.slug, card);
    }
    const sorted = [...cards.values()].sort((a, b) => Date.parse(b.dataset.published!) - Date.parse(a.dataset.published!));
    list.replaceChildren(...sorted.slice(0, limit));
    empty.hidden = list.childElementCount > 0;
    if (location.hash && limit === Infinity) {
      const target = document.getElementById(decodeURIComponent(location.hash.slice(1)));
      if (target && list.contains(target)) target.scrollIntoView({ block: "start" });
    }
  } catch {
    if (!list.childElementCount) {
      empty.textContent = "News couldn't load right now. Please try again shortly.";
      empty.hidden = false;
    }
  }
}

document.querySelectorAll<HTMLElement>("[data-news-feed]").forEach(feed => void loadFeed(feed));
