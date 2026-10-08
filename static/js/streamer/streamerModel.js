// Streamer Mode's arithmetic, kept apart from the page so it can be tested in
// Node: the scene (its layers, their frames and the aspect), where a scene is
// kept per song, reading and writing it, and the small sums the preview and
// the take timeline draw from (lyric lines in view, waveform bars, ruler
// ticks, clock text), plus the editing of a scene (move, resize with
// snapping, reorder, add, duplicate, delete, rename, properties, trim), its
// undo history and the take timeline's zoom. Nothing here holds state or
// touches the DOM: every edit returns a new scene.
//
// A scene is plain JSON:
//   { v, aspect, trim: { in, out } | null,
//     layers: [{ id, type, name?, visible, frame: { x, y, w, h }, props }] }
// Array order is the drawing order: the first layer is at the back, the last
// in front. A frame is in FRACTIONS (0..1) of the output frame, so the small
// preview and a 1920 x 1080 output are the same picture at two sizes.

import { currentLineIndex } from "../lyricsLookup.js";

export const SCENE_VERSION = 1;
export const ASPECTS = Object.freeze(["16:9", "9:16", "1:1"]);
export const DEFAULT_ASPECT = "16:9";
export const LAYER_TYPES = Object.freeze(["background", "camera", "lowerThird", "lyrics", "title", "waveform", "albumArt", "text", "image"]);
// What + Add Layer offers, in its order. Camera and Background are the scene's
// own and are never added (or duplicated, or deleted).
export const ADDABLE_TYPES = Object.freeze(["text", "image", "lowerThird", "lyrics", "waveform", "albumArt", "title"]);
const FIXED_TYPES = new Set(["camera", "background"]);
// A text layer's colour, by name (the renderer maps names to colours).
export const TEXT_COLORS = Object.freeze(["white", "yellow", "red", "blue", "green"]);
export const TEXT_SIZE_MIN = 0.5;
export const TEXT_SIZE_MAX = 3;
export const LYRIC_LINES_MIN = 3;
export const LYRIC_LINES_MAX = 7;
export const NAME_MAX = 60;
export const TRIM_MIN = 1;

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
// badge. A text layer starts in the middle, an image layer clear of it.
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
    text: px(208, 171, 300, 60, 716, 403),
    image: px(40, 60, 150, 150, 716, 403),
  },
  "9:16": {
    background: FULL,
    camera: FULL,
    title: px(16, 76, 371, 108, 403, 716),
    albumArt: px(26, 86, 88, 88, 403, 716),
    waveform: px(126, 142, 160, 28, 403, 716),
    lyrics: px(16, 470, 371, 150, 403, 716),
    lowerThird: px(16, 640, 160, 40, 403, 716),
    text: px(40, 323, 323, 70, 403, 716),
    image: px(121, 196, 161, 120, 403, 716),
  },
  "1:1": {
    background: FULL,
    camera: FULL,
    title: px(237, 8, 238, 108, 483, 483),
    albumArt: px(247, 18, 88, 88, 483, 483),
    waveform: px(347, 74, 118, 28, 483, 483),
    lyrics: px(259, 335, 216, 134, 483, 483),
    lowerThird: px(12, 431, 120, 40, 483, 483),
    text: px(92, 207, 300, 70, 483, 483),
    image: px(30, 290, 150, 130, 483, 483),
  },
};

// Back to front, and which are shown at first (the design: everything but
// the background image). The camera is right above the background: a
// full-frame camera over the overlays would hide them (phase 1 decision; the
// artboard lists Camera first).
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
  title: () => ({ showArtist: true }),
  albumArt: () => ({}),
  waveform: () => ({ bars: 34 }),
  lyrics: () => ({ lines: 5 }),
  // Empty text shows the placeholder (an i18n string the page passes in).
  lowerThird: () => ({ handle: "", subtitle: "" }),
  text: () => ({ text: "", size: 1, color: "white" }),
  // TODO(phase 5): the picked file. No file is stored yet.
  image: () => ({}),
};

export function defaultFrame(type, aspect = DEFAULT_ASPECT) {
  const frames = DEFAULT_FRAMES[ASPECTS.includes(aspect) ? aspect : DEFAULT_ASPECT];
  return { ...(frames[type] || FULL) };
}

/** A new scene: the seven default layers at `aspect`, the whole song kept. */
export function defaultScene(aspect = DEFAULT_ASPECT) {
  const a = ASPECTS.includes(aspect) ? aspect : DEFAULT_ASPECT;
  return {
    v: SCENE_VERSION,
    aspect: a,
    trim: null,
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
    const layer = {
      id,
      type: l.type,
      visible: l.visible !== false,
      frame: clampFrame(l.frame || defaultFrame(l.type, aspect)),
      props: cleanProps(l.type, { ...DEFAULT_PROPS[l.type](), ...(l.props && typeof l.props === "object" ? l.props : {}) }),
    };
    const name = cleanName(l.name);
    if (name) layer.name = name;
    layers.push(layer);
  }
  if (!layers.length) return defaultScene(aspect);
  return { v: SCENE_VERSION, aspect, trim: cleanTrim(data.trim), layers };
}

/** What is stored: a deep copy with nothing but the scene's own fields. */
export function serializeScene(scene) {
  return JSON.parse(JSON.stringify({ v: SCENE_VERSION, aspect: scene.aspect, trim: scene.trim ?? null, layers: scene.layers }));
}

function cleanName(name) {
  return typeof name === "string" ? name.trim().slice(0, NAME_MAX) : "";
}

const clampNum = (v, lo, hi, dflt) => {
  const n = Number(v);
  return Number.isFinite(n) ? Math.max(lo, Math.min(hi, n)) : dflt;
};

/** A layer's props held to what each field can be. */
function cleanProps(type, props) {
  const p = { ...props };
  if (type === "text") {
    p.text = typeof p.text === "string" ? p.text.slice(0, 200) : "";
    p.size = clampNum(p.size, TEXT_SIZE_MIN, TEXT_SIZE_MAX, 1);
    if (!TEXT_COLORS.includes(p.color)) p.color = "white";
  } else if (type === "lyrics") {
    p.lines = Math.round(clampNum(p.lines, LYRIC_LINES_MIN, LYRIC_LINES_MAX, 5));
  } else if (type === "lowerThird") {
    p.handle = typeof p.handle === "string" ? p.handle.slice(0, 60) : "";
    p.subtitle = typeof p.subtitle === "string" ? p.subtitle.slice(0, 60) : "";
  } else if (type === "camera") {
    p.mirror = p.mirror === true;
  } else if (type === "title") {
    p.showArtist = p.showArtist !== false;
  }
  return p;
}

function cleanTrim(trim) {
  const a = Number(trim?.in);
  const b = Number(trim?.out);
  if (!Number.isFinite(a) || !Number.isFinite(b) || a < 0 || b - a < TRIM_MIN) return null;
  return { in: a, out: b };
}

// ── Editing (every function returns a new scene; `locked` is the recording
// lock, phase 4: while it holds, nothing is added, deleted or reordered) ──

const layerOf = (scene, id) => scene.layers.find((l) => l.id === id) || null;
const replaceLayer = (scene, id, fn) => ({ ...scene, layers: scene.layers.map((l) => (l.id === id ? fn(l) : l)) });

/** What may be done to `layer` now. */
export function layerRules(layer, { locked = false } = {}) {
  const fixed = FIXED_TYPES.has(layer?.type);
  return {
    canDelete: Boolean(layer) && !fixed && !locked,
    canDuplicate: Boolean(layer) && !fixed && !locked,
    canReorder: Boolean(layer) && !locked,
    canAdd: !locked,
  };
}

/** A layer id not yet in `scene`: the type, then -2, -3 and so on. */
export function newLayerId(scene, type) {
  const ids = new Set(scene.layers.map((l) => l.id));
  if (!ids.has(type)) return type;
  for (let n = 2; ; n++) if (!ids.has(`${type}-${n}`)) return `${type}-${n}`;
}

const isFullFrame = (f) => f.w >= 0.99 && f.h >= 0.99;

/** Whether two frames share any area (touching edges do not count). */
export function framesOverlap(a, b) {
  const e = 1e-9;
  return a.x < b.x + b.w - e && b.x < a.x + a.w - e && a.y < b.y + b.h - e && b.y < a.y + a.h - e;
}

/**
 * Where a new frame of `want`'s size goes in `scene`: `want` itself when it
 * covers no other overlay, else the free spot inside the 5% safe inset
 * nearest to it (a 2.5% grid), else `want` moved 2% per layer of `type`
 * already there (no free spot: overlapping cannot be avoided). Full-frame
 * layers (camera, background) do not count.
 */
export function freeSpot(scene, want, type) {
  const others = scene.layers.map((l) => l.frame).filter((f) => !isFullFrame(f));
  const free = (f) => !others.some((o) => framesOverlap(f, o));
  const start = clampFrame(want);
  if (free(start)) return start;
  const step = 0.025;
  const spots = [];
  for (let y = 0.05; y + start.h <= 0.95 + 1e-9; y += step) {
    for (let x = 0.05; x + start.w <= 0.95 + 1e-9; x += step) {
      spots.push({ x, y, w: start.w, h: start.h });
    }
  }
  spots.sort((a, b) => Math.hypot(a.x - start.x, a.y - start.y) - Math.hypot(b.x - start.x, b.y - start.y));
  const spot = spots.find(free);
  if (spot) return clampFrame(spot);
  const k = scene.layers.filter((l) => l.type === type).length * 0.02;
  return clampFrame({ ...start, x: start.x + k, y: start.y + k });
}

/** `scene` with a new layer of `type` in front, at its default place, or the
 * nearest free spot when that is taken (freeSpot). */
export function addLayer(scene, type, { locked = false, id = null } = {}) {
  if (locked || !ADDABLE_TYPES.includes(type)) return scene;
  const layer = {
    id: id || newLayerId(scene, type),
    type,
    visible: true,
    frame: freeSpot(scene, defaultFrame(type, scene.aspect), type),
    props: DEFAULT_PROPS[type](),
  };
  return { ...scene, layers: [...scene.layers, layer] };
}

/** A copy of layer `id` just in front of it, in the free spot nearest to it
 * (freeSpot; when there is none, moved down and right 2%). */
export function duplicateLayer(scene, id, { locked = false } = {}) {
  const i = scene.layers.findIndex((l) => l.id === id);
  if (i < 0 || !layerRules(scene.layers[i], { locked }).canDuplicate) return scene;
  const src = scene.layers[i];
  const copy = JSON.parse(JSON.stringify(src));
  copy.id = newLayerId(scene, src.type);
  copy.frame = freeSpot(scene, src.frame, src.type);
  const layers = [...scene.layers];
  layers.splice(i + 1, 0, copy);
  return { ...scene, layers };
}

export function deleteLayer(scene, id, { locked = false } = {}) {
  const layer = layerOf(scene, id);
  if (!layer || !layerRules(layer, { locked }).canDelete) return scene;
  return { ...scene, layers: scene.layers.filter((l) => l.id !== id) };
}

/** `scene` with layer `id` moved to array index `to` (0 = at the back). */
export function reorderLayer(scene, id, to, { locked = false } = {}) {
  const from = scene.layers.findIndex((l) => l.id === id);
  if (from < 0 || locked) return scene;
  const at = Math.max(0, Math.min(scene.layers.length - 1, Math.round(to)));
  if (at === from) return scene;
  const layers = [...scene.layers];
  const [l] = layers.splice(from, 1);
  layers.splice(at, 0, l);
  return { ...scene, layers };
}

/** A name of its own (empty goes back to the type's name). */
export function renameLayer(scene, id, name) {
  if (!layerOf(scene, id)) return scene;
  const n = cleanName(name);
  return replaceLayer(scene, id, (l) => {
    const next = { ...l };
    if (n) next.name = n;
    else delete next.name;
    return next;
  });
}

export function setLayerProps(scene, id, patch) {
  if (!layerOf(scene, id)) return scene;
  return replaceLayer(scene, id, (l) => ({ ...l, props: cleanProps(l.type, { ...l.props, ...patch }) }));
}

/** `scene` with layer `id` at `frame` (clamped inside the output). */
export function setLayerFrame(scene, id, frame) {
  if (!layerOf(scene, id)) return scene;
  return replaceLayer(scene, id, (l) => ({ ...l, frame: clampFrame(frame) }));
}

/** Layer `id` moved by dx, dy (fractions; the arrow keys use 0.01 and 0.05). */
export function nudgeLayer(scene, id, dx, dy) {
  const layer = layerOf(scene, id);
  if (!layer) return scene;
  return setLayerFrame(scene, id, { ...layer.frame, x: layer.frame.x + dx, y: layer.frame.y + dy });
}

// ── Move, resize and snapping (fractions of the output) ──

// What a dragged edge or centre snaps to: the edges, the safe zones (5% and
// 10% in) and the centre line.
export const SNAP_LINES = Object.freeze([0, 0.05, 0.1, 0.5, 0.9, 0.95, 1]);

/** The snap line nearest `v` within `threshold`, or null. */
export function nearestLine(v, threshold, lines = SNAP_LINES) {
  let best = null;
  let dist = threshold;
  for (const l of lines) {
    const d = Math.abs(v - l);
    if (d <= dist) {
      dist = d;
      best = l;
    }
  }
  return best;
}

function snapAxis(pos, size, th) {
  let best = null;
  for (const [edge, off] of [[pos, 0], [pos + size, size], [pos + size / 2, size / 2]]) {
    const line = nearestLine(edge, th);
    if (line === null) continue;
    const d = Math.abs(edge - line);
    if (!best || d < best.d) best = { d, pos: line - off };
  }
  return best ? best.pos : pos;
}

/**
 * `start` moved by dx, dy, then snapped: its left, right or centre to a line
 * on x, its top, bottom or middle on y, each within its threshold
 * (fractions: tx across, ty down). Clamped inside the output.
 */
export function moveFrame(start, dx, dy, { snap = true, tx = 0.01, ty = 0.01 } = {}) {
  let x = start.x + dx;
  let y = start.y + dy;
  if (snap) {
    x = snapAxis(x, start.w, tx);
    y = snapAxis(y, start.h, ty);
  }
  return clampFrame({ x, y, w: start.w, h: start.h });
}

const MIN_SIZE = 0.03;

/**
 * `start` resized from a corner ("nw", "ne", "sw", "se") by dx, dy; the
 * opposite corner stays put. The moving edges snap; at least 3% wide and
 * high; held inside the output.
 */
export function resizeFrame(start, corner, dx, dy, { snap = true, tx = 0.01, ty = 0.01 } = {}) {
  let left = start.x;
  let top = start.y;
  let right = start.x + start.w;
  let bottom = start.y + start.h;
  const west = corner.includes("w");
  const north = corner.includes("n");
  if (west) left += dx; else right += dx;
  if (north) top += dy; else bottom += dy;
  if (snap) {
    if (west) left = nearestLine(left, tx) ?? left; else right = nearestLine(right, tx) ?? right;
    if (north) top = nearestLine(top, ty) ?? top; else bottom = nearestLine(bottom, ty) ?? bottom;
  }
  left = Math.max(0, left);
  top = Math.max(0, top);
  right = Math.min(1, right);
  bottom = Math.min(1, bottom);
  if (west) left = Math.min(left, right - MIN_SIZE); else right = Math.max(right, left + MIN_SIZE);
  if (north) top = Math.min(top, bottom - MIN_SIZE); else bottom = Math.max(bottom, top + MIN_SIZE);
  return clampFrame({ x: left, y: top, w: right - left, h: bottom - top });
}

/** The front-most shown layer whose frame holds the point (fractions), or null. */
export function layerAt(scene, x, y) {
  for (let i = scene.layers.length - 1; i >= 0; i--) {
    const l = scene.layers[i];
    if (!l.visible) continue;
    const f = l.frame;
    if (x >= f.x && x <= f.x + f.w && y >= f.y && y <= f.y + f.h) return l;
  }
  return null;
}

// ── Undo history ──

export const HISTORY_CAP = 100;

export function emptyHistory() {
  return { past: [], future: [] };
}

/** The history after an edit made from `before`: a new step, redo cleared. */
export function pushHistory(h, before, cap = HISTORY_CAP) {
  const past = [...h.past, before];
  if (past.length > cap) past.splice(0, past.length - cap);
  return { past, future: [] };
}

/** Undo from `current`: { history, scene } (scene null when nothing to undo). */
export function undoHistory(h, current) {
  if (!h.past.length) return { history: h, scene: null };
  return { history: { past: h.past.slice(0, -1), future: [current, ...h.future] }, scene: h.past[h.past.length - 1] };
}

export function redoHistory(h, current) {
  if (!h.future.length) return { history: h, scene: null };
  const [next, ...future] = h.future;
  return { history: { past: [...h.past, current], future }, scene: next };
}

// ── Trim (the part of the song a take keeps) ──

/** The kept range of `scene` over a song of `duration`: the whole song by default. */
export function trimRange(scene, duration) {
  const d = Math.max(0, Number(duration) || 0);
  const t = scene?.trim;
  if (!t) return { in: 0, out: d };
  const out = Math.min(d, t.out);
  const inn = Math.max(0, Math.min(t.in, out - TRIM_MIN));
  return { in: inn, out: Math.max(out, Math.min(d, inn + TRIM_MIN)) };
}

/** `t` on the nearest of `targets` within `threshold` seconds, else `t`. */
export function snapTime(t, targets, threshold) {
  let best = t;
  let dist = threshold;
  for (const s of targets || []) {
    const d = Math.abs(t - s);
    if (d <= dist) {
      dist = d;
      best = s;
    }
  }
  return best;
}

/**
 * `scene` with the in ("in") or out ("out") point at `t`, held to the song and
 * at least TRIM_MIN seconds from the other point. The whole song is stored as
 * no trim at all.
 */
export function withTrimPoint(scene, which, t, duration) {
  const d = Math.max(0, Number(duration) || 0);
  if (d < TRIM_MIN) return scene;
  const cur = trimRange(scene, d);
  let a = cur.in;
  let b = cur.out;
  if (which === "in") a = Math.max(0, Math.min(Number(t) || 0, b - TRIM_MIN));
  else b = Math.min(d, Math.max(Number(t) || 0, a + TRIM_MIN));
  const trim = a <= 1e-6 && b >= d - 1e-6 ? null : { in: a, out: b };
  return { ...scene, trim };
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
 * `n` bar heights (0..1) from the overview peaks ({ stem: [[min, max], ...] }):
 * each bar the loudest peak of the stems in `names` over its stretch, against
 * the loudest point of those stems in the whole song. `from` and `to`
 * (fractions of the song) draw only a stretch of it, for a zoomed timeline.
 * Empty peaks give zeros.
 */
export function peakBars(peaks, names, n, from = 0, to = 1) {
  const count = Math.max(0, Math.floor(n) || 0);
  const out = new Array(count).fill(0);
  if (!count || !peaks) return out;
  const span = Math.max(1e-9, to - from);
  let max = 0;
  for (const name of names || []) {
    const pts = peaks[name];
    if (!pts?.length) continue;
    for (let i = 0; i < pts.length; i++) {
      const p = pts[i] || [];
      const v = Math.max(Math.abs(Number(p[0]) || 0), Math.abs(Number(p[1]) || 0));
      if (v > max) max = v;
      const f = (i / pts.length - from) / span;
      if (f < 0 || f >= 1) continue;
      const b = Math.min(count - 1, Math.floor(f * count));
      if (v > out[b]) out[b] = v;
    }
  }
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
  return ticksEvery(d, step);
}

// ── Timeline zoom ──

export const ZOOM_MAX_PPS = 120;

/**
 * Pixels per second at `zoom` (0..1) for a song of `duration` seconds shown
 * in `view` pixels: 0 is the whole song in view (Fit), 1 is ZOOM_MAX_PPS,
 * geometric in between so each step feels the same.
 */
export function pixelsPerSecond(duration, view, zoom) {
  const d = Math.max(1e-6, Number(duration) || 0);
  const fit = Math.max(1e-6, view) / d;
  const max = Math.max(fit, ZOOM_MAX_PPS);
  const z = Math.max(0, Math.min(1, Number(zoom) || 0));
  return fit * Math.pow(max / fit, z);
}

const TICK_STEPS_FINE = [1, 2, 5, 10, 15, 30, 60, 120, 300];

/** The ruler step (seconds) that keeps labels at least `minPx` apart. */
export function tickStep(pps, minPx = 64) {
  return TICK_STEPS_FINE.find((s) => s * pps >= minPx) ?? TICK_STEPS_FINE[TICK_STEPS_FINE.length - 1];
}

/** Labelled ticks every `step` seconds from 0 to `duration`. */
export function ticksEvery(duration, step) {
  const d = Math.max(0, Number(duration) || 0);
  const out = [];
  if (!d || !(step > 0)) return out;
  for (let i = 0; i * step <= d + 1e-6; i++) {
    const t = i * step;
    out.push({ t, label: `${Math.floor(t / 60)}:${pad(Math.floor(t % 60))}` });
  }
  return out;
}
