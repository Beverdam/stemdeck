// Streamer Mode's arithmetic, kept apart from the page so it can be tested in
// Node: the scene (its layers, their frames and the aspect), where a scene is
// kept per song, reading and writing it, and the small sums the preview and
// the take timeline draw from (lyric lines in view, waveform bars, ruler
// ticks, clock text). Nothing here holds state or touches the DOM.
//
// A scene is plain JSON:
//   { v, aspect, layers: [{ id, type, visible, frame: { x, y, w, h }, props }] }
// Array order is the drawing order: the first layer is at the back, the last
// in front. A frame is in FRACTIONS (0..1) of the output frame, so the small
// preview and a 1920 x 1080 output are the same picture at two sizes.

import { currentLineIndex } from "../lyricsLookup.js";

export const SCENE_VERSION = 1;
export const ASPECTS = Object.freeze(["16:9", "9:16", "1:1"]);
export const DEFAULT_ASPECT = "16:9";
export const LAYER_TYPES = Object.freeze(["background", "camera", "lowerThird", "lyrics", "title", "waveform", "albumArt"]);

/** The saved scene of a song: one record per song (maintainer's decision),
 * a song without one starts from the default scene. */
export const sceneKey = (jobId) => `stemdeck:streamer:scene:${jobId}`;

// ── Aspect ──

/** Width over height of `aspect`; the default's for anything unknown. */
export function aspectRatio(aspect) {
  const [w, h] = String(ASPECTS.includes(aspect) ? aspect : DEFAULT_ASPECT).split(":").map(Number);
  return w / h;
}

/** The output size in pixels: the short side is `short` (1080 for 1080p). */
export function outputSize(aspect, short = 1080) {
  const r = aspectRatio(aspect);
  return r >= 1 ? { width: Math.round(short * r), height: short } : { width: short, height: Math.round(short / r) };
}

/** The `aspect` frame centred in a `boxW` x `boxH` box, as large as fits
 * (pillarboxed or letterboxed): { x, y, w, h } in the box's pixels. */
export function fitAspect(boxW, boxH, aspect) {
  const r = aspectRatio(aspect);
  let w = boxW;
  let h = w / r;
  if (h > boxH) {
    h = boxH;
    w = h * r;
  }
  return { x: (boxW - w) / 2, y: (boxH - h) / 2, w, h };
}

// ── Default scene ──

// The default frames per aspect, in pixels of a preview of that aspect with
// a 403 px short side. 16:9 is the design's preview (716 x 403: overlays in
// the right column, lower third bottom left); portrait and square keep the
// same overlays at the same size, the portrait title card below the REC
// badge.
const px = (x, y, w, h, W, H) => ({ x: x / W, y: y / H, w: w / W, h: h / H });
const FULL = { x: 0, y: 0, w: 1, h: 1 };
const DEFAULT_FRAMES = {
  "16:9": {
    background: FULL,
    camera: FULL,
    title: px(472, 8, 238, 108, 716, 403),
    albumArt: px(482, 18, 88, 88, 716, 403),
    waveform: px(582, 74, 118, 28, 716, 403),
    lyrics: px(494, 263, 216, 134, 716, 403),
    lowerThird: px(12, 351, 120, 40, 716, 403),
  },
  "9:16": {
    background: FULL,
    camera: FULL,
    title: px(16, 76, 371, 108, 403, 716),
    albumArt: px(26, 86, 88, 88, 403, 716),
    waveform: px(126, 142, 160, 28, 403, 716),
    lyrics: px(16, 470, 371, 150, 403, 716),
    lowerThird: px(16, 640, 160, 40, 403, 716),
  },
  "1:1": {
    background: FULL,
    camera: FULL,
    title: px(237, 8, 238, 108, 483, 483),
    albumArt: px(247, 18, 88, 88, 483, 483),
    waveform: px(347, 74, 118, 28, 483, 483),
    lyrics: px(259, 335, 216, 134, 483, 483),
    lowerThird: px(12, 431, 120, 40, 483, 483),
  },
};

// Back to front, and which are shown at first (the design: everything but
// the background image).
const DEFAULT_LAYERS = [
  { type: "background", visible: false },
  { type: "camera", visible: true },
  { type: "lowerThird", visible: true },
  { type: "lyrics", visible: true },
  { type: "title", visible: true },
  { type: "waveform", visible: true },
  { type: "albumArt", visible: true },
];

const DEFAULT_PROPS = {
  background: () => ({}),
  camera: () => ({ mirror: false }),
  title: () => ({}),
  albumArt: () => ({}),
  waveform: () => ({ bars: 34 }),
  lyrics: () => ({ lines: 5 }),
  // Empty text shows the placeholder (an i18n string the page passes in).
  lowerThird: () => ({ handle: "", subtitle: "" }),
};

export function defaultFrame(type, aspect = DEFAULT_ASPECT) {
  const frames = DEFAULT_FRAMES[ASPECTS.includes(aspect) ? aspect : DEFAULT_ASPECT];
  return { ...(frames[type] || FULL) };
}

/** A new scene: the seven default layers at `aspect`. */
export function defaultScene(aspect = DEFAULT_ASPECT) {
  const a = ASPECTS.includes(aspect) ? aspect : DEFAULT_ASPECT;
  return {
    v: SCENE_VERSION,
    aspect: a,
    layers: DEFAULT_LAYERS.map((l) => ({
      id: l.type,
      type: l.type,
      visible: l.visible,
      frame: defaultFrame(l.type, a),
      props: DEFAULT_PROPS[l.type](),
    })),
  };
}

const sameFrame = (a, b) => ["x", "y", "w", "h"].every((k) => Math.abs((a?.[k] ?? NaN) - b[k]) < 1e-6);

/**
 * `scene` at a new aspect. A layer still at the old aspect's default frame
 * moves to the new aspect's default; one placed by hand keeps its fractions.
 * Returns a new scene; `scene` is not changed.
 */
export function withAspect(scene, aspect) {
  if (!ASPECTS.includes(aspect)) return scene;
  const from = scene.aspect;
  return {
    ...scene,
    aspect,
    layers: scene.layers.map((l) => ({
      ...l,
      frame: sameFrame(l.frame, defaultFrame(l.type, from)) ? defaultFrame(l.type, aspect) : { ...l.frame },
    })),
  };
}

/** `scene` with layer `id` shown or hidden. */
export function withLayerVisible(scene, id, visible) {
  return { ...scene, layers: scene.layers.map((l) => (l.id === id ? { ...l, visible: Boolean(visible) } : l)) };
}

// ── Reading and writing ──

const clamp01 = (v) => Math.max(0, Math.min(1, v));

/** A frame held inside the output: each side 0..1, at least 1% wide and high. */
export function clampFrame(f) {
  const w = Math.max(0.01, clamp01(Number(f?.w) || 0));
  const h = Math.max(0.01, clamp01(Number(f?.h) || 0));
  const x = Math.min(1 - w, clamp01(Number(f?.x) || 0));
  const y = Math.min(1 - h, clamp01(Number(f?.y) || 0));
  return { x, y, w, h };
}

/**
 * A saved scene made safe to use: anything unreadable gives the default
 * scene, an unknown layer type is dropped, a frame is clamped, a missing
 * prop takes its default. A song's scene from an older version with no
 * readable layers also starts over.
 */
export function parseScene(raw) {
  let data = raw;
  if (typeof data === "string") {
    try { data = JSON.parse(data); } catch { return defaultScene(); }
  }
  if (!data || typeof data !== "object" || !Array.isArray(data.layers)) return defaultScene();
  const aspect = ASPECTS.includes(data.aspect) ? data.aspect : DEFAULT_ASPECT;
  const seen = new Set();
  const layers = [];
  for (const l of data.layers) {
    if (!l || !LAYER_TYPES.includes(l.type)) continue;
    const id = typeof l.id === "string" && l.id && !seen.has(l.id) ? l.id : `${l.type}-${layers.length}`;
    seen.add(id);
    layers.push({
      id,
      type: l.type,
      visible: l.visible !== false,
      frame: clampFrame(l.frame || defaultFrame(l.type, aspect)),
      props: { ...DEFAULT_PROPS[l.type](), ...(l.props && typeof l.props === "object" ? l.props : {}) },
    });
  }
  if (!layers.length) return defaultScene(aspect);
  return { v: SCENE_VERSION, aspect, layers };
}

/** What is stored: a deep copy with nothing but the scene's own fields. */
export function serializeScene(scene) {
  return JSON.parse(JSON.stringify({ v: SCENE_VERSION, aspect: scene.aspect, layers: scene.layers }));
}

// ── Lyrics in view ──

/**
 * The lyric lines the lyrics layer shows at `t`: `n` lines from the one
 * being sung, as { text, role } with role "current" (drawn in the accent),
 * "next" (the two after it, white) or "later" (dim). Before the first line
 * the first `n` lines are shown, none current.
 */
export function lyricWindow(lines, t, n = 5) {
  if (!lines?.length) return [];
  const i = currentLineIndex(lines, t);
  const start = Math.max(0, i);
  const out = [];
  for (let j = 0; j < n && start + j < lines.length; j++) {
    const role = i < 0 ? (j < 3 ? "next" : "later") : j === 0 ? "current" : j < 3 ? "next" : "later";
    out.push({ text: lines[start + j].text, role });
  }
  return out;
}

// ── Waveform bars ──

/**
 * `n` bar heights (0..1) across the song from the overview peaks
 * ({ stem: [[min, max], ...] }): each bar the loudest peak of the stems in
 * `names` over its stretch, against the loudest bar. Empty peaks give zeros.
 */
export function peakBars(peaks, names, n) {
  const count = Math.max(0, Math.floor(n) || 0);
  const out = new Array(count).fill(0);
  if (!count || !peaks) return out;
  for (const name of names || []) {
    const pts = peaks[name];
    if (!pts?.length) continue;
    for (let i = 0; i < pts.length; i++) {
      const b = Math.min(count - 1, Math.floor((i / pts.length) * count));
      const p = pts[i] || [];
      const v = Math.max(Math.abs(Number(p[0]) || 0), Math.abs(Number(p[1]) || 0));
      if (v > out[b]) out[b] = v;
    }
  }
  const max = Math.max(0, ...out);
  return max > 0 ? out.map((v) => v / max) : out;
}

// ── Time ──

const pad = (n) => String(n).padStart(2, "0");

/** "00:42.3": the take timeline's clock, in tenths. */
export function clockTenths(seconds) {
  const tenths = Math.max(0, Math.floor((Number(seconds) || 0) * 10 + 1e-6));
  const s = Math.floor(tenths / 10);
  return `${pad(Math.floor(s / 60))}:${pad(s % 60)}.${tenths % 10}`;
}

/** "00:00:42": the REC badge's elapsed time. */
export function clockHours(seconds) {
  const s = Math.max(0, Math.floor(Number(seconds) || 0));
  return `${pad(Math.floor(s / 3600))}:${pad(Math.floor(s / 60) % 60)}:${pad(s % 60)}`;
}

const TICK_STEPS = [5, 10, 15, 30, 60, 120, 300];

/** The ruler's labelled ticks over `duration`: the smallest step that gives
 * at most `maxTicks` of them, as [{ t, label: "m:ss" }]. */
export function rulerTicks(duration, maxTicks = 8) {
  const d = Math.max(0, Number(duration) || 0);
  if (!d) return [];
  const step = TICK_STEPS.find((s) => d / s < maxTicks) ?? TICK_STEPS[TICK_STEPS.length - 1];
  const out = [];
  for (let t = 0; t <= d + 1e-6; t += step) out.push({ t, label: `${Math.floor(t / 60)}:${pad(Math.floor(t % 60))}` });
  return out;
}
