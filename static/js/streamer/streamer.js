// Streamer Mode: a workspace view over the studio, entered from the rail's
// Streamer button (or the Mode menu), for building a performance video: a
// scene of layers (camera, song title, lyrics, waveform, lower third, album
// art, background) drawn over the song as it plays, a take timeline, and the
// recording and output settings.
//
// Like Karaoke Mode (karaoke/karaoke.js), it is a view, not a second player:
// the time, the song and the mix are the studio's own (transport(),
// setPlayheadTime, state.js), read each frame by one animation loop that runs
// only while the view is open. As in Karaoke, the app's footer is hidden
// while it is open (streamer.css) and the view covers its place; Stop and
// Play / Pause sit in the take timeline's strip, and Space still plays.
//
// The scene is Streamer's own, kept per song (sceneStore.js), and drawn by
// one renderer (sceneRenderer.js) that will also draw the recorded frames.
//
// Phase 1 of docs/plans/0.21.0/streamer-mode.md: the shell and the preview.
// The layers panel shows and hides layers; moving them, the timeline's trim
// and zoom, the devices, recording and export come in phases 2 to 4.

import { t, onLanguageChange } from "../i18n.js";
import { currentJobId, mixerState, trackIndex, totalDuration } from "../state.js";
import { transport, setPlayheadTime, togglePlayPause, stopTransport } from "../transport.js";
import { laneLabel, STEM_COLORS } from "../constants.js";
import { karaokeLyrics } from "../lyrics.js";
import { getCurrentTrackInfo } from "../catalog.js";
import { getSections, sectionDisplayName } from "../sections.js";
import { overviewPeaks } from "../player.js";
import { isRecording } from "../capture/recordUi.js";
import { isKaraokeOpen, closeKaraoke } from "../karaoke/karaoke.js";
import { sungLines } from "../karaoke/karaokeModel.js";
import {
  ASPECTS, defaultScene, withAspect, withLayerVisible, fitAspect,
  lyricWindow, peakBars, clockTenths, clockHours, rulerTicks,
} from "./streamerModel.js";
import { loadScene, saveScene, flushScene } from "./sceneStore.js";
import { renderScene } from "./sceneRenderer.js";

const SAFE_KEY = "stemdeck.streamer.safeZones";
const TABS = ["builder", "live", "templates"];
const TAB_LABEL = { builder: "streamer.tabBuilder", live: "streamer.tabLive", templates: "streamer.tabTemplates" };
const ASPECT_LABEL = { "16:9": "streamer.aspect169", "9:16": "streamer.aspect916", "1:1": "streamer.aspect11" };
const LAYER_NAME = {
  camera: "streamer.layer.camera",
  title: "streamer.layer.title",
  lyrics: "streamer.layer.lyrics",
  waveform: "streamer.layer.waveform",
  lowerThird: "streamer.layer.lowerThird",
  albumArt: "streamer.layer.albumArt",
  background: "streamer.layer.background",
};

let root = null;
let railBtn = null;
let open = false;
let raf = 0;
const listeners = new Set();

// The open song's scene, and the song it belongs to (null until loaded).
let scene = defaultScene();
let sceneJob = null;
let sceneToken = 0;
let selected = "title";
let tab = "builder";
let safeZones = readSafeZones();

// Lyrics of the shown song: its sung lines (line timing only).
let lyr = { trackId: null, lines: [] };
let lyrToken = 0;
let shownJob = null;

// What was last painted, so a frame repaints only what changed.
const painted = {};
let ui = null;
// Texts to set again when the language changes: [element, key, attribute].
let texts = [];

function readSafeZones() {
  try { return localStorage.getItem(SAFE_KEY) === "1"; } catch { return false; }
}

function writeSafeZones() {
  try { localStorage.setItem(SAFE_KEY, safeZones ? "1" : "0"); } catch (err) {
    console.warn("[streamer] saving the safe zones switch failed:", err);
  }
}

// ── Small DOM helpers ──

function el(tag, cls, text) {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (text != null) e.textContent = text;
  return e;
}

function button(cls) {
  const b = el("button", cls);
  b.type = "button";
  return b;
}

/** Set `key`'s text on `node` (text, or an attribute), now and on a language change. */
function tx(node, key, attr = "text") {
  texts.push([node, key, attr]);
  setText(node, key, attr);
  return node;
}

function setText(node, key, attr) {
  const v = t(key);
  if (attr === "text") node.textContent = v;
  else if (attr === "label") {
    node.setAttribute("aria-label", v);
    node.title = v;
  } else node.setAttribute(attr, v);
}

const SVG_NS = "http://www.w3.org/2000/svg";
function icon(paths, { size = 18, fill = "none", stroke = "currentColor", width = 1.8 } = {}) {
  const svg = document.createElementNS(SVG_NS, "svg");
  svg.setAttribute("width", size);
  svg.setAttribute("height", size);
  svg.setAttribute("viewBox", "0 0 24 24");
  svg.setAttribute("fill", fill);
  svg.setAttribute("stroke", stroke);
  svg.setAttribute("stroke-width", width);
  svg.setAttribute("stroke-linecap", "round");
  svg.setAttribute("stroke-linejoin", "round");
  svg.setAttribute("aria-hidden", "true");
  for (const p of paths) {
    const [tagName, attrs] = typeof p === "string" ? ["path", { d: p }] : p;
    const node = document.createElementNS(SVG_NS, tagName);
    for (const [k, v] of Object.entries(attrs)) node.setAttribute(k, v);
    svg.append(node);
  }
  return svg;
}

const ICONS = {
  camera: ["M3 8a2 2 0 0 1 2-2h2l1.5-2h7L17 6h2a2 2 0 0 1 2 2v10a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z", ["circle", { cx: 12, cy: 13, r: 3.5 }]],
  gear: [["circle", { cx: 12, cy: 12, r: 3 }], "M12 3v3M12 18v3M3 12h3M18 12h3M5.6 5.6l2.1 2.1M16.3 16.3l2.1 2.1M5.6 18.4l2.1-2.1M16.3 7.7l2.1-2.1"],
  caret: [["path", { d: "M6 9h12l-6 7z", fill: "currentColor", stroke: "none" }]],
  plus: ["M12 5v14M5 12h14"],
  minus: ["M5 12h14"],
  grip: [9, 15].flatMap((cx) => [6, 12, 18].map((cy) => ["circle", { cx, cy, r: 1.7, fill: "currentColor", stroke: "none" }])),
  kebab: [5, 12, 19].map((cy) => ["circle", { cx: 12, cy, r: 1.8, fill: "currentColor", stroke: "none" }]),
  text: ["M3 6V4h11v2M8.5 4v15M6 19h5M14 11h7M17.5 11v8"],
  wave: ["M3 11v2M6 9v6M9 6v12M12 9v6M15 4v16M18 8v8M21 11v2"],
  lower: ["M4 5h16M7 9h10M9 13h6", "M6 17h12l-2 3H8z"],
  image: [["rect", { x: 3, y: 4, width: 18, height: 16, rx: 2 }], ["circle", { cx: 9, cy: 10, r: 2 }], "M21 16l-5-5-9 9"],
  scissors: [["circle", { cx: 6, cy: 6, r: 3 }], ["circle", { cx: 6, cy: 18, r: 3 }], "M20 4L8.1 15.9M14.5 14.5L20 20M8.1 8.1L12 12"],
  undo: ["M9 14L4 9l5-5M4 9h11a5 5 0 0 1 0 10h-3"],
  redo: ["M15 14l5-5-5-5M20 9H9a5 5 0 0 0 0 10h3"],
  film: [["rect", { x: 3, y: 4, width: 18, height: 16, rx: 2 }], "M7 4v16M17 4v16M3 9h4M3 15h4M17 9h4M17 15h4"],
  mic: [["rect", { x: 9, y: 3, width: 6, height: 11, rx: 3 }], "M5 11a7 7 0 0 0 14 0M12 18v3"],
  webcam: [["rect", { x: 3, y: 6, width: 18, height: 13, rx: 2 }], ["circle", { cx: 12, cy: 12.5, r: 3 }], "M7 6l1.5-2h7L17 6"],
  upload: ["M12 15V4M7 9l5-5 5 5M5 20h14"],
  output: [["rect", { x: 3, y: 4, width: 18, height: 16, rx: 2 }], "M15 4v16"],
  play: [["path", { d: "M7 4.5v15l12-7.5z", fill: "currentColor", stroke: "none" }]],
  pause: [["rect", { x: 6, y: 5, width: 4, height: 14, rx: 1, fill: "currentColor", stroke: "none" }], ["rect", { x: 14, y: 5, width: 4, height: 14, rx: 1, fill: "currentColor", stroke: "none" }]],
  stop: [["rect", { x: 6, y: 6, width: 12, height: 12, rx: 1.5, fill: "currentColor", stroke: "none" }]],
};
const LAYER_ICON = { camera: "camera", lyrics: "text", waveform: "wave", lowerThird: "lower", background: "image" };

function selectBox(cls, leadIcon) {
  const wrap = el("div", `sm-select ${cls || ""}`.trim());
  const sel = el("select", "sm-sel");
  if (leadIcon) {
    wrap.classList.add("sm-select-icon");
    const lead = icon(ICONS[leadIcon], { size: 18 });
    lead.classList.add("sm-sel-lead");
    wrap.append(lead);
  }
  const caret = icon(ICONS.caret, { size: 11 });
  caret.classList.add("sm-sel-caret");
  wrap.prepend(sel);
  wrap.append(caret);
  return { wrap, sel };
}

function option(sel, value, key) {
  const o = el("option");
  o.value = value;
  tx(o, key);
  sel.append(o);
  return o;
}

/** A switch: a button with role="switch", the design's 40 x 22 track. */
function makeSwitch(cls, labelKey, on, onChange) {
  const b = button(`sm-switch-row ${cls || ""}`.trim());
  b.setAttribute("role", "switch");
  const track = el("span", "sm-switch");
  track.append(el("span", "sm-knob"));
  b.append(track);
  if (labelKey) b.append(tx(el("span", "sm-switch-label"), labelKey));
  const set = (v) => b.setAttribute("aria-checked", String(Boolean(v)));
  set(on);
  b.addEventListener("click", () => {
    const next = b.getAttribute("aria-checked") !== "true";
    set(next);
    onChange?.(next);
  });
  return { b, set };
}

// A not-yet control: it says so beside itself instead of doing nothing.
function soon(btn, key = "streamer.soon") {
  btn.setAttribute("aria-disabled", "true");
  tx(btn, key, "title");
  btn.addEventListener("click", (e) => {
    e.stopPropagation();
    flashNote(t(key), btn);
  });
}

// ── Build ──

function buildView() {
  root = document.getElementById("streamer");
  if (!root) return false;
  root.replaceChildren();
  tx(root, "streamer.regionAria", "aria-label");

  const center = el("div", "sm-center");
  const head = buildHead();
  const builder = buildBuilder();
  const other = el("div", "sm-other");
  other.id = "streamerOtherPanel";
  other.setAttribute("role", "tabpanel");
  other.hidden = true;
  const otherTitle = el("span", "sm-other-title");
  other.append(otherTitle, tx(el("span", "sm-other-text"), "streamer.notYet"));
  center.append(head.card, builder.panel, other);

  const side = buildSide();
  const scrim = el("div", "sm-scrim");
  scrim.addEventListener("click", () => toggleDrawer(false));

  const noTrack = el("div", "sm-no-track");
  noTrack.hidden = true;
  tx(noTrack, "streamer.noTrack");

  root.append(center, scrim, side.aside, noTrack);
  ui = { center, head, builder, other, otherTitle, side, noTrack };
  ui.canvas = builder.canvas;
  ui.ctx = builder.canvas.getContext("2d");
  const cs = getComputedStyle(document.documentElement);
  ui.font = getComputedStyle(root).fontFamily || "sans-serif";
  ui.accent = cs.getPropertyValue("--accent").trim() || "#f4b740";
  paintTabs();
  paintSafe();
  return true;
}

function buildHead() {
  const card = el("div", "sm-card sm-head");
  const row = el("div", "sm-head-row");
  const mark = icon(ICONS.camera, { size: 30, stroke: "var(--sm-yellow)", width: 1.7 });
  mark.classList.add("sm-head-icon");
  const title = tx(el("h2", "sm-head-title"), "streamer.title");
  const sep = el("span", "sm-head-sep");
  const sub = tx(el("span", "sm-head-sub"), "streamer.subtitle");
  const spacer = el("div", "sm-spacer");
  const aspect = selectBox("sm-aspect");
  tx(aspect.sel, "streamer.aspectAria", "aria-label");
  for (const a of ASPECTS) option(aspect.sel, a, ASPECT_LABEL[a]);
  aspect.sel.addEventListener("change", () => setAspect(aspect.sel.value));
  const safe = makeSwitch("sm-safe", "streamer.safeZones", safeZones, (on) => {
    safeZones = on;
    writeSafeZones();
    painted.scene = null;
  });
  const settings = button("sm-ib sm-settings");
  settings.append(icon(ICONS.gear, { size: 17 }));
  tx(settings, "streamer.settings", "aria-label");
  soon(settings);
  // Narrow workspaces fold the output panel into a drawer opened from here.
  const output = button("sm-ib sm-output-btn");
  output.append(icon(ICONS.output, { size: 16 }), tx(el("span"), "streamer.outputToggle"));
  output.setAttribute("aria-expanded", "false");
  output.setAttribute("aria-controls", "streamerSide");
  output.addEventListener("click", () => toggleDrawer());
  row.append(mark, title, sep, sub, spacer, aspect.wrap, safe.b, settings, output);

  const tabs = el("div", "sm-tabs");
  tabs.setAttribute("role", "tablist");
  tx(tabs, "streamer.tabsAria", "aria-label");
  const tabBtns = {};
  for (const id of TABS) {
    const b = button("sm-tab");
    b.setAttribute("role", "tab");
    b.id = `streamerTab-${id}`;
    b.dataset.tab = id;
    b.setAttribute("aria-controls", id === "builder" ? "streamerBuilderPanel" : "streamerOtherPanel");
    tx(b, TAB_LABEL[id]);
    b.addEventListener("click", () => setTab(id));
    tabBtns[id] = b;
    tabs.append(b);
  }
  tabs.addEventListener("keydown", (e) => {
    if (e.key !== "ArrowLeft" && e.key !== "ArrowRight") return;
    e.preventDefault();
    e.stopPropagation();
    const i = TABS.indexOf(tab) + (e.key === "ArrowRight" ? 1 : -1);
    const next = TABS[(i + TABS.length) % TABS.length];
    setTab(next);
    tabBtns[next].focus();
  });
  // Stop and Play / Pause: the footer's, which is hidden while Streamer is
  // open; beside the tabs, so every tab has them.
  const tport = el("div", "sm-transport");
  const stop = button("sm-tp-btn sm-stop");
  stop.append(icon(ICONS.stop, { size: 14 }));
  tx(stop, "streamer.stop", "label");
  stop.addEventListener("click", () => stopTransport());
  const play = button("sm-tp-btn sm-play");
  play.addEventListener("click", () => togglePlayPause());
  tport.append(stop, play);
  const tabsRow = el("div", "sm-tabs-row");
  tabsRow.append(tabs, tport);
  card.append(row, tabsRow);
  return { card, aspect: aspect.sel, safe, output, tabBtns, stop, play };
}

function buildBuilder() {
  const panel = el("div", "sm-builder");
  panel.id = "streamerBuilderPanel";
  panel.setAttribute("role", "tabpanel");
  panel.setAttribute("aria-labelledby", "streamerTab-builder");

  const row = el("div", "sm-row");
  const col = el("div", "sm-preview-col");

  // The preview: always 16:9 on screen, the scene inside it at its aspect.
  const preview = el("div", "sm-preview");
  const canvas = el("canvas", "sm-canvas");
  canvas.setAttribute("role", "img");
  tx(canvas, "streamer.previewAria", "aria-label");
  const rec = button("sm-rec");
  const pill = el("span", "sm-rec-pill");
  const ring = el("span", "sm-rec-ring");
  ring.append(el("span", "sm-rec-dot"));
  pill.append(ring, tx(el("span", "sm-rec-label"), "streamer.recReady"));
  const recTime = el("span", "sm-rec-time", clockHours(0));
  rec.append(pill, recTime);
  rec.setAttribute("aria-pressed", "false");
  tx(rec, "streamer.recStart", "aria-label");
  // TODO(phase 4): Record starts a take of the scene.
  soon(rec, "streamer.recSoon");
  preview.append(canvas, rec);

  const strip = el("div", "sm-strip");
  const stripTitle = el("div", "sm-card sm-strip-title");
  stripTitle.append(icon(ICONS.scissors, { size: 18, width: 1.9 }), tx(el("span"), "streamer.timeline"));
  const history = el("div", "sm-card sm-history");
  const undo = button("sm-history-btn");
  undo.append(icon(ICONS.undo, { size: 15, width: 2 }));
  tx(undo, "streamer.undo", "aria-label");
  const redo = button("sm-history-btn");
  redo.append(icon(ICONS.redo, { size: 15, width: 2 }));
  tx(redo, "streamer.redo", "aria-label");
  // TODO(phase 2): the scene's undo and redo.
  undo.disabled = true;
  redo.disabled = true;
  history.append(undo, redo);
  const clock = el("div", "sm-card sm-clock");
  const clockNow = el("span", "sm-clock-now", clockTenths(0));
  const clockDur = el("span", "sm-clock-dur", `/ ${clockTenths(0)}`);
  clock.append(clockNow, clockDur);
  strip.append(stripTitle, history, clock);
  col.append(preview, strip);

  const layers = buildLayersPanel();
  row.append(col, layers.panel);

  const timeline = buildTimeline();
  panel.append(row, timeline.card);
  return { panel, preview, canvas, rec, clockNow, clockDur, layers, timeline };
}

function buildLayersPanel() {
  const panel = el("div", "sm-card sm-layers");
  const head = el("div", "sm-layers-head");
  const add = button("sm-primary sm-add");
  add.append(icon(ICONS.plus, { size: 13, width: 2.6 }), tx(el("span"), "streamer.addLayer"));
  // TODO(phase 2): + Add Layer.
  soon(add);
  head.append(tx(el("h3", "sm-layers-title"), "streamer.layers"), add);
  const list = el("ul", "sm-layer-list");
  tx(list, "streamer.layers", "aria-label");
  panel.append(head, list);
  return { panel, list, rows: new Map() };
}

function buildTimeline() {
  const card = el("div", "sm-card sm-tl");
  const zoom = el("div", "sm-zoom");
  const zOut = button("sm-ib sm-zoom-btn");
  zOut.append(icon(ICONS.minus, { size: 12, width: 2.6 }));
  tx(zOut, "streamer.zoomOut", "aria-label");
  const zTrack = el("div", "sm-zoom-track");
  zTrack.append(el("div", "sm-zoom-fill"), el("div", "sm-zoom-thumb"));
  const zIn = button("sm-ib sm-zoom-btn");
  zIn.append(icon(ICONS.plus, { size: 12, width: 2.6 }));
  tx(zIn, "streamer.zoomIn", "aria-label");
  const fit = tx(button("sm-ib sm-fit"), "streamer.fit");
  // TODO(phase 2): zoom and Fit.
  for (const b of [zOut, zIn, fit]) soon(b);
  zoom.append(zOut, zTrack, zIn, fit);

  const markers = el("div", "sm-tl-markers");
  const ruler = el("div", "sm-tl-ruler");
  ruler.setAttribute("role", "slider");
  ruler.tabIndex = 0;
  ruler.setAttribute("aria-valuemin", "0");
  tx(ruler, "streamer.position", "aria-label");
  wireRuler(ruler);

  const videoLabel = el("div", "sm-tl-label sm-tl-label-video");
  videoLabel.append(icon(ICONS.film, { size: 14, width: 2 }), tx(el("span"), "streamer.trackVideo"));
  // TODO(phase 4): the take's camera thumbnails.
  const video = el("div", "sm-tl-video");
  video.append(el("span", "sm-tl-grip", "‹"), el("div", "sm-tl-video-body"), el("span", "sm-tl-grip", "›"));

  const audioLabels = el("div", "sm-tl-audio-labels");
  const audio = el("div", "sm-tl-audio");
  // TODO(phase 2): trim handles.
  audio.append(el("span", "sm-tl-trim sm-tl-trim-l", "‹"), el("span", "sm-tl-trim sm-tl-trim-r", "›"));
  const lanes = [];
  for (let i = 0; i < 2; i++) {
    const label = el("div", "sm-tl-label sm-tl-label-stem");
    const name = el("span");
    label.append(icon(ICONS.wave, { size: 14, width: 2 }), name);
    audioLabels.append(label);
    const c = el("canvas", "sm-tl-lane");
    audio.append(c);
    lanes.push({ label, name, canvas: c, stem: null });
  }

  const overlay = el("div", "sm-tl-overlay");
  const head = el("div", "sm-tl-playhead");
  const headTime = el("span", "sm-tl-playhead-time", clockTenths(0));
  head.append(headTime, el("span", "sm-tl-playhead-line"));
  overlay.append(head);

  card.append(zoom, markers, ruler, videoLabel, video, audioLabels, audio, overlay);
  return { card, markers, ruler, video, audio, lanes, head, headTime };
}

function wireRuler(ruler) {
  const seekAt = (clientX) => {
    if (!totalDuration) return;
    const r = ruler.getBoundingClientRect();
    setPlayheadTime(Math.max(0, Math.min(1, (clientX - r.left) / (r.width || 1))) * totalDuration);
  };
  ruler.addEventListener("pointerdown", (e) => {
    if (e.button !== 0) return;
    e.preventDefault();
    ruler.setPointerCapture(e.pointerId);
    seekAt(e.clientX);
    const move = (ev) => seekAt(ev.clientX);
    const up = () => {
      ruler.removeEventListener("pointermove", move);
      ruler.removeEventListener("pointerup", up);
      ruler.removeEventListener("pointercancel", up);
    };
    ruler.addEventListener("pointermove", move);
    ruler.addEventListener("pointerup", up);
    ruler.addEventListener("pointercancel", up);
  });
  ruler.addEventListener("keydown", (e) => {
    if (e.key !== "ArrowLeft" && e.key !== "ArrowRight") return;
    e.preventDefault();
    e.stopPropagation();
    setPlayheadTime(now() + (e.key === "ArrowLeft" ? -5 : 5));
  });
}

function buildSide() {
  const aside = el("aside", "sm-side");
  aside.id = "streamerSide";

  // Recording & Output. TODO(phase 3): devices, meter; TODO(phase 4): the
  // resolution, frame rate and switches go into the recording.
  const rec = el("section", "sm-card sm-out");
  const recHead = tx(el("h3", "sm-out-head"), "streamer.output");
  const body = el("div", "sm-out-body");
  const field = (labelKey, id, sel) => {
    const label = tx(el("label", "sm-flabel"), labelKey);
    label.htmlFor = id;
    sel.id = id;
    return label;
  };
  const vsrc = selectBox("", "webcam");
  option(vsrc.sel, "", "streamer.noCamera");
  const asrc = selectBox("", "mic");
  option(asrc.sel, "", "streamer.defaultInput");
  const meterRow = el("div", "sm-meter-row");
  const meter = el("div", "sm-meter");
  meter.setAttribute("role", "meter");
  meter.setAttribute("aria-valuemin", "-60");
  meter.setAttribute("aria-valuemax", "0");
  meter.setAttribute("aria-valuenow", "-60");
  tx(meter, "streamer.inputLevel", "aria-label");
  for (let r = 0; r < 2; r++) {
    const bar = el("div", "sm-meter-bar");
    for (let i = 0; i < 48; i++) bar.append(el("span", "sm-meter-seg"));
    meter.append(bar);
  }
  const level = el("span", "sm-meter-db", "-60 dB");
  const inSet = button("sm-ib sm-in-settings");
  inSet.append(icon(ICONS.gear, { size: 16 }));
  tx(inSet, "streamer.inputSettings", "aria-label");
  soon(inSet);
  meterRow.append(meter, level, inSet);
  const grid = el("div", "sm-out-grid");
  const res = selectBox();
  for (const [v, k] of [["1080", "streamer.res1080"], ["720", "streamer.res720"], ["2160", "streamer.res2160"]]) option(res.sel, v, k);
  const fps = selectBox();
  for (const n of [30, 60, 24]) {
    const o = el("option");
    o.value = String(n);
    o.dataset.fps = String(n);
    o.textContent = t("streamer.fpsValue", { n });
    fps.sel.append(o);
  }
  const resCol = el("div", "sm-out-col");
  resCol.append(field("streamer.resolution", "streamerRes", res.sel), res.wrap);
  const fpsCol = el("div", "sm-out-col");
  fpsCol.append(field("streamer.fps", "streamerFps", fps.sel), fps.wrap);
  grid.append(resCol, fpsCol);
  const switches = el("div", "sm-out-switches");
  for (const [k, on] of [["streamer.recMixed", true], ["streamer.recClick", false], ["streamer.recAutostop", true]]) {
    switches.append(makeSwitch("", k, on).b);
  }
  body.append(
    field("streamer.videoSource", "streamerVideoSrc", vsrc.sel), vsrc.wrap,
    field("streamer.audioSource", "streamerAudioSrc", asrc.sel), asrc.wrap,
    meterRow, grid, switches,
  );
  rec.append(recHead, body);

  // YouTube Export & Upload: a placeholder until upload exists.
  const yt = el("section", "sm-card sm-yt");
  const ytHead = el("div", "sm-yt-head");
  const ytLogo = el("span", "sm-yt-logo");
  const play = document.createElementNS(SVG_NS, "svg");
  play.setAttribute("width", "10");
  play.setAttribute("height", "10");
  play.setAttribute("viewBox", "0 0 10 10");
  play.setAttribute("aria-hidden", "true");
  const tri = document.createElementNS(SVG_NS, "path");
  tri.setAttribute("d", "M2.5 1.5v7l6-3.5z");
  tri.setAttribute("fill", "#ffffff");
  play.append(tri);
  ytLogo.append(play);
  ytHead.append(ytLogo, tx(el("h3", "sm-yt-title"), "streamer.yt"));
  const status = el("div", "sm-yt-status");
  const connect = tx(button("sm-primary sm-yt-connect"), "streamer.ytConnect");
  connect.addEventListener("click", (e) => {
    e.stopPropagation();
    flashNote(t("streamer.ytSoon"), connect);
  });
  status.append(el("span", "sm-yt-dot"), tx(el("span", "sm-yt-state"), "streamer.ytNotConnected"), connect);
  const titleIn = el("input", "sm-inp");
  titleIn.type = "text";
  titleIn.maxLength = 100;
  titleIn.addEventListener("input", () => { titleIn.dataset.edited = "1"; });
  const desc = el("textarea", "sm-inp sm-yt-desc");
  desc.rows = 3;
  desc.maxLength = 5000;
  tx(desc, "streamer.ytDescPlaceholder", "placeholder");
  const count = el("span", "sm-yt-count", "0/5000");
  desc.addEventListener("input", () => { count.textContent = `${desc.value.length}/5000`; });
  const vis = selectBox("sm-yt-vis");
  for (const [v, k] of [["private", "streamer.ytPrivate"], ["unlisted", "streamer.ytUnlisted"], ["public", "streamer.ytPublic"]]) option(vis.sel, v, k);
  const ytSwitches = [makeSwitch("", "streamer.ytUploadAfter", false).b, makeSwitch("", "streamer.ytPlaylist", false).b];
  const exportBtn = button("sm-primary sm-yt-export");
  exportBtn.append(icon(ICONS.upload, { size: 15, width: 2.2 }), tx(el("span"), "streamer.ytExport"));
  // TODO(phase 4): export through the server. Does nothing yet.
  exportBtn.setAttribute("aria-disabled", "true");
  tx(exportBtn, "streamer.ytSoon", "title");
  yt.append(
    ytHead, status,
    field("streamer.ytTitle", "streamerYtTitle", titleIn), titleIn,
    field("streamer.ytDesc", "streamerYtDesc", desc), desc, count,
    field("streamer.ytVisibility", "streamerYtVis", vis.sel), vis.wrap,
    ...ytSwitches, el("div", "sm-spacer"), exportBtn,
  );

  aside.append(rec, yt);
  return { aside, fps: fps.sel, titleIn };
}

function relabel() {
  for (const [node, key, attr] of texts) setText(node, key, attr);
  if (railBtn) {
    railBtn.title = t("streamer.rail");
    railBtn.setAttribute("aria-label", t("streamer.rail"));
  }
  if (!ui) return;
  for (const o of ui.side.fps.options) o.textContent = t("streamer.fpsValue", { n: o.dataset.fps });
  ui.otherTitle.textContent = t(TAB_LABEL[tab]);
  for (const row of ui.builder.layers.rows.values()) texts = texts.filter(([n]) => !row.li.contains(n));
  ui.builder.layers.rows.clear();
  ui.builder.layers.list.replaceChildren();
  for (const k of Object.keys(painted)) delete painted[k];
}

// ── Tabs, aspect, safe zones, drawer ──

function setTab(id) {
  if (!TABS.includes(id)) return;
  tab = id;
  paintTabs();
  painted.scene = null;
}

function paintTabs() {
  if (!ui) return;
  for (const [id, b] of Object.entries(ui.head.tabBtns)) {
    const on = id === tab;
    b.setAttribute("aria-selected", String(on));
    b.tabIndex = on ? 0 : -1;
  }
  ui.builder.panel.hidden = tab !== "builder";
  ui.other.hidden = tab === "builder";
  ui.other.setAttribute("aria-labelledby", `streamerTab-${tab}`);
  ui.otherTitle.textContent = t(TAB_LABEL[tab]);
}

function paintSafe() {
  ui?.head.safe.set(safeZones);
}

function setAspect(aspect) {
  if (!ASPECTS.includes(aspect) || aspect === scene.aspect) return;
  scene = withAspect(scene, aspect);
  saveScene(sceneJob, scene);
  painted.scene = null;
}

function toggleDrawer(force) {
  if (!ui) return;
  const on = typeof force === "boolean" ? force : !root.classList.contains("sm-drawer-open");
  root.classList.toggle("sm-drawer-open", on);
  ui.head.output.setAttribute("aria-expanded", String(on));
}

// ── State reads (the player's own; never copied) ──

function now() {
  const v = transport()?.getCurrentTime?.();
  return Number.isFinite(v) ? v : 0;
}

function trackMeta() {
  const title = document.getElementById("title")?.textContent?.trim() || "";
  const artistEl = document.getElementById("np-artist");
  const artist = artistEl && !artistEl.hidden ? artistEl.textContent.trim() : "";
  const img = document.getElementById("np-thumb");
  const art = img && img.getAttribute("src") && !img.hidden && img.naturalWidth > 0 ? img : null;
  // An em dash is the header's title while no song is open.
  return { title: title === "\u2014" ? "" : title, artist, art };
}

/** The stems heard now: not muted, and soloed when any lane is. */
function audibleStems() {
  const names = Object.keys(trackIndex || {}).filter((n) => mixerState[n]);
  const solo = names.some((n) => mixerState[n].soloed);
  return names.filter((n) => (solo ? mixerState[n].soloed : !mixerState[n].muted));
}

// ── Scene per song ──

async function showSceneFor(job) {
  const token = ++sceneToken;
  if (sceneJob && sceneJob !== job) await flushScene(sceneJob);
  const next = await loadScene(job);
  if (token !== sceneToken) return;
  scene = next;
  sceneJob = job;
  if (ui) ui.head.aspect.value = scene.aspect;
  if (!scene.layers.some((l) => l.id === selected)) selected = scene.layers[scene.layers.length - 1]?.id ?? null;
  painted.scene = null;
  painted.layers = null;
}

function setLayerVisible(id, visible) {
  scene = withLayerVisible(scene, id, visible);
  saveScene(sceneJob, scene);
  painted.scene = null;
  painted.layers = null;
}

function selectLayer(id) {
  selected = id;
  painted.scene = null;
  painted.layers = null;
}

// ── Lyrics ──

async function loadLyrics() {
  const info = getCurrentTrackInfo();
  const token = ++lyrToken;
  lyr = { trackId: info?.id ?? null, lines: [] };
  if (!info) return;
  try {
    const res = await karaokeLyrics(info);
    if (token !== lyrToken) return;
    lyr = { trackId: info.id, lines: sungLines(res.lines) };
  } catch (err) {
    console.warn("[streamer] reading the lyrics failed:", err);
  }
  painted.scene = null;
  painted.layers = null;
}

// ── Open / close ──

/** Open Streamer Mode. Refused (returns false) while a take records: its own
 * saved mix would change what is being recorded against. */
export function openStreamer() {
  if (open) return true;
  if (isRecording()) {
    flashNote(t("streamer.stopRecordingFirst"), railBtn);
    return false;
  }
  if (!ui && !buildView()) return false;
  // One workspace view at a time.
  if (isKaraokeOpen()) closeKaraoke();
  open = true;
  root.hidden = false;
  document.documentElement.classList.add("streamer-open");
  for (const id of ["lanes", "master-drawer"]) document.getElementById(id)?.setAttribute("inert", "");
  placeLayer();
  window.addEventListener("resize", placeLayer);
  observeLayout();
  window.addEventListener("keydown", onKey, true);
  for (const k of Object.keys(painted)) delete painted[k];
  shownJob = undefined;
  paintRail();
  loop();
  notify();
  return true;
}

export function closeStreamer() {
  if (!open) return;
  open = false;
  toggleDrawer(false);
  root.hidden = true;
  document.documentElement.classList.remove("streamer-open");
  // Karaoke may have opened over the lanes this moment: its inert stays.
  if (!isKaraokeOpen()) {
    for (const id of ["lanes", "master-drawer"]) document.getElementById(id)?.removeAttribute("inert");
  }
  window.removeEventListener("resize", placeLayer);
  layerObserver?.disconnect();
  window.removeEventListener("keydown", onKey, true);
  cancelAnimationFrame(raf);
  raf = 0;
  flushScene(sceneJob);
  paintRail();
  notify();
}

export function toggleStreamer() {
  if (open) closeStreamer();
  else openStreamer();
}

export function isStreamerOpen() {
  return open;
}

/** Called with the new open state whenever it changes (the Mode menu). */
export function onStreamerChange(cb) {
  listeners.add(cb);
  return () => listeners.delete(cb);
}

function notify() {
  // The saved mix in force is Streamer's while it is open (mixMode.js).
  document.dispatchEvent(new CustomEvent("stemdeck:streamer-changed", { detail: { open } }));
  for (const cb of listeners) {
    try { cb(open); } catch (err) { console.warn("[streamer] change listener failed:", err); }
  }
}

function paintRail() {
  if (!railBtn) return;
  railBtn.classList.toggle("active", open);
  railBtn.setAttribute("aria-pressed", String(open));
}

let noteTimer = 0;
/** A short note beside `anchor` (the rail button when none), gone by itself. */
function flashNote(text, anchor) {
  let note = document.getElementById("streamerNote");
  if (!note) {
    note = el("div", "sm-note");
    note.id = "streamerNote";
    note.setAttribute("role", "status");
    document.body.append(note);
  }
  note.textContent = text;
  note.hidden = false;
  const r = (anchor || railBtn)?.getBoundingClientRect();
  if (r) {
    const w = note.offsetWidth;
    const beside = anchor === railBtn || !anchor;
    const left = beside ? r.right + 8 : Math.min(window.innerWidth - w - 8, Math.max(8, r.left + r.width / 2 - w / 2));
    const top = beside ? r.top : r.bottom + 8 + note.offsetHeight > window.innerHeight ? r.top - note.offsetHeight - 8 : r.bottom + 8;
    note.style.left = `${Math.round(left)}px`;
    note.style.top = `${Math.round(top)}px`;
  }
  clearTimeout(noteTimer);
  noteTimer = setTimeout(() => { note.hidden = true; }, 3500);
}

// The layer covers the lanes, the master drawer and the footer (hidden while
// open): from the top of #lanes to the bottom of their column, as wide as #lanes.
const layerObserver = typeof ResizeObserver === "function" ? new ResizeObserver(() => placeLayer()) : null;

function observeLayout() {
  if (!layerObserver) return;
  const lanes = document.getElementById("lanes");
  if (lanes) layerObserver.observe(lanes);
  const col = lanes?.closest(".daw-main-col");
  if (col) layerObserver.observe(col);
}

function placeLayer() {
  if (!open || !root) return;
  const lanes = document.getElementById("lanes");
  if (!lanes) return;
  const a = lanes.getBoundingClientRect();
  const bottom = (lanes.closest(".daw-main-col") || lanes).getBoundingClientRect().bottom;
  root.style.left = `${Math.round(a.left)}px`;
  root.style.top = `${Math.round(a.top)}px`;
  root.style.width = `${Math.round(a.width)}px`;
  root.style.height = `${Math.max(0, Math.round(bottom - a.top))}px`;
}

// ── The frame ──

function loop() {
  raf = 0;
  if (!open) return;
  try {
    frame();
  } catch (err) {
    console.warn("[streamer] frame failed:", err);
  }
  raf = requestAnimationFrame(loop);
}

function frame() {
  const job = currentJobId;
  if (job !== shownJob) {
    shownJob = job;
    for (const k of Object.keys(painted)) delete painted[k];
    loadLyrics();
    if (job) showSceneFor(job);
    // A title typed for the last song is not this one's.
    delete ui.side.titleIn.dataset.edited;
  }
  const hasTrack = Boolean(job && transport() && totalDuration > 0);
  if (painted.hasTrack !== hasTrack) {
    painted.hasTrack = hasTrack;
    root.classList.toggle("sm-empty-view", !hasTrack);
    ui.noTrack.hidden = hasTrack;
  }
  const tNow = hasTrack ? now() : 0;
  const meta = trackMeta();
  paintYoutubeTitle(meta);
  paintTransport(hasTrack);
  if (tab !== "builder") return;
  const lyrics = lyricWindow(lyr.lines, tNow, 5);
  paintLayers(meta, lyrics);
  paintPreview(tNow, meta, lyrics);
  paintClock(tNow);
  paintTimeline(tNow);
}

function paintTransport(hasTrack) {
  const playing = Boolean(hasTrack && transport()?.isPlaying?.());
  const sig = `${playing}|${hasTrack}|${t("streamer.play")}`;
  if (painted.transport === sig) return;
  painted.transport = sig;
  const { play, stop } = ui.head;
  play.replaceChildren(icon(playing ? ICONS.pause : ICONS.play, { size: 16 }));
  const label = t(playing ? "streamer.pause" : "streamer.play");
  play.setAttribute("aria-label", label);
  play.title = label;
  play.disabled = !hasTrack;
  stop.disabled = !hasTrack;
}

function paintYoutubeTitle(meta) {
  const input = ui.side.titleIn;
  if (input.dataset.edited === "1") return;
  const v = meta.title ? (meta.artist ? t("streamer.ytDefaultTitle", { title: meta.title, artist: meta.artist }) : meta.title) : "";
  if (input.value !== v) input.value = v;
}

// ── Preview ──

function waveBars() {
  const src = overviewPeaks();
  const names = audibleStems();
  const layer = scene.layers.find((l) => l.type === "waveform");
  const n = layer?.props?.bars || 34;
  const sig = `${src ? src.data && Object.keys(src.data).length : 0}|${names.join(",")}|${n}`;
  if (painted.barsSig !== sig || painted.barsSrc !== src) {
    painted.barsSig = sig;
    painted.barsSrc = src;
    painted.bars = src?.data ? peakBars(src.data, names, n) : null;
  }
  return painted.bars;
}

function paintPreview(tNow, meta, lyrics) {
  const { preview, canvas, rec } = ui.builder;
  const cw = preview.clientWidth;
  const ch = preview.clientHeight;
  if (!cw || !ch) return;
  const dpr = Math.min(2, window.devicePixelRatio || 1);
  const bars = waveBars();
  const lyricSig = lyrics.map((l) => `${l.role}:${l.text}`).join("|");
  // Played bars move with time; a still frame redraws only on a change.
  const played = Math.floor((totalDuration ? tNow / totalDuration : 0) * (bars?.length || 34));
  const sig = [cw, ch, dpr, scene.aspect, safeZones, selected, meta.title, meta.artist, meta.art?.currentSrc || "", lyricSig, played, painted.barsSig, totalDuration].join("§");
  if (painted.scene === sig) return;
  painted.scene = sig;
  if (canvas.width !== Math.round(cw * dpr) || canvas.height !== Math.round(ch * dpr)) {
    canvas.width = Math.round(cw * dpr);
    canvas.height = Math.round(ch * dpr);
  }
  const ctx = ui.ctx;
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.fillStyle = "#000000";
  ctx.fillRect(0, 0, cw, ch);
  const f = fitAspect(cw, ch, scene.aspect);
  ctx.save();
  ctx.translate(f.x, f.y);
  ctx.beginPath();
  ctx.rect(0, 0, f.w, f.h);
  ctx.clip();
  renderScene(ctx, scene, {
    t: tNow,
    duration: totalDuration || 0,
    title: meta.title,
    artist: meta.artist,
    art: meta.art,
    camera: null, // TODO(phase 3): the camera's <video>.
    lyrics,
    bars,
  }, {
    width: f.w,
    height: f.h,
    font: ui.font,
    accent: ui.accent,
    accentDim: "rgba(244,183,64,.55)",
    labels: {
      handle: t("streamer.lowerHandle"),
      subtitle: t("streamer.lowerSub"),
      noLyrics: t("streamer.sub.noLyrics"),
      camera: t("streamer.cameraPlaceholder"),
      actionSafe: t("streamer.actionSafe"),
      titleSafe: t("streamer.titleSafe"),
    },
    editor: { selection: selected, safeZones },
  });
  ctx.restore();
  // The REC badge sits on the scene's own top left corner.
  rec.style.left = `${Math.round(f.x + 10)}px`;
  rec.style.top = `${Math.round(f.y + 10)}px`;
}

function paintClock(tNow) {
  const a = clockTenths(tNow);
  if (painted.clock !== a) {
    painted.clock = a;
    ui.builder.clockNow.textContent = a;
    ui.builder.timeline.headTime.textContent = a;
  }
  const d = `/ ${clockTenths(totalDuration || 0)}`;
  if (painted.clockDur !== d) {
    painted.clockDur = d;
    ui.builder.clockDur.textContent = d;
  }
}

// ── Layers panel ──

function layerSub(layer, meta, lyrics) {
  switch (layer.type) {
    case "camera": return t("streamer.sub.cameraNone");
    case "title": return [meta.title, meta.artist].filter(Boolean).join("\n") || t("streamer.sub.noSong");
    case "lyrics": {
      if (!lyrics.length) return t("streamer.sub.noLyrics");
      return lyrics.slice(0, 2).map((l) => l.text).join("\n");
    }
    case "waveform": return t("streamer.sub.waveform");
    case "lowerThird": return `${layer.props?.handle || t("streamer.lowerHandle")}  |  ${layer.props?.subtitle || t("streamer.lowerSub")}`;
    case "albumArt": return t("streamer.sub.albumArt");
    case "background": return t("streamer.sub.background");
    default: return "";
  }
}

/** The panel lists the front layer first (the scene's array is back to front). */
function paintLayers(meta, lyrics) {
  const L = ui.builder.layers;
  const order = [...scene.layers].reverse();
  const sig = order.map((l) => `${l.id}:${l.visible ? 1 : 0}:${layerSub(l, meta, lyrics)}`).join("|") + `|${selected}|${meta.art?.currentSrc || ""}`;
  if (painted.layers === sig) return;
  painted.layers = sig;
  const ids = order.map((l) => l.id).join("|");
  if (painted.layerIds !== ids) {
    painted.layerIds = ids;
    // The old rows' texts go with them.
    for (const row of L.rows.values()) texts = texts.filter(([n]) => !row.li.contains(n));
    L.rows.clear();
    L.list.replaceChildren(...order.map((l) => layerRow(l)));
  }
  for (const layer of order) {
    const row = L.rows.get(layer.id);
    if (!row) continue;
    const name = t(LAYER_NAME[layer.type] || "streamer.layers");
    row.li.classList.toggle("selected", layer.id === selected);
    row.li.classList.toggle("off", !layer.visible);
    row.pick.setAttribute("aria-pressed", String(layer.id === selected));
    row.name.textContent = name;
    const sub = layerSub(layer, meta, lyrics);
    if (row.sub.textContent !== sub) row.sub.textContent = sub;
    row.sw.set(layer.visible);
    row.sw.b.setAttribute("aria-label", t(layer.visible ? "streamer.layerShown" : "streamer.layerHidden", { name }));
    if (row.art) {
      const src = meta.art?.currentSrc || meta.art?.src || "";
      if (src) {
        if (row.art.getAttribute("src") !== src) row.art.src = src;
        row.art.hidden = false;
      } else {
        row.art.removeAttribute("src");
        row.art.hidden = true;
      }
    }
  }
}

function layerRow(layer) {
  const li = el("li", "sm-layer");
  li.dataset.layer = layer.id;
  const grip = el("span", "sm-layer-grip");
  grip.setAttribute("aria-hidden", "true");
  grip.append(icon(ICONS.grip, { size: 13 }));
  const pick = button("sm-layer-pick");
  const thumb = el("span", `sm-layer-thumb sm-thumb-${layer.type}`);
  let art = null;
  if (layer.type === "title" || layer.type === "albumArt") {
    art = el("img", "sm-thumb-art");
    art.alt = "";
    art.referrerPolicy = "no-referrer";
    art.hidden = true;
    thumb.append(art);
  } else {
    thumb.append(icon(ICONS[LAYER_ICON[layer.type] || "image"], { size: 20, width: 2 }));
  }
  const words = el("span", "sm-layer-texts");
  const name = el("span", "sm-layer-name");
  const sub = el("span", "sm-layer-sub");
  words.append(name, sub);
  pick.append(thumb, words);
  pick.addEventListener("click", () => selectLayer(layer.id));
  const sw = makeSwitch("sm-layer-switch", null, layer.visible, (on) => setLayerVisible(layer.id, on));
  const kebab = button("sm-layer-kebab");
  kebab.append(icon(ICONS.kebab, { size: 16 }));
  tx(kebab, "streamer.layerOptions", "aria-label");
  // TODO(phase 2): Rename, Duplicate, Edit, Delete.
  soon(kebab);
  li.append(grip, pick, sw.b, kebab);
  ui.builder.layers.rows.set(layer.id, { li, pick, name, sub, sw, art });
  return li;
}

// ── Take timeline ──

function laneStems() {
  const present = Object.keys(trackIndex || {});
  const out = [];
  const voice = ["lead_vocals", "vocals"].find((n) => present.includes(n));
  if (voice) out.push(voice);
  if (present.includes("bass")) out.push("bass");
  for (const n of present) {
    if (out.length >= 2) break;
    if (!out.includes(n)) out.push(n);
  }
  return out.slice(0, 2);
}

function paintTimeline(tNow) {
  const tl = ui.builder.timeline;
  const dur = totalDuration || 0;
  const pct = (x) => (dur ? Math.max(0, Math.min(100, (x / dur) * 100)) : 0);
  tl.head.style.left = `${pct(tNow)}%`;
  const ruler = tl.ruler;
  const tInt = String(Math.floor(tNow));
  if (painted.rulerNow !== tInt) {
    painted.rulerNow = tInt;
    ruler.setAttribute("aria-valuenow", tInt);
    ruler.setAttribute("aria-valuetext", clockTenths(tNow));
  }

  // Ruler ticks and section markers: on a new song, length or set of sections.
  const sections = getSections();
  const secSig = `${dur}|${sections.map((s) => `${s.id}:${s.start}:${s.color}:${s.kind || ""}:${s.name || ""}`).join(",")}|${t("streamer.jumpTo")}`;
  if (painted.sections !== secSig) {
    painted.sections = secSig;
    ruler.setAttribute("aria-valuemax", String(Math.floor(dur)));
    ruler.replaceChildren(...rulerTicks(dur, 8).flatMap((tk, i, all) => {
      const label = el("span", "sm-tick-label", tk.label);
      label.style.left = `${pct(tk.t)}%`;
      if (i === 0) label.classList.add("first");
      else if (i === all.length - 1 && pct(tk.t) > 94) label.classList.add("last");
      const mark = el("span", "sm-tick");
      mark.style.left = `${pct(tk.t)}%`;
      return [label, mark];
    }));
    tl.markers.replaceChildren(...sections.flatMap((s) => {
      const name = sectionDisplayName(s, sections);
      const at = clockTenths(s.start).slice(0, 5);
      const b = button("sm-marker");
      b.style.left = `${pct(s.start)}%`;
      b.style.setProperty("--sm-sec", s.color || "#4a7fff");
      b.setAttribute("aria-label", t("streamer.jumpTo", { name, time: at }));
      const label = el("span", "sm-marker-text");
      label.append(el("span", "sm-marker-name", name), el("span", "sm-marker-time", at));
      b.append(el("span", "sm-marker-pin"), label);
      b.addEventListener("click", () => setPlayheadTime(s.start));
      const stem = el("span", "sm-marker-stem");
      stem.style.left = `${pct(s.start)}%`;
      stem.style.setProperty("--sm-sec", s.color || "#4a7fff");
      return [b, stem];
    }));
  }

  // Stem lanes: on a new song, peaks, or size.
  const src = overviewPeaks();
  const stems = laneStems();
  const w = tl.audio.clientWidth;
  const h = tl.audio.clientHeight;
  const laneSig = `${stems.join(",")}|${w}x${h}`;
  if (painted.lanes !== laneSig || painted.lanesSrc !== src) {
    painted.lanes = laneSig;
    painted.lanesSrc = src;
    tl.lanes.forEach((lane, i) => drawLane(lane, stems[i] || null, src));
  }
}

function drawLane(lane, stem, src) {
  lane.stem = stem;
  lane.label.hidden = !stem;
  lane.name.textContent = stem ? laneLabel(stem) : "";
  const color = (stem && STEM_COLORS[stem]) || "#9aa3ad";
  lane.label.style.setProperty("--sm-lane", color);
  const c = lane.canvas;
  const w = c.clientWidth;
  const h = c.clientHeight;
  if (!w || !h) return;
  const dpr = Math.min(2, window.devicePixelRatio || 1);
  c.width = Math.round(w * dpr);
  c.height = Math.round(h * dpr);
  const ctx = c.getContext("2d");
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.clearRect(0, 0, w, h);
  if (!stem || !src?.data?.[stem]) return;
  const n = Math.max(1, Math.floor(w / 3));
  const bars = peakBars(src.data, [stem], n);
  const step = w / n;
  ctx.fillStyle = color;
  for (let i = 0; i < n; i++) {
    const bh = Math.min(h, ((3 + bars[i] * 20) / 26) * h);
    ctx.fillRect(i * step, (h - bh) / 2, Math.max(1, step - 1), bh);
  }
}

// ── Keys (only while Streamer Mode is open) ──

function onKey(e) {
  if (!open || e.defaultPrevented || e.ctrlKey || e.metaKey || e.altKey) return;
  // Space or Enter on one of this view's own controls presses that control
  // only: the studio's Space would also start or stop playback.
  if ((e.code === "Space" || e.key === "Enter") && e.target instanceof Element
      && e.target.closest("#streamer button, #streamer select, #streamer [role=switch], #streamer [role=slider]")) {
    e.stopPropagation();
  } else if (e.key === "Escape" && root.classList.contains("sm-drawer-open")) {
    e.preventDefault();
    e.stopPropagation();
    toggleDrawer(false);
    ui.head.output.focus({ preventScroll: true });
  }
}

// ── Init ──

export function initStreamer() {
  railBtn = document.getElementById("streamerBtn");
  railBtn?.addEventListener("click", () => toggleStreamer());
  paintRail();
  // Karaoke opened (its rail button, the Mode menu): one view at a time.
  document.addEventListener("stemdeck:karaoke-changed", (e) => {
    if (e.detail?.open && open) closeStreamer();
  });
  document.addEventListener("stemdeck:lyrics-changed", (e) => {
    if (open && e.detail?.id && e.detail.id === lyr.trackId) loadLyrics();
  });
  window.addEventListener("pagehide", () => { flushScene(sceneJob); });
  onLanguageChange(() => relabel());
  if (railBtn) {
    railBtn.title = t("streamer.rail");
    railBtn.setAttribute("aria-label", t("streamer.rail"));
  }
}
