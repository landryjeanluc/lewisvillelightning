// The roster stays server-rendered; this controller only chooses the scene.
// User interaction stops the tour until Play is explicitly selected again.
document.querySelectorAll<HTMLElement>("[data-showcase]").forEach((root) => {
  const scenes = Array.from(root.querySelectorAll<HTMLElement>("[data-scene]"));
  const picks = Array.from(root.querySelectorAll<HTMLButtonElement>("[data-pick]"));
  const controls = root.querySelector<HTMLElement>("[data-controls]")!;
  const stage = root.querySelector<HTMLElement>(".showcase-stage")!;
  const play = root.querySelector<HTMLButtonElement>("[data-play]")!;
  const icon = root.querySelector<HTMLElement>("[data-play-icon]")!;
  const progress = root.querySelector<HTMLElement>("[data-progress]")!;
  const count = root.querySelector<HTMLElement>("[data-count]")!;
  const announcement = root.querySelector<HTMLElement>("[data-announcement]")!;
  const reducedMotion = window.matchMedia("(prefers-reduced-motion: reduce)");
  const duration = 6500;
  let current = 0;
  let playing = !reducedMotion.matches;
  let visible = false;
  let timer: ReturnType<typeof setTimeout> | undefined;

  function schedule() {
    clearTimeout(timer);
    root.classList.remove("is-running");
    // Restart the CSS progress bar together with the scene timer.
    void progress.offsetWidth;
    const running = playing && visible && !document.hidden;
    root.classList.toggle("is-running", running);
    play.setAttribute("aria-label", playing ? "Pause automatic player rotation" : "Play automatic player rotation");
    icon.textContent = playing ? "Ⅱ" : "▶";
    if (running) timer = setTimeout(() => select(current + 1), duration);
  }

  function stop() {
    playing = false;
    schedule();
  }

  function select(index: number, manual = false) {
    if (manual) playing = false;
    const next = (index + scenes.length) % scenes.length;
    // Don't leave keyboard focus inside a scene that is about to be hidden.
    if (scenes[current].contains(document.activeElement)) stage.focus({ preventScroll: true });
    scenes[current].hidden = true;
    picks[current].setAttribute("aria-pressed", "false");
    current = next;
    scenes[current].hidden = false;
    picks[current].setAttribute("aria-pressed", "true");
    count.textContent = String(current + 1).padStart(2, "0");
    if (manual) announcement.textContent = scenes[current].dataset.label ?? "";
    // Scroll only the number strip, never the page, when a player changes.
    const strip = picks[current].parentElement!;
    const button = picks[current];
    strip.scrollTo({ left: button.offsetLeft - strip.clientWidth / 2 + button.clientWidth / 2, behavior: reducedMotion.matches ? "instant" : "smooth" });
    // Decode the following player's image before their turn without eagerly
    // downloading all nineteen full-sized cards on initial page load.
    const nextImage = scenes[(current + 1) % scenes.length].querySelector<HTMLImageElement>(".showcase-card img");
    if (nextImage) nextImage.loading = "eager";
    schedule();
  }

  picks.forEach((button, index) => button.addEventListener("click", () => select(index, true)));
  root.querySelector("[data-prev]")!.addEventListener("click", () => select(current - 1, true));
  root.querySelector("[data-next]")!.addEventListener("click", () => select(current + 1, true));
  play.addEventListener("click", () => { playing = !playing; schedule(); });

  // Focus and mouse hover pause persistently, so content never moves out from
  // under someone reading, using a link, or navigating with their keyboard.
  root.addEventListener("focusin", (event) => { if (event.target !== play) stop(); });
  stage.addEventListener("pointerenter", (event) => { if (event.pointerType === "mouse") stop(); });
  controls.addEventListener("keydown", (event) => {
    const target = event.target as HTMLElement;
    if (!target.matches("[data-pick]")) return;
    const index = picks.indexOf(target as HTMLButtonElement);
    const next = event.key === "ArrowRight" ? (index + 1) % picks.length
      : event.key === "ArrowLeft" ? (index + picks.length - 1) % picks.length
      : event.key === "Home" ? 0 : event.key === "End" ? picks.length - 1 : -1;
    if (next < 0) return;
    event.preventDefault();
    picks[next].focus({ preventScroll: true });
    select(next, true);
  });

  let touchStart: { x: number; y: number } | undefined;
  stage.addEventListener("pointerdown", (event) => {
    if (event.pointerType !== "touch") return;
    touchStart = { x: event.clientX, y: event.clientY };
    stop();
  });
  stage.addEventListener("pointercancel", () => { touchStart = undefined; });
  let swiped = false;
  stage.addEventListener("pointerup", (event) => {
    if (!touchStart) return;
    const dx = event.clientX - touchStart.x;
    const dy = event.clientY - touchStart.y;
    touchStart = undefined;
    if (Math.abs(dx) > 45 && Math.abs(dx) > Math.abs(dy) * 1.3) {
      swiped = true;
      select(current + (dx < 0 ? 1 : -1), true);
      setTimeout(() => { swiped = false; }, 0);
    }
  });
  stage.addEventListener("click", (event) => { if (swiped) event.preventDefault(); }, true);

  root.querySelectorAll<HTMLElement>(".showcase-card").forEach((card) => {
    card.addEventListener("pointermove", (event) => {
      if (event.pointerType !== "mouse" || reducedMotion.matches) return;
      const bounds = card.getBoundingClientRect();
      const x = Math.max(0, Math.min(1, (event.clientX - bounds.left) / bounds.width));
      const y = Math.max(0, Math.min(1, (event.clientY - bounds.top) / bounds.height));
      card.style.setProperty("--tilt-x", `${(0.5 - y) * 10}deg`);
      card.style.setProperty("--tilt-y", `${(x - 0.5) * 10}deg`);
      card.style.setProperty("--glare-x", `${x * 100}%`);
      card.style.setProperty("--glare-y", `${y * 100}%`);
      card.classList.add("is-tilting");
    });
    card.addEventListener("pointerleave", () => {
      card.classList.remove("is-tilting");
      card.style.removeProperty("--tilt-x");
      card.style.removeProperty("--tilt-y");
    });
  });

  document.addEventListener("visibilitychange", schedule);
  reducedMotion.addEventListener("change", () => { if (reducedMotion.matches) stop(); });
  const observer = new IntersectionObserver(([entry]) => {
    visible = entry.isIntersecting;
    if (visible) {
      const nextImage = scenes[(current + 1) % scenes.length].querySelector<HTMLImageElement>(".showcase-card img");
      if (nextImage) nextImage.loading = "eager";
    }
    schedule();
  }, { threshold: .15 });
  observer.observe(root);
  controls.hidden = false;
  root.classList.add("is-enhanced");
  schedule();
});
