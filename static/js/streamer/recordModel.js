// Streamer Mode's recording and export arithmetic, kept apart from the page
// so it can be tested in Node: the recorder's states, where a take starts and
// when it stops itself, the output size and bit rate, the exported file's
// name, and the render request the server is sent. Nothing here touches the
// DOM, a device or the network.

// ── The recorder's states ──
//
//   idle -> starting -> recording -> stopping -> saved
//   any of them -> failed (with a reason), saved or failed -> idle (a new take)
//   saved -> exporting -> exported | exportFailed, either -> exporting again
export const RECORD_STATES = Object.freeze([
  "idle", "starting", "recording", "stopping", "saved", "failed", "exporting", "exported", "exportFailed",
]);

const MOVES = {
  idle: { start: "starting" },
  starting: { started: "recording", stop: "stopping", fail: "failed" },
  recording: { stop: "stopping", fail: "failed" },
  stopping: { saved: "saved", fail: "failed" },
  saved: { start: "starting", export: "exporting", reset: "idle" },
  failed: { start: "starting", reset: "idle" },
  exporting: { done: "exported", fail: "exportFailed", cancel: "saved" },
  exported: { start: "starting", export: "exporting", reset: "idle" },
  exportFailed: { start: "starting", export: "exporting", reset: "idle" },
};

/** The state after `event`, or `state` itself when the event does not apply. */
export function nextRecordState(state, event) {
  return MOVES[state]?.[event] || state;
}

/** Recording in the wide sense: a take is open (starting, recording, stopping). */
export function isTakeOpen(state) {
  return state === "starting" || state === "recording" || state === "stopping";
}

// ── Where a take starts and when it stops ──

/**
 * Where recording starts: the playhead when it stands inside the kept range
 * (at least half a second before its end), else the range's start.
 */
export function startPoint(now, range) {
  const t = Number(now) || 0;
  if (t >= range.in && t < range.out - 0.5) return t;
  return range.in;
}

/**
 * Whether the take should stop now: "Auto-stop after song ends" on and the
 * playhead at the range's end. (The song's own end stops a take anyway:
 * the transport ends it, takeRecorder.js.)
 */
export function shouldAutoStop({ t, range, duration, autoStop }) {
  if (!autoStop || !range) return false;
  const end = Math.min(range.out, Number(duration) || range.out);
  return Number(t) >= end - 0.02;
}

// ── Output ──

const SHORT = { 720: 720, 1080: 1080, 2160: 2160 };

/** The output's pixels for an aspect and a resolution (the server's
 * canvas_size: the short side is the resolution). */
export function outputPixels(aspect, resolution) {
  const short = SHORT[resolution] || 1080;
  if (aspect === "1:1") return { width: short, height: short };
  const long = Math.floor((short * 16) / 9);
  return aspect === "9:16" ? { width: short, height: long } : { width: long, height: short };
}

/** The recorder's bit rate: about 0.1 bit per pixel per frame, 2.5 to 40 Mbps. */
export function videoBitrate({ width, height }, fps) {
  const bits = width * height * (Number(fps) || 30) * 0.1;
  return Math.round(Math.max(2_500_000, Math.min(40_000_000, bits)));
}

// ── The exported file ──

// Characters no file system accepts, and control characters.
const BAD = /[<>:"/\\|?*\u0000-\u001f\u007f]/g;

/**
 * "<Title> - <Artist> (Streamer).mp4", made safe for every file system:
 * forbidden characters become spaces, runs of spaces one, no dot or space at
 * the ends, at most 120 characters before the suffix. Without a title,
 * "Streamer.mp4"; without an artist, "<Title> (Streamer).mp4".
 */
export function exportFileName(title, artist, ext = "mp4") {
  const clean = (s) => String(s || "").replace(BAD, " ").replace(/\s+/g, " ").trim().replace(/^[.\s]+|[.\s]+$/g, "");
  const t = clean(title);
  const a = clean(artist);
  let base = t ? (a ? `${t} - ${a}` : t) : "";
  if (base.length > 120) base = base.slice(0, 120).trim().replace(/[.\s]+$/g, "");
  // A name Windows reserves (CON, NUL, COM1...) is not a file name there.
  if (/^(con|prn|aux|nul|com\d|lpt\d)$/i.test(base)) base = `${base} song`;
  return base ? `${base} (Streamer).${ext}` : `Streamer.${ext}`;
}

// ── The render request ──

/**
 * The body of POST /takes/{id}/render for a Streamer take:
 * - mix: { names, gains, pitches } as heard (player.currentMixLanes), with
 *   `exclude` (the Streamer track itself) left out; none at all when
 *   `mixedAudio` is off (the take's sound alone);
 * - the canvas at the scene's aspect, `resolution` and `fps`, fit "fill"
 *   (the recorded picture is the scene, already the canvas's shape);
 * - the kept range as span "range";
 * - the click, the lanes' EQ and the master when given.
 */
export function buildRenderRequest({
  mix, exclude = [], mixedAudio = true, includeClick = false, aspect = "16:9",
  resolution = "1080", fps = 30, range, fx = "", master = "",
}) {
  const names = [];
  const gains = [];
  const pitches = [];
  if (mixedAudio && mix) {
    (mix.names || []).forEach((name, i) => {
      if (exclude.includes(name)) return;
      names.push(name);
      gains.push(mix.gains?.[i] ?? 1);
      pitches.push(mix.pitches?.[i] ?? 0);
    });
  }
  const body = {
    stems: names,
    gains,
    take_gain: 1,
    canvas: aspect,
    fit: "fill",
    mirror: false,
    size: String(resolution),
    fps: Number(fps),
    click: Boolean(includeClick),
  };
  if (range) {
    body.span = "range";
    body.range_in = Math.max(0, Math.round(range.in * 1000) / 1000);
    body.range_out = Math.max(body.range_in, Math.round(range.out * 1000) / 1000);
  } else {
    body.span = "take";
  }
  // Omitted when nothing is transposed, so a build without rubberband can
  // still render (videoRender.requestRender's rule).
  if (pitches.some((p) => p !== 0)) body.pitches = pitches;
  if (fx) body.fx = fx;
  if (master) body.master = master;
  return body;
}

/** Whether a refused render means "this ffmpeg cannot make MP4" (the raw
 * recording is then offered instead). */
export function isNoEncoder(status, detail) {
  return status === 422 && /libx264|AAC encoder/i.test(String(detail || ""));
}
