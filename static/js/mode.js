// The studio's mode: Practice (the default) or Advanced, whose id is "daw"
// (in storage, the <html> class and code). Streaming and Karaoke are listed in
// the Mode menu as coming, and cannot be chosen yet.
//
// - Practice is the simple practice studio: stems, the mixer's M, S and key,
//   transport, speed, key, click and loop. No Record, no adding tracks, no EQ
//   and no master. A song's EQ and master are not deleted: they are bypassed,
//   live and in exports, and come back as they were in DAW mode. Hidden but
//   still sounding would make an export differ from what the screen shows.
// - DAW is everything: recording tracks, take folders, EQ panels, the
//   master, suggestions and video.
//
// Remembered per browser (localStorage), as a convenience. The phone UI
// (static/mobile/) has its own page and is not affected.
//
// The choice is written to <html> as the class mode-practice or mode-daw,
// which is what daw.css hides the DAW controls by. They are hidden unless
// mode-daw is set, so a page in Practice never flashes them while loading.

const KEY = "stemdeck.mode";
export const MODES = Object.freeze(["practice", "daw", "streaming", "karaoke"]);
// The modes that can be chosen now; the others are placeholders.
export const AVAILABLE = Object.freeze(["practice", "daw"]);
const DEFAULT = "practice";

const listeners = new Set();
let mode = read();

function read() {
  try {
    const v = localStorage.getItem(KEY);
    return AVAILABLE.includes(v) ? v : DEFAULT;
  } catch (e) {
    console.warn("[mode] reading the mode failed:", e);
    return DEFAULT;
  }
}

function applyClass() {
  const root = document.documentElement;
  root.classList.toggle("mode-practice", mode === "practice");
  root.classList.toggle("mode-daw", mode === "daw");
  root.dataset.mode = mode;
}

export function getMode() { return mode; }
export function isPractice() { return mode === "practice"; }

/** Switch mode. Returns the mode in force afterwards. */
export function setMode(next) {
  if (!AVAILABLE.includes(next) || next === mode) return mode;
  mode = next;
  try {
    localStorage.setItem(KEY, mode);
  } catch (e) {
    console.warn("[mode] saving the mode failed:", e);
  }
  applyClass();
  for (const cb of listeners) {
    try { cb(mode); } catch (err) { console.warn("[mode] change listener failed:", err); }
  }
  return mode;
}

export function onModeChange(cb) {
  listeners.add(cb);
  return () => listeners.delete(cb);
}

applyClass();
