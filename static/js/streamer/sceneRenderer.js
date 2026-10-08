// Streamer Mode's one scene renderer: draws a scene (streamerModel.js) into a
// Canvas 2D context. The preview calls it now; the recorded frames will call
// the same function later, so the two cannot differ.
//
// It reads only what it is given: the scene, and a snapshot of the song at
// this frame (`frame`: time, title, artist, artwork, lyric lines, waveform
// bars). No DOM, no layout. Every position is a layer's frame (fractions of
// the output) times the output size, and every text or padding size is a
// design pixel times `u`, the output's short side over 403 (the design's
// preview height), so a 716 x 403 preview and a 1920 x 1080 file are the same
// picture.
//
// `editor` draws what only the editor shows: the selection outline, the safe
// zones, the camera and image placeholders and the camera's preview mirror.
// Called without it (the output), none of them is drawn. The REC badge is a
// button over the preview, not part of the picture at all.

const DESIGN_SHORT = 403;

// Rounded rectangle path, without ctx.roundRect (older WebKitGTK lacks it).
function rr(ctx, x, y, w, h, r) {
  const k = Math.max(0, Math.min(r, w / 2, h / 2));
  ctx.beginPath();
  ctx.moveTo(x + k, y);
  ctx.arcTo(x + w, y, x + w, y + h, k);
  ctx.arcTo(x + w, y + h, x, y + h, k);
  ctx.arcTo(x, y + h, x, y, k);
  ctx.arcTo(x, y, x + w, y, k);
  ctx.closePath();
}

/** `text` cut with an ellipsis to fit `maxW` in the current font. */
function fit(ctx, text, maxW) {
  const s = String(text || "");
  if (!s || maxW <= 0) return "";
  if (ctx.measureText(s).width <= maxW) return s;
  let lo = 0;
  let hi = s.length;
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1;
    if (ctx.measureText(`${s.slice(0, mid)}…`).width <= maxW) lo = mid;
    else hi = mid - 1;
  }
  return lo ? `${s.slice(0, lo).trimEnd()}…` : "";
}

const box = (layer, W, H) => ({
  x: layer.frame.x * W,
  y: layer.frame.y * H,
  w: layer.frame.w * W,
  h: layer.frame.h * H,
});

function isDrawable(img) {
  if (!img) return false;
  if (typeof HTMLVideoElement !== "undefined" && img instanceof HTMLVideoElement) return img.videoWidth > 0;
  return Boolean(img.complete !== false && (img.naturalWidth ?? img.width) > 0);
}

/** Draw `img` to cover x, y, w, h (cropped to the box, centred). */
function cover(ctx, img, x, y, w, h, mirror = false) {
  const iw = img.videoWidth || img.naturalWidth || img.width;
  const ih = img.videoHeight || img.naturalHeight || img.height;
  if (!iw || !ih) return;
  const s = Math.max(w / iw, h / ih);
  const sw = w / s;
  const sh = h / s;
  ctx.save();
  if (mirror) {
    ctx.translate(x + w, y);
    ctx.scale(-1, 1);
    ctx.drawImage(img, (iw - sw) / 2, (ih - sh) / 2, sw, sh, 0, 0, w, h);
  } else {
    ctx.drawImage(img, (iw - sw) / 2, (ih - sh) / 2, sw, sh, x, y, w, h);
  }
  ctx.restore();
}

// ── Layers ──

function drawBackground(ctx, b) {
  const g = ctx.createLinearGradient(0, b.y, 0, b.y + b.h);
  g.addColorStop(0, "#141a24");
  g.addColorStop(1, "#0c1016");
  ctx.fillStyle = g;
  ctx.fillRect(b.x, b.y, b.w, b.h);
  const glow = (cx, cy, r, rgb, a) => {
    const rg = ctx.createRadialGradient(cx, cy, 0, cx, cy, r);
    rg.addColorStop(0, `rgba(${rgb},${a})`);
    rg.addColorStop(1, `rgba(${rgb},0)`);
    ctx.fillStyle = rg;
    ctx.fillRect(b.x, b.y, b.w, b.h);
  };
  glow(b.x + b.w * 0.25, b.y + b.h * 0.3, Math.min(b.w, b.h) * 0.45, "80,120,170", 0.35);
  glow(b.x + b.w * 0.75, b.y + b.h * 0.6, Math.min(b.w, b.h) * 0.45, "150,80,160", 0.3);
}

function drawCamera(ctx, b, env, layer) {
  const cam = env.frame.camera;
  if (isDrawable(cam)) {
    // The mirror is the preview's only: the video is never mirrored.
    cover(ctx, cam, b.x, b.y, b.w, b.h, Boolean(env.editor && layer.props?.mirror));
    return;
  }
  // No camera yet: the editor shows where it goes; the output stays clear.
  if (!env.editor) return;
  const g = ctx.createLinearGradient(0, b.y, 0, b.y + b.h);
  g.addColorStop(0, "#121821");
  g.addColorStop(1, "#090c11");
  ctx.fillStyle = g;
  ctx.fillRect(b.x, b.y, b.w, b.h);
  const u = env.u;
  const s = 30 * u;
  const cx = b.x + b.w / 2;
  const cy = b.y + b.h * 0.46;
  ctx.save();
  ctx.strokeStyle = "rgba(201,207,215,.28)";
  ctx.lineWidth = 1.6 * u;
  rr(ctx, cx - s, cy - s * 0.62, s * 2, s * 1.35, 4 * u);
  ctx.stroke();
  ctx.beginPath();
  ctx.arc(cx, cy + s * 0.05, s * 0.36, 0, Math.PI * 2);
  ctx.stroke();
  if (env.labels.camera) {
    ctx.fillStyle = "rgba(201,207,215,.42)";
    ctx.font = `500 ${12 * u}px ${env.font}`;
    ctx.textAlign = "center";
    ctx.textBaseline = "top";
    ctx.fillText(fit(ctx, env.labels.camera, b.w * 0.8), cx, cy + s * 0.95);
  }
  ctx.restore();
}

/** The title card: its backdrop over the whole frame, the song's title and
 * artist to the right of the album art when that layer is shown inside it. */
function drawTitle(ctx, b, env, layer) {
  const { u, frame } = env;
  ctx.fillStyle = "rgba(16,13,11,.58)";
  rr(ctx, b.x, b.y, b.w, b.h, 6 * u);
  ctx.fill();
  let left = b.x + 10 * u;
  const art = env.layer("albumArt");
  if (art?.visible) {
    const a = box(art, env.W, env.H);
    const aw = Math.min(a.w, a.h);
    if (a.x >= b.x - 1 && a.x + aw <= b.x + b.w && a.y < b.y + b.h && a.y + aw > b.y) left = Math.max(left, a.x + aw + 12 * u);
  }
  const maxW = b.x + b.w - 10 * u - left;
  ctx.textAlign = "left";
  ctx.textBaseline = "top";
  ctx.fillStyle = "#ffffff";
  ctx.font = `700 ${16 * u}px ${env.font}`;
  const top = b.y + 16 * u;
  ctx.fillText(fit(ctx, frame.title, maxW), left, top);
  if (layer?.props?.showArtist === false) return;
  ctx.fillStyle = "rgba(232,235,239,.72)";
  ctx.font = `400 ${12.5 * u}px ${env.font}`;
  ctx.fillText(fit(ctx, frame.artist, maxW), left, top + 23 * u);
}

// A text layer's colours, by the names the model allows.
const TEXT_COLOR = { white: "#ffffff", yellow: null, red: "#ef4444", blue: "#6ea8ff", green: "#22c55e" };

const TEXT_LINE = 1.2;

/**
 * `text` broken into lines no wider than `maxW` in the current font, at word
 * boundaries (a word wider than a line is cut with an ellipsis). Text with
 * no spaces (Chinese, Japanese) breaks between characters.
 */
export function wrapText(ctx, text, maxW) {
  const s = String(text || "").trim();
  if (!s) return [];
  const spaced = /\s/.test(s);
  // No spaces and East Asian script: a line may break between any characters.
  const cjk = !spaced && [...s].some((c) => c.codePointAt(0) >= 0x2e80);
  const parts = spaced ? s.split(/\s+/) : cjk ? [...s] : [s];
  const join = spaced ? " " : "";
  const lines = [];
  let line = "";
  for (const part of parts) {
    const next = line ? line + join + part : part;
    if (ctx.measureText(next).width <= maxW) {
      line = next;
      continue;
    }
    if (line) lines.push(line);
    line = ctx.measureText(part).width <= maxW ? part : fit(ctx, part, maxW);
  }
  if (line) lines.push(line);
  return lines;
}

/**
 * The size and lines of `text` in a w x h box: the asked size when it fits,
 * else smaller (down to `min`); at the smallest size, the lines that fit, the
 * last one ending in an ellipsis. Nothing is ever wider or taller than the box.
 */
export function fitText(ctx, text, w, h, size, min, weight, font) {
  let s = Math.max(min, size);
  for (;;) {
    ctx.font = `${weight} ${s}px ${font}`;
    const lines = wrapText(ctx, text, w);
    if (lines.length * s * TEXT_LINE <= h + 1e-6 || s <= min) {
      const room = Math.max(1, Math.floor(h / (s * TEXT_LINE)));
      if (lines.length <= room) return { size: s, lines };
      const kept = lines.slice(0, room);
      kept[room - 1] = fit(ctx, `${kept[room - 1]}…`, w);
      return { size: s, lines: kept };
    }
    s = Math.max(min, s * 0.9);
  }
}

/** Text centred in its frame, 20 design pixels at size 1, wrapped and made
 * smaller to stay inside the frame (clipped to it as well). Empty text shows
 * its placeholder in the editor and nothing in the video. */
function drawText(ctx, b, env, layer) {
  const { u } = env;
  const text = layer.props?.text || "";
  const shown = text || (env.editor ? env.labels.text || "" : "");
  if (!shown) return;
  const { size, lines } = fitText(ctx, shown, b.w, b.h, 20 * (layer.props?.size || 1) * u, 6 * u, 700, env.font);
  if (!lines.length) return;
  ctx.save();
  ctx.beginPath();
  ctx.rect(b.x, b.y, b.w, b.h);
  ctx.clip();
  ctx.font = `700 ${size}px ${env.font}`;
  ctx.textAlign = "center";
  ctx.textBaseline = "middle";
  const color = TEXT_COLOR[layer.props?.color] === null ? env.accent : TEXT_COLOR[layer.props?.color] || "#ffffff";
  ctx.fillStyle = text ? color : "rgba(255,255,255,.45)";
  ctx.shadowColor = "rgba(0,0,0,.55)";
  ctx.shadowBlur = 6 * u;
  const lh = size * TEXT_LINE;
  const top = b.y + b.h / 2 - (lines.length * lh) / 2 + lh / 2;
  lines.forEach((line, i) => ctx.fillText(line, b.x + b.w / 2, top + i * lh));
  ctx.restore();
}

/** An image layer: no file can be picked yet (phase 5), so the editor shows
 * where it goes and the video shows nothing. */
function drawImage(ctx, b, env) {
  if (!env.editor) return;
  const { u } = env;
  ctx.save();
  ctx.fillStyle = "rgba(20,27,36,.55)";
  ctx.fillRect(b.x, b.y, b.w, b.h);
  ctx.strokeStyle = "rgba(201,207,215,.35)";
  ctx.lineWidth = Math.max(1, u);
  ctx.setLineDash([3 * u, 3 * u]);
  ctx.strokeRect(b.x + u / 2, b.y + u / 2, b.w - u, b.h - u);
  ctx.setLineDash([]);
  if (env.labels.image) {
    ctx.fillStyle = "rgba(201,207,215,.6)";
    ctx.font = `500 ${11 * u}px ${env.font}`;
    ctx.textAlign = "center";
    ctx.textBaseline = "middle";
    ctx.fillText(fit(ctx, env.labels.image, b.w - 8 * u), b.x + b.w / 2, b.y + b.h / 2);
  }
  ctx.restore();
}

function drawAlbumArt(ctx, b, env) {
  const { u } = env;
  const s = Math.min(b.w, b.h);
  const r = 3 * u;
  ctx.save();
  rr(ctx, b.x, b.y, s, s, r);
  ctx.clip();
  const img = env.frame.art;
  if (isDrawable(img)) {
    cover(ctx, img, b.x, b.y, s, s);
  } else {
    // No artwork: the design's warm disc.
    const g = ctx.createRadialGradient(b.x + s * 0.3, b.y + s * 0.3, 0, b.x + s * 0.3, b.y + s * 0.3, s);
    g.addColorStop(0, "#d98a3c");
    g.addColorStop(0.6, "#5b2a14");
    g.addColorStop(1, "#1c0f09");
    ctx.fillStyle = g;
    ctx.fillRect(b.x, b.y, s, s);
    ctx.strokeStyle = "rgba(255,220,170,.35)";
    ctx.lineWidth = u;
    ctx.beginPath();
    ctx.arc(b.x + s / 2, b.y + s / 2, s / 2 - 17 * u, 0, Math.PI * 2);
    ctx.stroke();
    ctx.fillStyle = env.accent;
    ctx.beginPath();
    ctx.arc(b.x + s / 2, b.y + s / 2, 4 * u, 0, Math.PI * 2);
    ctx.fill();
  }
  ctx.restore();
  ctx.strokeStyle = "rgba(255,255,255,.22)";
  ctx.lineWidth = u;
  rr(ctx, b.x + u / 2, b.y + u / 2, s - u, s - u, r);
  ctx.stroke();
}

/** Bars of the song's overview at the stems heard now: played part in the
 * accent, the rest the accent at half strength. */
function drawWaveform(ctx, b, env, layer) {
  const n = Math.max(1, layer.props?.bars || 34);
  const bars = env.frame.bars?.length === n ? env.frame.bars : null;
  const step = b.w / n;
  const bw = Math.max(1, step * 0.62);
  const played = env.frame.duration > 0 ? env.frame.t / env.frame.duration : 0;
  const mid = b.y + b.h / 2;
  for (let i = 0; i < n; i++) {
    const v = bars ? bars[i] : 0.3;
    const h = Math.min(b.h, ((5 + v * 20) / 28) * b.h);
    ctx.fillStyle = i / n <= played ? env.accent : env.accentDim;
    ctx.fillRect(b.x + i * step, mid - h / 2, bw, h);
  }
}

function drawLyrics(ctx, b, env, layer) {
  const { u, frame } = env;
  const lines = frame.lyrics || [];
  if (!lines.length && !(env.editor && env.labels.noLyrics)) return;
  ctx.fillStyle = "rgba(14,13,14,.8)";
  rr(ctx, b.x, b.y, b.w, b.h, 6 * u);
  ctx.fill();
  ctx.strokeStyle = "rgba(255,255,255,.07)";
  ctx.lineWidth = u;
  rr(ctx, b.x + u / 2, b.y + u / 2, b.w - u, b.h - u, 6 * u);
  ctx.stroke();
  // The lines asked for always fit the box: the text gets smaller instead.
  const want = Math.max(1, layer.props?.lines || 5);
  const size = Math.max(4 * u, Math.min(12.5 * u, (b.h - 24 * u) / (want * 1.62)));
  const lh = size * 1.62;
  const left = b.x + 14 * u;
  const maxW = b.w - 28 * u;
  const max = want;
  ctx.save();
  rr(ctx, b.x, b.y, b.w, b.h, 6 * u);
  ctx.clip();
  ctx.textAlign = "left";
  ctx.textBaseline = "middle";
  if (!lines.length) {
    ctx.fillStyle = "rgba(255,255,255,.45)";
    ctx.font = `500 ${size}px ${env.font}`;
    ctx.fillText(fit(ctx, env.labels.noLyrics, maxW), left, b.y + 12 * u + lh / 2);
    ctx.restore();
    return;
  }
  lines.slice(0, max).forEach((line, j) => {
    ctx.font = `${line.role === "current" ? 600 : 500} ${size}px ${env.font}`;
    ctx.fillStyle = line.role === "current" ? env.accent : line.role === "next" ? "rgba(255,255,255,.95)" : "rgba(255,255,255,.5)";
    ctx.fillText(fit(ctx, line.text, maxW), left, b.y + 12 * u + lh * j + lh / 2);
  });
  ctx.restore();
}

/** Accent bar, handle and subtitle, on a backdrop as wide as its text,
 * standing on the frame's bottom left corner. */
function drawLowerThird(ctx, b, env, layer) {
  const { u } = env;
  const handle = layer.props?.handle || env.labels.handle || "";
  const sub = layer.props?.subtitle || env.labels.subtitle || "";
  ctx.font = `700 ${12 * u}px ${env.font}`;
  const w1 = ctx.measureText(handle).width;
  ctx.font = `400 ${10 * u}px ${env.font}`;
  const w2 = ctx.measureText(sub).width;
  const textW = Math.min(Math.max(w1, w2), env.W * 0.6);
  const h = 40 * u;
  const w = 8 * u + 3 * u + 8 * u + textW + 12 * u;
  const x = b.x;
  const y = b.y + b.h - h;
  ctx.fillStyle = "rgba(8,10,14,.66)";
  rr(ctx, x, y, w, h, 5 * u);
  ctx.fill();
  ctx.fillStyle = env.accent;
  rr(ctx, x + 8 * u, y + 6 * u, 3 * u, h - 12 * u, 1.5 * u);
  ctx.fill();
  const tx = x + 19 * u;
  ctx.textAlign = "left";
  ctx.textBaseline = "top";
  ctx.fillStyle = "#ffffff";
  ctx.font = `700 ${12 * u}px ${env.font}`;
  ctx.fillText(fit(ctx, handle, textW + 1), tx, y + 7 * u);
  ctx.fillStyle = "rgba(232,235,239,.75)";
  ctx.font = `400 ${10 * u}px ${env.font}`;
  ctx.fillText(fit(ctx, sub, textW + 1), tx, y + 22 * u);
}

const DRAW = {
  background: drawBackground,
  camera: drawCamera,
  title: drawTitle,
  albumArt: drawAlbumArt,
  waveform: drawWaveform,
  lyrics: drawLyrics,
  lowerThird: drawLowerThird,
  text: drawText,
  image: drawImage,
};

// ── Editor-only overlays ──

function drawSelection(ctx, layer, env) {
  const b = box(layer, env.W, env.H);
  const full = b.w >= env.W - 1 && b.h >= env.H - 1;
  // A full-frame layer's outline sits inside the edge (it has no outside).
  const o = (full ? -4 : 3) * env.u;
  let w = b.w;
  let h = b.h;
  if (layer.type === "albumArt") w = h = Math.min(b.w, b.h);
  ctx.save();
  ctx.strokeStyle = env.accent;
  ctx.lineWidth = Math.max(1, 1.5 * env.u);
  ctx.setLineDash([4 * env.u, 3 * env.u]);
  ctx.strokeRect(b.x - o, b.y - o, w + 2 * o, h + 2 * o);
  ctx.restore();
}

function drawSafeZones(ctx, env) {
  const { W, H, u, labels } = env;
  ctx.save();
  ctx.lineWidth = Math.max(1, u);
  ctx.setLineDash([4 * u, 3 * u]);
  const zone = (inset, alpha, label, labelAlpha) => {
    const x = W * inset;
    const y = H * inset;
    ctx.strokeStyle = `rgba(110,168,255,${alpha})`;
    ctx.strokeRect(x, y, W - 2 * x, H - 2 * y);
    if (!label) return;
    ctx.fillStyle = `rgba(140,185,255,${labelAlpha})`;
    ctx.font = `400 ${10 * u}px ${env.font}`;
    ctx.textAlign = "left";
    ctx.textBaseline = "bottom";
    ctx.fillText(label, x + 6 * u, H - y - 4 * u);
  };
  zone(0.05, 0.75, labels.actionSafe, 0.95);
  zone(0.1, 0.5, labels.titleSafe, 0.85);
  ctx.restore();
}

// ── Entry point ──

/**
 * Draw `scene` at the output size `width` x `height` into `ctx` (already
 * scaled for the device's pixels by the caller).
 * - frame: { t, duration, title, artist, art, camera, lyrics: [{ text, role }], bars: [0..1] }
 * - opts: { width, height, font, accent, accentDim, labels, editor }
 *   editor: null for the output, or { selection: layer id | null, safeZones }.
 */
export function renderScene(ctx, scene, frame, opts) {
  const W = opts.width;
  const H = opts.height;
  const editor = opts.editor || null;
  const env = {
    W,
    H,
    u: Math.min(W, H) / DESIGN_SHORT,
    font: opts.font || "sans-serif",
    accent: opts.accent || "#f4b740",
    accentDim: opts.accentDim || "rgba(244,183,64,.55)",
    labels: { ...(opts.labels || {}) },
    editor,
    frame: frame || {},
    layer: (type) => scene.layers.find((l) => l.type === type) || null,
  };
  ctx.save();
  ctx.fillStyle = "#000000";
  ctx.fillRect(0, 0, W, H);
  for (const layer of scene.layers) {
    if (!layer.visible) continue;
    const draw = DRAW[layer.type];
    if (!draw) continue;
    ctx.save();
    try {
      draw(ctx, box(layer, W, H), env, layer);
    } finally {
      ctx.restore();
    }
  }
  if (editor) {
    const sel = editor.selection && scene.layers.find((l) => l.id === editor.selection && l.visible);
    if (sel) drawSelection(ctx, sel, env);
    if (editor.safeZones) drawSafeZones(ctx, env);
  }
  ctx.restore();
}
