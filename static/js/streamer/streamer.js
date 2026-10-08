// Streamer Mode: a workspace view over the studio, entered from the rail's
// Streamer button (or the Mode menu), for building a performance video: a
// scene of layers (camera, song title, lyrics, waveform, lower third, album
// art, background, text, image) drawn over the song as it plays, a take
// timeline, and the recording and output settings.
//
// Like Karaoke Mode (karaoke/karaoke.js), it is a view, not a second player:
// the time, the song and the mix are the studio's own (transport(),
// setPlayheadTime, state.js), read each frame by one animation loop that runs
// only while the view is open. As in Karaoke, the app's footer is hidden
// while it is open (streamer.css) and the view covers its place; Stop and
// Play / Pause sit beside the tabs, and Space still plays.
//
// The scene is Streamer's own, kept per song (sceneStore.js), edited only
// through the pure functions of streamerModel.js (one undo step per edit, a
// drag is one step), and drawn by one renderer (sceneRenderer.js) that will
// also draw the recorded frames.
//
// Phases 1 and 2 of docs/plans/0.21.0/streamer-mode.md: the shell, the
// preview, the layers (select, move, resize, reorder, add, duplicate,
// rename, properties, delete, undo) and the take timeline (zoom, seek, trim).
// The devices, recording and export come in phases 3 and 4.

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
  ASPECTS, ADDABLE_TYPES, TEXT_COLORS, TEXT_SIZE_MIN, TEXT_SIZE_MAX, LYRIC_LINES_MIN, LYRIC_LINES_MAX, NAME_MAX,
  defaultScene, withAspect, withLayerVisible, fitAspect,
  lyricWindow, peakBars, clockTenths, clockHours,
  layerRules, newLayerId, addLayer, duplicateLayer, deleteLayer, reorderLayer, renameLayer, setLayerProps,
  setLayerFrame, nudgeLayer, moveFrame, resizeFrame, layerAt,
  emptyHistory, pushHistory, undoHistory, redoHistory,
  trimRange, snapTime, withTrimPoint, pixelsPerSecond, tickStep, ticksEvery,
} from "./streamerModel.js";
import { loadScene, saveScene, flushScene } from "./sceneStore.js";
import {
  SETTINGS_KEY, NONE, defaultRecordingSettings, parseRecordingSettings, serializeRecordingSettings,
  resolveDeviceId, isHeavy, METER_SEGMENTS, METER_FLOOR_DB, meterFraction, levelDb, segmentZone,
  litSegments, holdPeak, newPeakState,
} from "./outputSettings.js";
import {
  startDevices, stopDevices, allowDevices, retryDevice, reconcile, cameraSource, cameraState,
  inputState, inputLevel, deviceLists, onDevicesChange, getStreamerMedia,
} from "./streamerDevices.js";
import { reasonMessage } from "../capture/capturePermission.js";
import { friendlyName } from "../capture/trackInputs.js";
import { openRecordingSettings } from "../capture/recordingSettings.js";
import { storeGet, storeSet } from "../utils.js";
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
  text: "streamer.layer.text",
  image: "streamer.layer.image",
};
// The header's title while no song is open.
const NO_TITLE = String.fromCharCode(0x2014);
// Snapping reach on screen, and the timeline's zoom step.
const SNAP_PX = 6;
const ZOOM_STEP = 0.1;
const LABEL_COL = 90; // the timeline's label column and its gap

let root = null;
let railBtn = null;
let open = false;
let raf = 0;
const listeners = new Set();

// The open song's scene, the song it belongs to (null until loaded), and its
// undo history (per song, gone when the song changes).
let scene = defaultScene();
let sceneJob = null;
let sceneToken = 0;
let history = emptyHistory();
let selected = "title";
let tab = "builder";
let safeZones = readSafeZones();
// The recording lock (phase 4 sets it): no adding, deleting or reordering.
let locked = false;
// The recording and output settings, per user (outputSettings.js).
let settings = defaultRecordingSettings();
// The take timeline's zoom (0 = the whole song), and a time to centre on
// once the new zoom is laid out.
let zoom = 0;
let zoomAnchor = null;

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
const LAYER_ICON = { camera: "camera", lyrics: "text", waveform: "wave", lowerThird: "lower", background: "image", text: "text", image: "image" };

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

const layerName = (layer) => layer?.name || t(LAYER_NAME[layer?.type] || "streamer.layers");

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
  paintHistory();
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
  // It takes focus (for the arrow keys and Delete) and is where layers are
  // picked, moved and resized.
  const preview = el("div", "sm-preview");
  preview.tabIndex = 0;
  tx(preview, "streamer.previewHint", "aria-label");
  const canvas = el("canvas", "sm-canvas");
  canvas.setAttribute("aria-hidden", "true");
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
  // The selected layer's box: drag it to move, drag a corner to resize.
  const selbox = el("div", "sm-selbox");
  selbox.hidden = true;
  for (const c of ["nw", "ne", "sw", "se"]) {
    const h = el("span", `sm-handle sm-handle-${c}`);
    h.dataset.corner = c;
    selbox.append(h);
  }
  // Why the camera is not showing, over the preview, with Allow or Retry.
  const camState = el("div", "sm-cam-state");
  camState.hidden = true;
  camState.setAttribute("role", "status");
  const camText = el("p", "sm-cam-text");
  const camAct = button("sm-primary sm-cam-act");
  camAct.addEventListener("click", (e) => {
    e.stopPropagation();
    deviceAction("video");
  });
  camState.append(camText, camAct);
  preview.append(canvas, selbox, camState, rec);
  wirePreview(preview, rec);

  const strip = el("div", "sm-strip");
  const stripTitle = el("div", "sm-card sm-strip-title");
  stripTitle.append(icon(ICONS.scissors, { size: 18, width: 1.9 }), tx(el("span"), "streamer.timeline"));
  const hist = el("div", "sm-card sm-history");
  const undo = button("sm-history-btn sm-undo");
  undo.append(icon(ICONS.undo, { size: 15, width: 2 }));
  tx(undo, "streamer.undo", "label");
  undo.addEventListener("click", () => doUndo());
  const redo = button("sm-history-btn sm-redo");
  redo.append(icon(ICONS.redo, { size: 15, width: 2 }));
  tx(redo, "streamer.redo", "label");
  redo.addEventListener("click", () => doRedo());
  hist.append(undo, redo);
  const clock = el("div", "sm-card sm-clock");
  const clockNow = el("span", "sm-clock-now", clockTenths(0));
  const clockDur = el("span", "sm-clock-dur", `/ ${clockTenths(0)}`);
  clock.append(clockNow, clockDur);
  strip.append(stripTitle, hist, clock);
  col.append(preview, strip);

  const layers = buildLayersPanel();
  row.append(col, layers.panel);

  const timeline = buildTimeline();
  panel.append(row, timeline.card);
  return { panel, preview, canvas, rec, selbox, camState, camText, camAct, clockNow, clockDur, undo, redo, layers, timeline };
}

function buildLayersPanel() {
  const panel = el("div", "sm-card sm-layers");
  const head = el("div", "sm-layers-head");
  const add = button("sm-primary sm-add");
  add.append(icon(ICONS.plus, { size: 13, width: 2.6 }), tx(el("span"), "streamer.addLayer"));
  add.setAttribute("aria-haspopup", "menu");
  add.addEventListener("click", (e) => {
    e.stopPropagation();
    openAddMenu(add);
  });
  head.append(tx(el("h3", "sm-layers-title"), "streamer.layers"), add);
  const list = el("ul", "sm-layer-list");
  tx(list, "streamer.layers", "aria-label");
  panel.append(head, list);
  return { panel, list, add, rows: new Map() };
}

function buildTimeline() {
  const card = el("div", "sm-card sm-tl");
  const zoomBox = el("div", "sm-zoom");
  const zOut = button("sm-ib sm-zoom-btn sm-zoom-out");
  zOut.append(icon(ICONS.minus, { size: 12, width: 2.6 }));
  tx(zOut, "streamer.zoomOut", "label");
  zOut.addEventListener("click", () => setZoom(zoom - ZOOM_STEP));
  const zTrack = el("div", "sm-zoom-track");
  zTrack.setAttribute("role", "slider");
  zTrack.tabIndex = 0;
  zTrack.setAttribute("aria-valuemin", "0");
  zTrack.setAttribute("aria-valuemax", "100");
  tx(zTrack, "streamer.zoom", "aria-label");
  const zFill = el("div", "sm-zoom-fill");
  const zThumb = el("div", "sm-zoom-thumb");
  zTrack.append(zFill, zThumb);
  wireZoomSlider(zTrack);
  const zIn = button("sm-ib sm-zoom-btn sm-zoom-in");
  zIn.append(icon(ICONS.plus, { size: 12, width: 2.6 }));
  tx(zIn, "streamer.zoomIn", "label");
  zIn.addEventListener("click", () => setZoom(zoom + ZOOM_STEP));
  const fit = tx(button("sm-ib sm-fit"), "streamer.fit");
  fit.addEventListener("click", () => setZoom(0));
  zoomBox.append(zOut, zTrack, zIn, fit);

  // One scrolling grid: a label column that stays put (sticky) and the
  // song's column, as wide as the zoom makes it. Everything in the song's
  // column (markers, ruler, lanes, trim, playhead) is placed from one scale.
  const scroll = el("div", "sm-tl-scroll");
  const grid = el("div", "sm-tl-grid");
  const mask = el("div", "sm-tl-mask");

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
  const lanes = [];
  for (let i = 0; i < 2; i++) {
    const label = el("div", "sm-tl-label sm-tl-label-stem");
    const name = el("span");
    label.append(icon(ICONS.wave, { size: 14, width: 2 }), name);
    audioLabels.append(label);
    const c = el("canvas", `sm-tl-lane sm-tl-lane-${i}`);
    audio.append(c);
    lanes.push({ label, name, canvas: c, stem: null });
  }
  // The kept range: a yellow box with an in and an out handle; what is
  // trimmed off is dimmed.
  const range = el("div", "sm-tl-range");
  const trimIn = el("span", "sm-tl-trim sm-tl-trim-l", "‹");
  const trimOut = el("span", "sm-tl-trim sm-tl-trim-r", "›");
  for (const [h, which, key] of [[trimIn, "in", "streamer.trimInAria"], [trimOut, "out", "streamer.trimOutAria"]]) {
    h.dataset.which = which;
    h.setAttribute("role", "slider");
    h.tabIndex = 0;
    tx(h, key, "aria-label");
    wireTrimHandle(h, which);
  }
  range.append(trimIn, trimOut);
  audio.append(range);
  const dims = el("div", "sm-tl-dims");
  const dimL = el("div", "sm-tl-dim");
  const dimR = el("div", "sm-tl-dim");
  dims.append(dimL, dimR);
  const tip = el("div", "sm-tl-tip");
  tip.hidden = true;

  const overlay = el("div", "sm-tl-overlay");
  const head = el("div", "sm-tl-playhead");
  const headTime = el("span", "sm-tl-playhead-time", clockTenths(0));
  head.append(headTime, el("span", "sm-tl-playhead-line"));
  overlay.append(head);

  grid.append(mask, markers, ruler, videoLabel, video, audioLabels, audio, dims, overlay, tip);
  scroll.append(grid);
  scroll.addEventListener("scroll", () => { painted.lanes = null; });
  // A plain wheel scrolls the zoomed song sideways.
  scroll.addEventListener("wheel", (e) => {
    if (zoom <= 0 || e.ctrlKey || Math.abs(e.deltaX) > Math.abs(e.deltaY)) return;
    e.preventDefault();
    scroll.scrollLeft += e.deltaY;
  }, { passive: false });
  card.append(zoomBox, scroll);
  return {
    card, zoomBox, zTrack, zFill, zThumb, zOut, zIn, scroll, grid, markers, ruler, video, audio, lanes,
    range, trimIn, trimOut, dimL, dimR, tip, head, headTime,
  };
}

function buildSide() {
  const aside = el("aside", "sm-side");
  aside.id = "streamerSide";

  // Recording & Output: the camera and the input (streamerDevices.js), the
  // input meter, and the output settings (outputSettings.js, stored per
  // user). TODO(phase 4): the resolution, frame rate and switches go into
  // the recording.
  const rec = el("section", "sm-card sm-out");
  const recHead = tx(el("h3", "sm-out-head"), "streamer.output");
  const body = el("div", "sm-out-body");
  const field = (labelKey, id, sel) => {
    const label = tx(el("label", "sm-flabel"), labelKey);
    label.htmlFor = id;
    sel.id = id;
    return label;
  };
  // Under each device select: why it is not working, and Retry or Allow.
  const stateLine = (kind) => {
    const line = el("div", "sm-dev-state");
    line.hidden = true;
    line.setAttribute("role", "status");
    const text = el("span", "sm-dev-text");
    const act = button("sm-ib sm-dev-act");
    act.addEventListener("click", () => deviceAction(kind));
    line.append(text, act);
    return { line, text, act };
  };
  const vsrc = selectBox("", "webcam");
  vsrc.sel.addEventListener("change", () => setSetting({ videoDeviceId: vsrc.sel.value }));
  const vstate = stateLine("video");
  const asrc = selectBox("", "mic");
  asrc.sel.addEventListener("change", () => setSetting({ audioDeviceId: asrc.sel.value }));
  const astate = stateLine("audio");
  const meterRow = el("div", "sm-meter-row");
  const meter = el("div", "sm-meter");
  meter.setAttribute("role", "meter");
  meter.setAttribute("aria-valuemin", String(METER_FLOOR_DB));
  meter.setAttribute("aria-valuemax", "0");
  meter.setAttribute("aria-valuenow", String(METER_FLOOR_DB));
  tx(meter, "streamer.inputLevel", "aria-label");
  // Two rows (the first two channels), each segment coloured by its zone.
  const meterRows = [];
  for (let r = 0; r < 2; r++) {
    const bar = el("div", "sm-meter-bar");
    const segs = [];
    for (let k = 0; k < METER_SEGMENTS; k++) {
      const seg = el("span", `sm-meter-seg sm-seg-${segmentZone(k)}`);
      segs.push(seg);
      bar.append(seg);
    }
    meter.append(bar);
    meterRows.push({ segs, lit: 0, peak: newPeakState() });
  }
  const level = el("span", "sm-meter-db", `${METER_FLOOR_DB} dB`);
  const inSet = button("sm-ib sm-in-settings");
  inSet.append(icon(ICONS.gear, { size: 16 }));
  tx(inSet, "streamer.inputSettings", "label");
  // The studio's own input settings (Settings, Recording tab).
  inSet.addEventListener("click", () => openRecordingSettings());
  meterRow.append(meter, level, inSet);
  const grid = el("div", "sm-out-grid");
  const res = selectBox();
  for (const [v, k] of [["1080", "streamer.res1080"], ["720", "streamer.res720"], ["2160", "streamer.res2160"]]) option(res.sel, v, k);
  res.sel.addEventListener("change", () => setSetting({ resolution: res.sel.value }));
  const fps = selectBox();
  for (const n of [30, 60, 24]) {
    const o = el("option");
    o.value = String(n);
    o.dataset.fps = String(n);
    o.textContent = t("streamer.fpsValue", { n });
    fps.sel.append(o);
  }
  fps.sel.addEventListener("change", () => setSetting({ fps: Number(fps.sel.value) }));
  const resCol = el("div", "sm-out-col");
  resCol.append(field("streamer.resolution", "streamerRes", res.sel), res.wrap);
  const fpsCol = el("div", "sm-out-col");
  fpsCol.append(field("streamer.fps", "streamerFps", fps.sel), fps.wrap);
  grid.append(resCol, fpsCol);
  // 4K or 60 fps is allowed, with a warning (the 4K policy is not decided).
  const heavy = tx(el("p", "sm-heavy"), "streamer.heavy");
  heavy.hidden = true;
  const switches = el("div", "sm-out-switches");
  const sw = {};
  for (const [key, k] of [["recordMixedAudio", "streamer.recMixed"], ["includeClick", "streamer.recClick"], ["autoStopAtEnd", "streamer.recAutostop"]]) {
    sw[key] = makeSwitch("", k, settings[key], (on) => setSetting({ [key]: on }));
    sw[key].b.dataset.setting = key;
    switches.append(sw[key].b);
  }
  body.append(
    field("streamer.videoSource", "streamerVideoSrc", vsrc.sel), vsrc.wrap, vstate.line,
    field("streamer.audioSource", "streamerAudioSrc", asrc.sel), asrc.wrap, astate.line,
    meterRow, grid, heavy, switches,
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
  return {
    aside, fps: fps.sel, titleIn, vsrc: vsrc.sel, asrc: asrc.sel, vstate, astate,
    meter, meterRows, level, res: res.sel, heavy, sw,
  };
}

function relabel() {
  for (const [node, key, attr] of texts) setText(node, key, attr);
  if (railBtn) {
    railBtn.title = t("streamer.rail");
    railBtn.setAttribute("aria-label", t("streamer.rail"));
  }
  if (!ui) return;
  closeMenu();
  closeProps();
  for (const o of ui.side.fps.options) o.textContent = t("streamer.fpsValue", { n: o.dataset.fps });
  ui.otherTitle.textContent = t(TAB_LABEL[tab]);
  dropRows();
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
  commit(withAspect(scene, aspect));
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
  return { title: title === NO_TITLE ? "" : title, artist, art };
}

/** The stems heard now: not muted, and soloed when any lane is. */
function audibleStems() {
  const names = Object.keys(trackIndex || {}).filter((n) => mixerState[n]);
  const solo = names.some((n) => mixerState[n].soloed);
  return names.filter((n) => (solo ? mixerState[n].soloed : !mixerState[n].muted));
}

// ── Scene per song, edits and undo ──

async function showSceneFor(job) {
  const token = ++sceneToken;
  if (sceneJob && sceneJob !== job) await flushScene(sceneJob);
  const next = await loadScene(job);
  if (token !== sceneToken) return;
  scene = next;
  sceneJob = job;
  history = emptyHistory();
  closeMenu();
  closeProps();
  if (ui) ui.head.aspect.value = scene.aspect;
  if (!scene.layers.some((l) => l.id === selected)) selected = null;
  afterChange();
}

/** The scene is now `next`, made from `from` (the scene before the edit):
 * one undo step, saved for this song. */
function commit(next, from = scene) {
  if (!next || next === from) return false;
  history = pushHistory(history, from);
  scene = next;
  afterChange();
  return true;
}

/** Repaint and save after the scene changed (an edit, undo or redo). */
function afterChange() {
  if (selected && !scene.layers.some((l) => l.id === selected)) selected = null;
  saveScene(sceneJob, scene);
  if (ui) ui.head.aspect.value = scene.aspect;
  painted.scene = null;
  painted.layers = null;
  painted.tlTrim = null;
  paintHistory();
}

function doUndo() {
  const r = undoHistory(history, scene);
  if (!r.scene) return;
  history = r.history;
  scene = r.scene;
  afterChange();
}

function doRedo() {
  const r = redoHistory(history, scene);
  if (!r.scene) return;
  history = r.history;
  scene = r.scene;
  afterChange();
}

function paintHistory() {
  if (!ui) return;
  ui.builder.undo.disabled = !history.past.length;
  ui.builder.redo.disabled = !history.future.length;
}

function setLayerVisible(id, visible) {
  commit(withLayerVisible(scene, id, visible));
}

function selectLayer(id) {
  if (selected === id) return;
  selected = id;
  painted.scene = null;
  painted.layers = null;
}

function addOf(type) {
  const id = newLayerId(scene, type);
  if (commit(addLayer(scene, type, { locked, id }))) selectLayer(id);
}

function duplicateOf(id) {
  const layer = scene.layers.find((l) => l.id === id);
  if (!layer) return;
  const copyId = newLayerId(scene, layer.type);
  if (commit(duplicateLayer(scene, id, { locked }))) selectLayer(copyId);
}

function deleteOf(id) {
  if (commit(deleteLayer(scene, id, { locked })) && selected === id) selectLayer(null);
}

/** Phase 4's recording lock: while it holds, layers are not added, deleted
 * or reordered. */
export function setStreamerLocked(on) {
  locked = Boolean(on);
  root?.classList.toggle("sm-locked", locked);
  if (ui) ui.builder.layers.add.disabled = locked;
  closeMenu();
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
  document.addEventListener("pointerdown", onOutsidePointer, true);
  for (const k of Object.keys(painted)) delete painted[k];
  shownJob = undefined;
  startDevices().catch((err) => console.warn("[streamer] reading the devices failed:", err));
  paintRail();
  loop();
  notify();
  return true;
}

export function closeStreamer() {
  if (!open) return;
  open = false;
  toggleDrawer(false);
  closeMenu();
  closeProps();
  root.hidden = true;
  document.documentElement.classList.remove("streamer-open");
  // Karaoke may have opened over the lanes this moment: its inert stays.
  if (!isKaraokeOpen()) {
    for (const id of ["lanes", "master-drawer"]) document.getElementById(id)?.removeAttribute("inert");
  }
  window.removeEventListener("resize", placeLayer);
  layerObserver?.disconnect();
  window.removeEventListener("keydown", onKey, true);
  document.removeEventListener("pointerdown", onOutsidePointer, true);
  cancelAnimationFrame(raf);
  raf = 0;
  // The camera light goes off, the input closes.
  stopDevices();
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
  paintDevices();
  paintMeter();
  if (tab !== "builder") return;
  const lyrics = lyricWindow(lyr.lines, tNow, 7);
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

/** Where the scene sits in the preview box (pillarboxed), in CSS pixels. */
function sceneRect() {
  const p = ui.builder.preview;
  return fitAspect(p.clientWidth, p.clientHeight, scene.aspect);
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
  // A live camera is a new picture every frame.
  const cam = cameraSource();
  const sig = [cw, ch, dpr, safeZones, selected, meta.title, meta.artist, meta.art?.currentSrc || "", lyricSig, played, painted.barsSig, totalDuration, t("streamer.textPlaceholder"), cam ? cam.currentTime : -1].join("§");
  if (painted.scene === sig && painted.sceneObj === scene) return;
  painted.scene = sig;
  painted.sceneObj = scene;
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
    camera: cameraSource(),
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
      text: t("streamer.textPlaceholder"),
      image: t("streamer.imagePlaceholder"),
    },
    editor: { selection: selected, safeZones },
  });
  ctx.restore();
  // The REC badge sits on the scene's own top left corner.
  rec.style.left = `${Math.round(f.x + 10)}px`;
  rec.style.top = `${Math.round(f.y + 10)}px`;
  paintSelBox(f);
}

/** The selected layer's handles, over its frame (the album art's square). */
function paintSelBox(f) {
  const box = ui.builder.selbox;
  const layer = selected && scene.layers.find((l) => l.id === selected && l.visible);
  if (!layer) {
    box.hidden = true;
    return;
  }
  let w = layer.frame.w * f.w;
  let h = layer.frame.h * f.h;
  if (layer.type === "albumArt") w = h = Math.min(w, h);
  box.hidden = false;
  box.style.left = `${f.x + layer.frame.x * f.w}px`;
  box.style.top = `${f.y + layer.frame.y * f.h}px`;
  box.style.width = `${w}px`;
  box.style.height = `${h}px`;
}

/**
 * Picking, moving and resizing in the preview. A press picks the front-most
 * layer under it (or keeps the selected one when pressed inside its box) and
 * drags it; a corner handle resizes. Edges and centres snap to the safe
 * zones and the centre lines (Alt: no snapping). The whole drag is one undo
 * step.
 */
function wirePreview(preview, rec) {
  let drag = null;
  preview.addEventListener("pointerdown", (e) => {
    if (e.button !== 0 || rec.contains(e.target) || e.target.closest?.(".sm-cam-state")) return;
    preview.focus({ preventScroll: true });
    const f = sceneRect();
    const r = preview.getBoundingClientRect();
    const border = preview.clientLeft;
    const px = (e.clientX - r.left - border - f.x) / f.w;
    const py = (e.clientY - r.top - border - f.y) / f.h;
    const corner = e.target instanceof Element ? e.target.dataset?.corner : null;
    const inBox = e.target instanceof Element && e.target.closest(".sm-selbox");
    let layer = null;
    if ((corner || inBox) && selected) layer = scene.layers.find((l) => l.id === selected) || null;
    if (!layer) layer = layerAt(scene, px, py);
    selectLayer(layer?.id ?? null);
    if (!layer) return;
    e.preventDefault();
    preview.setPointerCapture(e.pointerId);
    drag = { id: layer.id, corner, x0: e.clientX, y0: e.clientY, start: { ...layer.frame }, base: scene, f, moved: false };
  });
  preview.addEventListener("pointermove", (e) => {
    if (!drag) return;
    const dx = (e.clientX - drag.x0) / drag.f.w;
    const dy = (e.clientY - drag.y0) / drag.f.h;
    if (!drag.moved && Math.hypot(e.clientX - drag.x0, e.clientY - drag.y0) < 2) return;
    drag.moved = true;
    const opts = { snap: !e.altKey, tx: SNAP_PX / drag.f.w, ty: SNAP_PX / drag.f.h };
    const frame = drag.corner ? resizeFrame(drag.start, drag.corner, dx, dy, opts) : moveFrame(drag.start, dx, dy, opts);
    scene = setLayerFrame(drag.base, drag.id, frame);
    painted.scene = null;
  });
  const end = () => {
    if (!drag) return;
    const d = drag;
    drag = null;
    if (d.moved && scene !== d.base) {
      // The live scene is the result; the step goes back to where it began.
      const result = scene;
      scene = d.base;
      commit(result, d.base);
    }
  };
  preview.addEventListener("pointerup", end);
  preview.addEventListener("pointercancel", end);
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
    case "camera": {
      if (settings.videoDeviceId === NONE) return t("streamer.sub.cameraOff");
      const c = cameraState();
      if (c.live) return t("streamer.sub.cameraLive", { name: cameraName(c.label), width: c.width || "?", height: c.height || "?" });
      return t("streamer.sub.cameraNone");
    }
    case "title": return [meta.title, layer.props?.showArtist === false ? "" : meta.artist].filter(Boolean).join("\n") || t("streamer.sub.noSong");
    case "lyrics": {
      if (!lyrics.length) return t("streamer.sub.noLyrics");
      return lyrics.slice(0, 2).map((l) => l.text).join("\n");
    }
    case "waveform": return t("streamer.sub.waveform");
    case "lowerThird": return `${layer.props?.handle || t("streamer.lowerHandle")}  |  ${layer.props?.subtitle || t("streamer.lowerSub")}`;
    case "albumArt": return t("streamer.sub.albumArt");
    case "background": return t("streamer.sub.background");
    case "text": return layer.props?.text || t("streamer.sub.textEmpty");
    case "image": return t("streamer.sub.image");
    default: return "";
  }
}

function dropRows() {
  const L = ui.builder.layers;
  for (const row of L.rows.values()) texts = texts.filter(([n]) => !row.li.contains(n));
  L.rows.clear();
  L.list.replaceChildren();
  painted.layerIds = null;
}

/** The panel lists the front layer first (the scene's array is back to front). */
function paintLayers(meta, lyrics) {
  const L = ui.builder.layers;
  const order = [...scene.layers].reverse();
  const sig = order.map((l) => `${l.id}:${l.visible ? 1 : 0}:${l.name || ""}:${layerSub(l, meta, lyrics)}`).join("|") + `|${selected}|${locked}|${meta.art?.currentSrc || ""}`;
  if (painted.layers === sig) return;
  painted.layers = sig;
  const ids = order.map((l) => l.id).join("|");
  if (painted.layerIds !== ids) {
    // Rebuilt in the new order; a row being renamed is not kept.
    const focusId = document.activeElement?.closest?.(".sm-layer")?.dataset.layer;
    const focusCls = document.activeElement?.classList?.[0];
    dropRows();
    painted.layerIds = ids;
    L.list.replaceChildren(...order.map((l) => layerRow(l)));
    if (focusId && focusCls) L.rows.get(focusId)?.li.querySelector(`.${focusCls}`)?.focus({ preventScroll: true });
  }
  for (const layer of order) {
    const row = L.rows.get(layer.id);
    if (!row) continue;
    const name = layerName(layer);
    row.li.classList.toggle("selected", layer.id === selected);
    row.li.classList.toggle("off", !layer.visible);
    row.pick.setAttribute("aria-pressed", String(layer.id === selected));
    if (!row.renaming) row.name.textContent = name;
    const sub = layerSub(layer, meta, lyrics);
    if (row.sub.textContent !== sub) row.sub.textContent = sub;
    row.sw.set(layer.visible);
    row.sw.b.setAttribute("aria-label", t(layer.visible ? "streamer.layerShown" : "streamer.layerHidden", { name }));
    row.kebab.setAttribute("aria-label", t("streamer.layerOptionsFor", { name }));
    row.grip.setAttribute("aria-label", t("streamer.reorderFor", { name }));
    row.grip.classList.toggle("disabled", !layerRules(layer, { locked }).canReorder);
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
  // The handle drags the row up or down the list (the drawing order); with
  // the keyboard, Alt and the up or down arrow move it one place.
  const grip = el("span", "sm-layer-grip");
  grip.setAttribute("role", "button");
  grip.tabIndex = 0;
  grip.append(icon(ICONS.grip, { size: 13 }));
  wireReorder(grip, layer.id);
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
  pick.addEventListener("dblclick", () => startRename(layer.id));
  const sw = makeSwitch("sm-layer-switch", null, layer.visible, (on) => setLayerVisible(layer.id, on));
  const kebab = button("sm-layer-kebab");
  kebab.append(icon(ICONS.kebab, { size: 16 }));
  kebab.setAttribute("aria-haspopup", "menu");
  kebab.addEventListener("click", (e) => {
    e.stopPropagation();
    selectLayer(layer.id);
    openLayerMenu(kebab, layer.id);
  });
  li.append(grip, pick, sw.b, kebab);
  ui.builder.layers.rows.set(layer.id, { li, grip, pick, name, sub, sw, kebab, art, renaming: false });
  return li;
}

/** Drag a row by its handle; the list order is the drawing order (front first). */
function wireReorder(grip, id) {
  grip.addEventListener("keydown", (e) => {
    if (!e.altKey || (e.key !== "ArrowUp" && e.key !== "ArrowDown")) return;
    e.preventDefault();
    e.stopPropagation();
    const i = scene.layers.findIndex((l) => l.id === id);
    // Up the list is toward the front: a higher array index.
    if (commit(reorderLayer(scene, id, i + (e.key === "ArrowUp" ? 1 : -1), { locked }))) {
      requestAnimationFrame(() => ui.builder.layers.rows.get(id)?.grip.focus({ preventScroll: true }));
    }
  });
  grip.addEventListener("pointerdown", (e) => {
    if (e.button !== 0 || locked) return;
    e.preventDefault();
    const list = ui.builder.layers.list;
    const rows = [...list.children];
    const li = grip.closest(".sm-layer");
    const from = rows.indexOf(li);
    if (from < 0) return;
    grip.setPointerCapture(e.pointerId);
    li.classList.add("dragging");
    let to = from;
    const mark = () => {
      rows.forEach((r, i) => {
        r.classList.toggle("drop-before", i === to && to < from);
        r.classList.toggle("drop-after", i === to && to > from);
      });
    };
    const move = (ev) => {
      const y = ev.clientY;
      to = rows.length - 1;
      for (let i = 0; i < rows.length; i++) {
        const r = rows[i].getBoundingClientRect();
        if (y < r.top + r.height / 2) { to = i; break; }
      }
      if (to > from && y < rows[to].getBoundingClientRect().top + rows[to].getBoundingClientRect().height / 2) to -= 1;
      to = Math.max(0, Math.min(rows.length - 1, to));
      mark();
    };
    const up = () => {
      grip.removeEventListener("pointermove", move);
      grip.removeEventListener("pointerup", up);
      grip.removeEventListener("pointercancel", up);
      li.classList.remove("dragging");
      rows.forEach((r) => r.classList.remove("drop-before", "drop-after"));
      // Panel index (front first) to array index (back first).
      if (to !== from) commit(reorderLayer(scene, id, scene.layers.length - 1 - to, { locked }));
    };
    grip.addEventListener("pointermove", move);
    grip.addEventListener("pointerup", up);
    grip.addEventListener("pointercancel", up);
  });
}

function startRename(id) {
  const row = ui.builder.layers.rows.get(id);
  const layer = scene.layers.find((l) => l.id === id);
  if (!row || !layer || row.renaming) return;
  row.renaming = true;
  const input = el("input", "sm-rename");
  input.type = "text";
  input.maxLength = NAME_MAX;
  input.value = layerName(layer);
  input.setAttribute("aria-label", t("streamer.renameAria"));
  row.name.replaceChildren(input);
  input.focus();
  input.select();
  let done = false;
  const finish = (keep) => {
    if (done) return;
    done = true;
    row.renaming = false;
    const value = input.value.trim();
    // The type's own name back is no name of its own.
    if (keep) commit(renameLayer(scene, id, value === t(LAYER_NAME[layer.type]) ? "" : value));
    painted.layers = null;
    row.name.textContent = layerName(scene.layers.find((l) => l.id === id) || layer);
    row.kebab.focus({ preventScroll: true });
  };
  input.addEventListener("keydown", (e) => {
    e.stopPropagation();
    if (e.key === "Enter") { e.preventDefault(); finish(true); }
    else if (e.key === "Escape") { e.preventDefault(); finish(false); }
  });
  input.addEventListener("blur", () => finish(true));
  input.addEventListener("click", (e) => e.stopPropagation());
}

// ── Menus (the kebab's and + Add Layer's) ──

let menu = null;

/** A small menu under `anchor`: items { key, run, disabled }. Up and Down
 * move, Enter chooses, Escape closes and puts focus back on `anchor`. */
function openMenu(anchor, items, labelKey) {
  closeMenu();
  const box = el("div", "sm-menu");
  box.setAttribute("role", "menu");
  box.setAttribute("aria-label", t(labelKey));
  for (const it of items) {
    const b = button("sm-menu-item");
    b.setAttribute("role", "menuitem");
    b.tabIndex = -1;
    b.textContent = t(it.key);
    b.dataset.item = it.id || it.key;
    if (it.disabled) b.setAttribute("aria-disabled", "true");
    b.addEventListener("click", (e) => {
      e.stopPropagation();
      if (it.disabled) return;
      closeMenu({ focus: false });
      it.run();
    });
    box.append(b);
  }
  box.addEventListener("keydown", (e) => {
    const list = [...box.querySelectorAll(".sm-menu-item")];
    const i = list.indexOf(document.activeElement);
    if (e.key === "Escape") {
      e.preventDefault();
      closeMenu();
    } else if (e.key === "ArrowDown" || e.key === "ArrowUp") {
      e.preventDefault();
      list[(i + (e.key === "ArrowDown" ? 1 : -1) + list.length) % list.length]?.focus();
    } else if (e.key === "Home" || e.key === "End") {
      e.preventDefault();
      list[e.key === "Home" ? 0 : list.length - 1]?.focus();
    } else if (e.key === "Tab") {
      closeMenu({ focus: false });
    }
    // Keys in the menu are the menu's: Space and Delete must not reach the studio.
    e.stopPropagation();
  });
  document.body.append(box);
  const r = anchor.getBoundingClientRect();
  const w = box.offsetWidth;
  const h = box.offsetHeight;
  box.style.left = `${Math.round(Math.max(8, Math.min(window.innerWidth - w - 8, r.right - w)))}px`;
  box.style.top = `${Math.round(r.bottom + 4 + h > window.innerHeight ? r.top - h - 4 : r.bottom + 4)}px`;
  anchor.setAttribute("aria-expanded", "true");
  menu = { box, anchor };
  box.querySelector(".sm-menu-item:not([aria-disabled=true])")?.focus();
}

function closeMenu({ focus = true } = {}) {
  if (!menu) return;
  const { box, anchor } = menu;
  menu = null;
  box.remove();
  anchor.setAttribute("aria-expanded", "false");
  if (focus && anchor.isConnected) anchor.focus({ preventScroll: true });
}

function openLayerMenu(anchor, id) {
  const layer = scene.layers.find((l) => l.id === id);
  if (!layer) return;
  const rules = layerRules(layer, { locked });
  openMenu(anchor, [
    { id: "rename", key: "streamer.menu.rename", run: () => startRename(id) },
    { id: "duplicate", key: "streamer.menu.duplicate", disabled: !rules.canDuplicate, run: () => duplicateOf(id) },
    { id: "edit", key: "streamer.menu.edit", run: () => openProps(id, anchor) },
    { id: "delete", key: "streamer.menu.delete", disabled: !rules.canDelete, run: () => deleteOf(id) },
  ], "streamer.layerOptions");
}

function openAddMenu(anchor) {
  if (locked) return;
  openMenu(anchor, ADDABLE_TYPES.map((type) => ({ id: type, key: LAYER_NAME[type], run: () => addOf(type) })), "streamer.addLayer");
}

function onOutsidePointer(e) {
  if (menu && !menu.box.contains(e.target) && e.target !== menu.anchor && !menu.anchor.contains(e.target)) closeMenu({ focus: false });
  if (props && !props.box.contains(e.target) && !(props.anchor && props.anchor.contains(e.target))) closeProps({ focus: false });
}

// ── Edit properties ──

let props = null;

/** A small panel of the layer's own settings, beside the layers panel. Each
 * change is one undo step. */
function openProps(id, anchor) {
  closeProps({ focus: false });
  const layer = scene.layers.find((l) => l.id === id);
  if (!layer) return;
  const box = el("div", "sm-props");
  box.setAttribute("role", "dialog");
  box.setAttribute("aria-label", t("streamer.props.title", { name: layerName(layer) }));
  const head = el("div", "sm-props-head", t("streamer.props.title", { name: layerName(layer) }));
  const body = el("div", "sm-props-body");
  const set = (patch) => commit(setLayerProps(scene, id, patch));
  const textField = (labelKey, value, onChange, max = 60) => {
    const wrap = el("label", "sm-props-field");
    const input = el("input", "sm-inp");
    input.type = "text";
    input.maxLength = max;
    input.value = value || "";
    input.addEventListener("change", () => onChange(input.value));
    wrap.append(el("span", "sm-flabel", t(labelKey)), input);
    return wrap;
  };
  const switchField = (labelKey, on, onChange) => {
    const s = makeSwitch("sm-props-switch", labelKey, on, onChange);
    return s.b;
  };
  switch (layer.type) {
    case "lowerThird":
      body.append(
        textField("streamer.props.handle", layer.props.handle, (v) => set({ handle: v })),
        textField("streamer.props.subtitle", layer.props.subtitle, (v) => set({ subtitle: v })),
      );
      break;
    case "text": {
      body.append(textField("streamer.props.text", layer.props.text, (v) => set({ text: v }), 200));
      const sizeWrap = el("label", "sm-props-field");
      const size = el("input", "sm-range");
      size.type = "range";
      size.min = String(TEXT_SIZE_MIN);
      size.max = String(TEXT_SIZE_MAX);
      size.step = "0.25";
      size.value = String(layer.props.size);
      size.addEventListener("change", () => set({ size: Number(size.value) }));
      sizeWrap.append(el("span", "sm-flabel", t("streamer.props.size")), size);
      const colors = el("div", "sm-props-colors");
      colors.setAttribute("role", "radiogroup");
      colors.setAttribute("aria-label", t("streamer.props.color"));
      for (const c of TEXT_COLORS) {
        const sw = button(`sm-swatch sm-swatch-${c}`);
        sw.setAttribute("role", "radio");
        sw.setAttribute("aria-checked", String(layer.props.color === c));
        sw.setAttribute("aria-label", t(`streamer.color.${c}`));
        sw.title = t(`streamer.color.${c}`);
        sw.addEventListener("click", () => {
          set({ color: c });
          for (const o of colors.children) o.setAttribute("aria-checked", String(o === sw));
        });
        colors.append(sw);
      }
      body.append(sizeWrap, el("span", "sm-flabel", t("streamer.props.color")), colors);
      break;
    }
    case "lyrics": {
      const wrap = el("label", "sm-props-field");
      const { wrap: sw, sel } = selectBox();
      for (let n = LYRIC_LINES_MIN; n <= LYRIC_LINES_MAX; n++) {
        const o = el("option", null, String(n));
        o.value = String(n);
        sel.append(o);
      }
      sel.value = String(layer.props.lines);
      sel.addEventListener("change", () => set({ lines: Number(sel.value) }));
      wrap.append(el("span", "sm-flabel", t("streamer.props.lines")), sw);
      body.append(wrap);
      break;
    }
    case "camera":
      body.append(
        switchField("streamer.props.mirror", layer.props.mirror, (on) => set({ mirror: on })),
        el("p", "sm-props-hint", t("streamer.props.mirrorHint")),
      );
      break;
    case "title":
      body.append(switchField("streamer.props.showArtist", layer.props.showArtist !== false, (on) => set({ showArtist: on })));
      break;
    default:
      body.append(el("p", "sm-props-hint", t("streamer.props.none")));
  }
  const done = tx(button("sm-primary sm-props-done"), "streamer.props.done");
  done.addEventListener("click", () => closeProps());
  box.addEventListener("keydown", (e) => {
    if (e.key === "Escape") {
      e.preventDefault();
      closeProps();
    }
    // Typing here is the panel's: Delete, arrows and Space stay out of the studio.
    e.stopPropagation();
  });
  box.append(head, body, done);
  root.append(box);
  // Beside the layers panel, at the row's height when it fits.
  const panel = ui.builder.layers.panel.getBoundingClientRect();
  const rr = root.getBoundingClientRect();
  const a = anchor?.getBoundingClientRect() || panel;
  const h = box.offsetHeight;
  const w = box.offsetWidth;
  box.style.left = `${Math.round(Math.max(8, panel.left - rr.left - w - 8))}px`;
  box.style.top = `${Math.round(Math.max(8, Math.min(rr.height - h - 8, a.top - rr.top - 8)))}px`;
  props = { box, anchor, id };
  box.querySelector("input, select, button")?.focus();
}

function closeProps({ focus = true } = {}) {
  if (!props) return;
  const { box, anchor } = props;
  props = null;
  box.remove();
  if (focus && anchor?.isConnected) anchor.focus({ preventScroll: true });
}

// ── Recording and output settings, devices, the meter ──

async function loadSettings() {
  try {
    settings = parseRecordingSettings(await storeGet(SETTINGS_KEY, null));
  } catch (err) {
    console.warn("[streamer] reading the recording settings failed:", err);
    settings = defaultRecordingSettings();
  }
  painted.devices = null;
  painted.layers = null;
}

function setSetting(patch) {
  settings = parseRecordingSettings({ ...settings, ...patch });
  storeSet(SETTINGS_KEY, serializeRecordingSettings(settings));
  painted.devices = null;
  painted.layers = null;
}

/** Allow (no permission yet) or Retry (it failed) for one kind. */
function deviceAction(kind) {
  const st = kind === "video" ? cameraState() : inputState();
  if (!st.mayAsk && !st.reason) allowDevices();
  else retryDevice(kind);
  painted.devices = null;
}

/** The camera's name without the USB id Chromium adds on Windows. */
function cameraName(label) {
  return String(label || "").replace(/\s*\([0-9a-f]{4}:[0-9a-f]{4}\)\s*$/i, "") || t("streamer.cameraPlaceholder");
}

/** What the view wants open now: the camera for a visible Camera layer in
 * the Scene Builder, the input while Streamer is open. */
function wantedDevices() {
  const lists = deviceLists();
  const camLayer = scene.layers.some((l) => l.type === "camera" && l.visible);
  const camera = tab === "builder" && camLayer && settings.videoDeviceId !== NONE
    ? resolveDeviceId(settings.videoDeviceId, lists.video) : null;
  const audio = settings.audioDeviceId !== NONE ? resolveDeviceId(settings.audioDeviceId, lists.audio) : null;
  return { camera, audio, settings };
}

function fillDeviceSelect(sel, kind, devices, saved) {
  const video = kind === "video";
  const sig = `${devices.map((d) => `${d.deviceId}:${d.label}`).join("|")}|${t("capture.defaultDevice")}`;
  if (sel.dataset.sig !== sig) {
    sel.dataset.sig = sig;
    sel.replaceChildren();
    const add = (value, text) => {
      const o = el("option", null, text);
      o.value = value;
      sel.append(o);
    };
    add(NONE, t(video ? "streamer.noCamera" : "streamer.noAudioInput"));
    add("", t("capture.defaultDevice"));
    devices.forEach((d, i) => add(d.deviceId, video
      ? (d.label ? cameraName(d.label) : t("capture.cameraN", { n: i + 1 }))
      : (d.label ? friendlyName(d.label) : t("capture.inputN", { n: i + 1 }))));
  }
  const want = resolveDeviceId(saved, devices);
  const has = [...sel.options].some((o) => o.value === want);
  sel.value = has ? want : "";
}

/** The sentence for a device's state, or "" when it is fine. */
function deviceMessage(kind, st, selectedNone) {
  if (selectedNone) return "";
  if (st.reason === "recording") return t("streamer.inUse");
  if (st.reason === "unplugged") return t(kind === "video" ? "streamer.cam.unplugged" : "streamer.mic.unplugged");
  if (st.reason) return reasonMessage(st.reason, kind);
  if (!st.mayAsk) return t("streamer.allowHint");
  if (st.pending) return t(kind === "video" ? "streamer.cam.starting" : "streamer.mic.starting");
  return "";
}

function actionKey(st) {
  if (st.reason === "recording") return null;
  if (st.reason) return "streamer.retry";
  if (!st.mayAsk) return "streamer.allowDevices";
  return null;
}

function paintDeviceLine(line, kind, st, selectedNone) {
  const msg = deviceMessage(kind, st, selectedNone || (kind === "audio" && st.noEngine));
  line.line.hidden = !msg;
  line.line.classList.toggle("sm-dev-bad", Boolean(st.reason));
  if (line.text.textContent !== msg) line.text.textContent = msg;
  const key = actionKey(st);
  line.act.hidden = !key || !msg;
  if (key) line.act.textContent = t(key);
}

function paintDevices() {
  reconcile(wantedDevices());
  const c = cameraState();
  const a = inputState();
  const lists = deviceLists();
  const sig = JSON.stringify([c, a, settings, lists.video.length, lists.audio.length, lists.video.map((d) => d.label), lists.audio.map((d) => d.label), tab, scene.layers.some((l) => l.type === "camera" && l.visible), t("streamer.retry")]);
  if (painted.devices === sig) return;
  painted.devices = sig;
  const side = ui.side;
  fillDeviceSelect(side.vsrc, "video", lists.video, settings.videoDeviceId);
  fillDeviceSelect(side.asrc, "audio", lists.audio, settings.audioDeviceId);
  side.res.value = settings.resolution;
  side.fps.value = String(settings.fps);
  for (const [key, s2] of Object.entries(side.sw)) s2.set(settings[key]);
  side.heavy.hidden = !isHeavy(settings);
  paintDeviceLine(side.vstate, "video", c, settings.videoDeviceId === NONE);
  // One Allow is enough: it opens both. The input's line says it only when
  // the camera's does not.
  const askBoth = !c.mayAsk && !c.reason && !a.mayAsk && !a.reason && settings.videoDeviceId !== NONE;
  paintDeviceLine(side.astate, "audio", a, settings.audioDeviceId === NONE || askBoth);
  // Over the preview, while the Camera layer is shown and the camera is not.
  const b = ui.builder;
  const camLayer = scene.layers.some((l) => l.type === "camera" && l.visible);
  const msg = camLayer && settings.videoDeviceId !== NONE && !c.live ? deviceMessage("video", c, false) : "";
  b.camState.hidden = !msg;
  b.camText.textContent = msg;
  const key = actionKey(c);
  b.camAct.hidden = !key;
  if (key) b.camAct.textContent = t(key);
  painted.scene = null;
}

/** The meter: the input's first two channels, each held and falling back,
 * segments lit by the dB scale; only changed segments are touched. */
function paintMeter() {
  const side = ui.side;
  const live = inputState().live;
  const nowMs = performance.now();
  let top = 0;
  side.meterRows.forEach((row, c) => {
    holdPeak(row.peak, live ? inputLevel(c) : 0, nowMs);
    top = Math.max(top, row.peak.value);
    const lit = litSegments(meterFraction(row.peak.value));
    if (lit === row.lit) return;
    const from = Math.min(lit, row.lit);
    const to = Math.max(lit, row.lit);
    for (let k = from; k < to; k++) row.segs[k].classList.toggle("on", k < lit);
    row.lit = lit;
  });
  const db = levelDb(top);
  if (painted.meterDb !== db) {
    painted.meterDb = db;
    side.level.textContent = `${db} dB`;
    side.meter.setAttribute("aria-valuenow", String(db));
  }
}

/** Phase 4's seam: the camera and input streams Streamer has open (or null). */
export function streamerMedia() {
  return getStreamerMedia();
}

// ── Take timeline ──

/** The two lanes: the voice, then the best instrument heard against it
 * (bass, guitar, drums, piano, other), else Original. */
function laneStems() {
  const present = Object.keys(trackIndex || {});
  const voice = ["lead_vocals", "vocals"].find((n) => present.includes(n));
  const other = ["bass", "guitar", "drums", "piano", "other", "original"].find((n) => present.includes(n));
  return [voice, other].filter(Boolean);
}

function timelineScale() {
  const tl = ui.builder.timeline;
  const view = Math.max(1, tl.scroll.clientWidth - LABEL_COL);
  const dur = totalDuration || 0;
  return { dur, view, pps: dur ? pixelsPerSecond(dur, view, zoom) : 0 };
}

function setZoom(z) {
  const next = Math.round(Math.max(0, Math.min(1, z)) * 100) / 100;
  if (next === zoom) return;
  zoom = next;
  zoomAnchor = now();
  painted.tlScale = null;
}

function wireZoomSlider(track) {
  const at = (clientX) => {
    const r = track.getBoundingClientRect();
    setZoom((clientX - r.left) / (r.width || 1));
  };
  track.addEventListener("pointerdown", (e) => {
    if (e.button !== 0) return;
    e.preventDefault();
    track.setPointerCapture(e.pointerId);
    at(e.clientX);
    const move = (ev) => at(ev.clientX);
    const up = () => {
      track.removeEventListener("pointermove", move);
      track.removeEventListener("pointerup", up);
      track.removeEventListener("pointercancel", up);
    };
    track.addEventListener("pointermove", move);
    track.addEventListener("pointerup", up);
    track.addEventListener("pointercancel", up);
  });
  track.addEventListener("keydown", (e) => {
    const step = { ArrowLeft: -ZOOM_STEP, ArrowDown: -ZOOM_STEP, ArrowRight: ZOOM_STEP, ArrowUp: ZOOM_STEP }[e.key];
    if (step === undefined && e.key !== "Home" && e.key !== "End") return;
    e.preventDefault();
    e.stopPropagation();
    if (e.key === "Home") setZoom(0);
    else if (e.key === "End") setZoom(1);
    else setZoom(zoom + step);
  });
}

function wireRuler(ruler) {
  const seekAt = (clientX) => {
    const { dur, pps } = timelineScale();
    if (!dur || !pps) return;
    const r = ruler.getBoundingClientRect();
    setPlayheadTime(Math.max(0, Math.min(dur, (clientX - r.left) / pps)));
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

/** Where a trim point snaps: the song's ends and its sections' starts and ends. */
function trimTargets(dur) {
  const out = [0, dur];
  for (const s of getSections()) out.push(s.start, s.end);
  return out.filter((v) => Number.isFinite(v));
}

/** Drag the in or out handle; it snaps to sections (Alt: no snapping). One
 * undo step per drag; the arrows move it a tenth (Shift: a second). */
function wireTrimHandle(handle, which) {
  let drag = null;
  const showTip = (time) => {
    const tip = ui.builder.timeline.tip;
    tip.hidden = false;
    tip.textContent = t(which === "in" ? "streamer.trimIn" : "streamer.trimOut", { time: clockTenths(time) });
    const { pps } = timelineScale();
    tip.style.left = `${LABEL_COL + time * pps}px`;
  };
  handle.addEventListener("pointerdown", (e) => {
    if (e.button !== 0) return;
    e.preventDefault();
    e.stopPropagation();
    const { dur, pps } = timelineScale();
    if (!dur || !pps) return;
    handle.setPointerCapture(e.pointerId);
    // Where on the handle it was taken: the point does not jump to the pointer.
    const audio = ui.builder.timeline.audio.getBoundingClientRect();
    const point = trimRange(scene, dur)[which];
    drag = { base: scene, dur, pps, offset: (e.clientX - audio.left) / pps - point };
    showTip(point);
  });
  handle.addEventListener("pointermove", (e) => {
    if (!drag) return;
    const audio = ui.builder.timeline.audio.getBoundingClientRect();
    let time = (e.clientX - audio.left) / drag.pps - drag.offset;
    if (!e.altKey) time = snapTime(time, trimTargets(drag.dur), 8 / drag.pps);
    scene = withTrimPoint(drag.base, which, time, drag.dur);
    painted.tlTrim = null;
    showTip(trimRange(scene, drag.dur)[which]);
  });
  const end = () => {
    if (!drag) return;
    const d = drag;
    drag = null;
    ui.builder.timeline.tip.hidden = true;
    if (scene !== d.base) {
      const result = scene;
      scene = d.base;
      commit(result, d.base);
    }
  };
  handle.addEventListener("pointerup", end);
  handle.addEventListener("pointercancel", end);
  handle.addEventListener("keydown", (e) => {
    if (e.key !== "ArrowLeft" && e.key !== "ArrowRight") return;
    e.preventDefault();
    e.stopPropagation();
    const dur = totalDuration || 0;
    const step = (e.shiftKey ? 1 : 0.1) * (e.key === "ArrowLeft" ? -1 : 1);
    commit(withTrimPoint(scene, which, trimRange(scene, dur)[which] + step, dur));
  });
}

function paintTimeline(tNow) {
  const tl = ui.builder.timeline;
  const { dur, view, pps } = timelineScale();
  const x = (time) => Math.max(0, Math.min(dur, time)) * pps;
  const contentW = Math.max(view, Math.round(dur * pps));

  // The scale: the song column's width and the zoom control.
  const scaleSig = `${dur}|${view}|${zoom}`;
  if (painted.tlScale !== scaleSig) {
    painted.tlScale = scaleSig;
    tl.grid.style.setProperty("--sm-tl-w", `${contentW}px`);
    const pct = `${Math.round(zoom * 100)}%`;
    tl.zFill.style.width = pct;
    tl.zThumb.style.left = pct;
    tl.zTrack.setAttribute("aria-valuenow", String(Math.round(zoom * 100)));
    tl.zOut.disabled = zoom <= 0;
    tl.zIn.disabled = zoom >= 1;
    painted.sections = null;
    painted.lanes = null;
    painted.tlTrim = null;
  }
  if (zoomAnchor !== null) {
    tl.scroll.scrollLeft = Math.max(0, x(zoomAnchor) - view / 2);
    zoomAnchor = null;
  }
  // While playing, the view follows the playhead.
  const headX = x(tNow);
  if (zoom > 0 && transport()?.isPlaying?.()) {
    const left = tl.scroll.scrollLeft;
    if (headX < left || headX > left + view - 24) tl.scroll.scrollLeft = Math.max(0, headX - 40);
  }
  tl.head.style.left = `${headX}px`;
  // The time label stays whole at the song's two ends.
  let labelLeft = Math.max(-34, -headX);
  if (headX + labelLeft + 68 > contentW) labelLeft = contentW - headX - 68;
  tl.headTime.style.left = `${labelLeft}px`;
  const ruler = tl.ruler;
  const tInt = String(Math.floor(tNow));
  if (painted.rulerNow !== tInt) {
    painted.rulerNow = tInt;
    ruler.setAttribute("aria-valuenow", tInt);
    ruler.setAttribute("aria-valuetext", clockTenths(tNow));
  }

  // Ruler ticks and section markers: on a new song, scale or set of sections.
  const sections = getSections();
  const secSig = `${dur}|${pps}|${sections.map((s) => `${s.id}:${s.start}:${s.end}:${s.color}:${s.kind || ""}:${s.name || ""}`).join(",")}|${t("streamer.jumpTo")}`;
  if (painted.sections !== secSig) {
    painted.sections = secSig;
    ruler.setAttribute("aria-valuemax", String(Math.floor(dur)));
    const ticks = dur ? ticksEvery(dur, tickStep(pps)) : [];
    ruler.replaceChildren(...ticks.flatMap((tk, i, all) => {
      const label = el("span", "sm-tick-label", tk.label);
      label.style.left = `${x(tk.t)}px`;
      if (i === 0) label.classList.add("first");
      else if (i === all.length - 1 && contentW - x(tk.t) < 30) label.classList.add("last");
      const mark = el("span", "sm-tick");
      mark.style.left = `${x(tk.t)}px`;
      return [label, mark];
    }));
    // Where each label starts, for hiding the ones under the label column.
    tl.edges = [...ruler.querySelectorAll(".sm-tick-label")].map((lab) => {
      const w = lab.offsetWidth;
      const at = parseFloat(lab.style.left);
      const shift = lab.classList.contains("first") ? 0 : lab.classList.contains("last") ? 0.9 : 0.5;
      return { el: lab, left: at - w * shift };
    });
    tl.markers.replaceChildren(...sections.flatMap((s) => {
      const name = sectionDisplayName(s, sections);
      const at = clockTenths(s.start).slice(0, 5);
      const b = button("sm-marker");
      b.style.left = `${x(s.start)}px`;
      b.style.setProperty("--sm-sec", s.color || "#4a7fff");
      b.setAttribute("aria-label", t("streamer.jumpTo", { name, time: at }));
      const label = el("span", "sm-marker-text");
      label.append(el("span", "sm-marker-name", name), el("span", "sm-marker-time", at));
      b.append(el("span", "sm-marker-pin"), label);
      b.addEventListener("click", () => setPlayheadTime(s.start));
      const stem = el("span", "sm-marker-stem");
      stem.style.left = `${x(s.start)}px`;
      stem.style.setProperty("--sm-sec", s.color || "#4a7fff");
      return [b, stem];
    }));
    for (const b of tl.markers.querySelectorAll(".sm-marker")) tl.edges.push({ el: b, left: parseFloat(b.style.left) - 7 });
    painted.tlEdges = null;
  }
  // A ruler label or section marker that would sit partly under the label
  // column (scrolled past) is hidden whole, never shown cut in half.
  const scrolled = tl.scroll.scrollLeft;
  if (painted.tlEdges !== scrolled && tl.edges) {
    painted.tlEdges = scrolled;
    for (const e of tl.edges) e.el.style.visibility = scrolled > 0 && e.left < scrolled - 0.5 ? "hidden" : "";
  }

  // Trim: the kept box, its handles and the dimmed parts.
  const range = trimRange(scene, dur);
  const trimSig = `${range.in}|${range.out}|${pps}|${contentW}`;
  if (painted.tlTrim !== trimSig) {
    painted.tlTrim = trimSig;
    const a = x(range.in);
    const b = x(range.out);
    tl.range.style.left = `${a}px`;
    tl.range.style.width = `${Math.max(0, b - a)}px`;
    tl.dimL.style.width = `${a}px`;
    tl.dimR.style.left = `${b}px`;
    tl.dimR.style.width = `${Math.max(0, contentW - b)}px`;
    for (const [h, v] of [[tl.trimIn, range.in], [tl.trimOut, range.out]]) {
      h.setAttribute("aria-valuemin", "0");
      h.setAttribute("aria-valuemax", String(Math.floor(dur)));
      h.setAttribute("aria-valuenow", String(Math.round(v * 10) / 10));
      h.setAttribute("aria-valuetext", clockTenths(v));
    }
  }

  // Stem lanes: only the part in view is drawn (a whole song at full zoom
  // would be wider than a canvas may be).
  const src = overviewPeaks();
  const stems = laneStems();
  const left = tl.scroll.scrollLeft;
  const h = tl.audio.clientHeight;
  const laneSig = `${stems.join(",")}|${view}x${h}|${left}|${pps}`;
  if (painted.lanes !== laneSig || painted.lanesSrc !== src) {
    painted.lanes = laneSig;
    painted.lanesSrc = src;
    tl.lanes.forEach((lane, i) => drawLane(lane, stems[i] || null, src, left, view, pps, dur));
  }
}

function drawLane(lane, stem, src, left, view, pps, dur) {
  lane.stem = stem;
  lane.label.hidden = !stem;
  lane.name.textContent = stem ? laneLabel(stem) : "";
  const color = (stem && STEM_COLORS[stem]) || "#9aa3ad";
  lane.label.style.setProperty("--sm-lane", color);
  const c = lane.canvas;
  const w = Math.max(0, Math.min(view, dur * pps - left) - 32);
  c.style.left = `${left + 16}px`;
  c.style.width = `${w}px`;
  const h = c.clientHeight;
  if (!w || !h) return;
  const dpr = Math.min(2, window.devicePixelRatio || 1);
  c.width = Math.round(w * dpr);
  c.height = Math.round(h * dpr);
  const ctx = c.getContext("2d");
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.clearRect(0, 0, w, h);
  if (!stem || !src?.data?.[stem] || !dur || !pps) return;
  const n = Math.max(1, Math.floor(w / 3));
  const from = (left + 16) / pps / dur;
  const to = (left + 16 + w) / pps / dur;
  const bars = peakBars(src.data, [stem], n, from, to);
  const step = w / n;
  ctx.fillStyle = color;
  for (let i = 0; i < n; i++) {
    const bh = Math.min(h, ((3 + bars[i] * 20) / 26) * h);
    ctx.fillRect(i * step, (h - bh) / 2, Math.max(1, step - 1), bh);
  }
}

// ── Keys (only while Streamer Mode is open) ──

function isTyping(target) {
  return target instanceof HTMLElement
    && (target.isContentEditable || ["INPUT", "TEXTAREA", "SELECT"].includes(target.tagName));
}

/** Streamer has the keys when focus is in it, or nowhere (after a click on
 * the preview's empty parts). Not in the library, a dialog or another menu. */
function streamerHasFocus(e) {
  const a = document.activeElement;
  if (root.contains(e.target) || root.contains(a)) return true;
  return !a || a === document.body || a === document.documentElement;
}

function onKey(e) {
  if (!open || e.defaultPrevented) return;
  if (menu?.box.contains(e.target) || props?.box.contains(e.target)) return;
  if (e.target instanceof Element && e.target.closest("[role=dialog]:not(.sm-props), .settings-overlay, .mode-menu")) return;
  const mod = e.ctrlKey || e.metaKey;
  const typing = isTyping(e.target);
  const ours = streamerHasFocus(e);

  // Delete and Backspace: a layer's, never the song's. The studio trashes the
  // open song on Delete (catalog.js); while Streamer has the keys it never
  // gets them.
  if ((e.key === "Delete" || e.key === "Backspace") && !typing && !mod && ours) {
    e.preventDefault();
    e.stopPropagation();
    if (selected && tab === "builder") deleteOf(selected);
    return;
  }
  // Undo and redo of the scene.
  if (mod && !e.altKey && !typing && ours && (e.code === "KeyZ" || e.code === "KeyY")) {
    e.preventDefault();
    e.stopPropagation();
    if (e.code === "KeyY" || e.shiftKey) doRedo();
    else doUndo();
    return;
  }
  if (mod || e.altKey || typing) return;
  // Arrows nudge the selected layer 1% (Shift: 5%), one undo step each.
  if (ours && tab === "builder" && selected && ["ArrowLeft", "ArrowRight", "ArrowUp", "ArrowDown"].includes(e.key)
      && !(e.target instanceof Element && e.target.closest("[role=slider], [role=tablist], .sm-layer-grip"))) {
    e.preventDefault();
    e.stopPropagation();
    const s = e.shiftKey ? 0.05 : 0.01;
    const dx = e.key === "ArrowLeft" ? -s : e.key === "ArrowRight" ? s : 0;
    const dy = e.key === "ArrowUp" ? -s : e.key === "ArrowDown" ? s : 0;
    commit(nudgeLayer(scene, selected, dx, dy));
    return;
  }
  // Space or Enter on one of this view's own controls presses that control
  // only: the studio's Space would also start or stop playback.
  if ((e.code === "Space" || e.key === "Enter") && e.target instanceof Element
      && e.target.closest("#streamer button, #streamer select, #streamer [role=switch], #streamer [role=slider], #streamer [role=button]")) {
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
  loadSettings();
  onDevicesChange(() => {
    painted.devices = null;
    painted.layers = null;
  });
  onLanguageChange(() => relabel());
  if (railBtn) {
    railBtn.title = t("streamer.rail");
    railBtn.setAttribute("aria-label", t("streamer.rail"));
  }
}
