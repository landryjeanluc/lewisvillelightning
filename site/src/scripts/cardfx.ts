export {};
/**
 * Trading-card tilt. Cards follow the pointer in 3D with a holographic sheen,
 * and on a phone they follow the gyroscope so tipping the handset makes the
 * foil move — which is the bit that actually lands with a twelve-year-old.
 *
 * Opt-out under prefers-reduced-motion, and all style writes go through one
 * rAF so a roster of nineteen cards stays smooth.
 */
const MAX_TILT = 11;                       // degrees; past this it reads as broken
const reduce = matchMedia("(prefers-reduced-motion: reduce)").matches;

type Pending = { el: HTMLElement; mx: number; my: number; rx: number; ry: number };
let queued: Pending[] = [];
let frame = 0;

function flush() {
  frame = 0;
  for (const { el, mx, my, rx, ry } of queued) {
    el.style.setProperty("--mx", mx.toFixed(1));
    el.style.setProperty("--my", my.toFixed(1));
    el.style.setProperty("--rx", `${rx.toFixed(2)}deg`);
    el.style.setProperty("--ry", `${ry.toFixed(2)}deg`);
  }
  queued = [];
}
function write(p: Pending) {
  queued = queued.filter((q) => q.el !== p.el);
  queued.push(p);
  if (!frame) frame = requestAnimationFrame(flush);
}

function attach(card: HTMLElement) {
  const move = (clientX: number, clientY: number) => {
    const r = card.getBoundingClientRect();
    const px = (clientX - r.left) / r.width;
    const py = (clientY - r.top) / r.height;
    write({
      el: card,
      mx: px * 100,
      my: py * 100,
      // pointer right -> card turns right; pointer down -> card tips back
      ry: (px - 0.5) * 2 * MAX_TILT,
      rx: -(py - 0.5) * 2 * MAX_TILT,
    });
  };

  const start = () => card.classList.add("is-tilting");
  const stop = () => {
    card.classList.remove("is-tilting");
    write({ el: card, mx: 50, my: 50, rx: 0, ry: 0 });
  };

  card.addEventListener("pointerenter", start);
  card.addEventListener("pointermove", (e) => move(e.clientX, e.clientY));
  card.addEventListener("pointerleave", stop);
  // a tap should flash the foil even though touch has no hover
  card.addEventListener("pointerdown", (e) => { start(); move(e.clientX, e.clientY); });
  card.addEventListener("pointercancel", stop);
}

function initTilt() {
  if (reduce) return;
  document.querySelectorAll<HTMLElement>(".pcard").forEach(attach);
}

/**
 * Gyroscope on phones: the whole roster leans together as the handset tips.
 * iOS requires an explicit grant, so it is offered on first touch rather than
 * demanded on load.
 */
function initGyro() {
  if (reduce || !window.DeviceOrientationEvent) return;
  const cards = () => document.querySelectorAll<HTMLElement>(".pcard");
  let base: { b: number; g: number } | null = null;

  const handle = (e: DeviceOrientationEvent) => {
    if (e.beta === null || e.gamma === null) return;
    if (!base) base = { b: e.beta, g: e.gamma };   // wherever they were holding it
    const dy = Math.max(-1, Math.min(1, (e.beta - base.b) / 30));
    const dx = Math.max(-1, Math.min(1, (e.gamma - base.g) / 30));
    cards().forEach((el) => {
      el.classList.add("is-tilting");
      write({ el, mx: 50 + dx * 50, my: 50 + dy * 50, rx: -dy * MAX_TILT, ry: dx * MAX_TILT });
    });
  };

  const anyWin = window as any;
  if (typeof anyWin.DeviceOrientationEvent?.requestPermission === "function") {
    const ask = async () => {
      document.removeEventListener("touchend", ask);
      try {
        if ((await anyWin.DeviceOrientationEvent.requestPermission()) === "granted")
          window.addEventListener("deviceorientation", handle);
      } catch { /* denied — pointer tilt still works */ }
    };
    document.addEventListener("touchend", ask, { once: true });
  } else {
    window.addEventListener("deviceorientation", handle);
  }
}

initTilt();
initGyro();
