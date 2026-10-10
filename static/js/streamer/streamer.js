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
// Phases 1 to 4 of docs/plans/0.21.0/streamer-mode.md: the shell, the
// preview, the layers, the take timeline, the camera and input, and
// recording (streamerRecord.js) and export (streamerExport.js).

import { t, onLanguageChange } from "../i18n.js";
import { currentJobId, mixerState, trackIndex, totalDuration, audioEngine, loopEnabled, loopStart, loopEnd } from "../state.js";
import { transport, setPlayheadTime, togglePlayPause, stopTransport, setLoopRange } from "../transport.js";
import { laneLabel, STEM_COLORS } from "../constants.js";
import { karaokeLyrics } from "../lyrics.js";
import { getCurrentTrackInfo } from "../catalog.js";
import { getSections, sectionDisplayName } from "../sections.js";
import { overviewPeaks, setPlaybackExclusion, playbackExclusion } from "../player.js";
import {
  choiceKey, parseChoice, serializeChoice, offeredChoices, effectiveChoice, excludedNames, sameNames,
  timelineLanes, BASE_STEMS,
} from "../partChoice.js";
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
  outputSize, imageKey, IMAGE_TYPES, IMAGE_MAX_BYTES,
} from "./streamerModel.js";
import { preparePicture, saveImage, pictureFor, onPictureLoaded, forgetAllPictures, pruneImages } from "./sceneImages.js";
import { getBeats, getBeatGridSnap } from "../beatgrid.js";
import { getTracks, requestTakesReload } from "../capture/takeLanes.js";
import { loadScene, saveScene, flushScene } from "./sceneStore.js";
import {
  SETTINGS_KEY, NONE, defaultRecordingSettings, parseRecordingSettings, serializeRecordingSettings,
  resolveDeviceId, isHeavy, applySettings, METER_SEGMENTS, METER_FLOOR_DB, meterFraction, levelDb, segmentZone,
  litSegments, holdPeak, newPeakState,
} from "./outputSettings.js";
import {
  startDevices, stopDevices, allowDevices, retryDevice, reconcile, cameraSource, cameraState,
  inputState, inputLevel, deviceLists, onDevicesChange, getStreamerMedia,
} from "./streamerDevices.js";
import { reasonMessage } from "../capture/capturePermission.js";
import { friendlyName, normaliseDevices, defaultInputDevice, fillInputSelect, channelText } from "../capture/trackInputs.js";
import {
  resolveInput, inputValue, autoPickStep, createLivePeaks, resetLivePeaks, addLivePeak, fillLiveBars, takeLaneState,
  videoLaneState, videoLaneNote, filmSpan, cameraUse,
} from "./inputModel.js";
import { loadFilmstrip, drawFilmstrip } from "../video/videoLane.js";
import { openRecordingSettings } from "../capture/recordingSettings.js";
import { storeGet, storeSet } from "../utils.js";
import { toggleStemMute, getMixMode, holdLaneSilent } from "../mixer.js";
import { isMixSwitching } from "../mixMode.js";
import {
  startRecording, stopRecording, drawOutput, recordState, takeOpen, onRecordChange, recordBlock,
  lastTake, streamerTrackId, markExport, takeInfo, forgetTake,
} from "./streamerRecord.js";
import { encoderNote } from "../videoEncoderNote.js";
import { renderRequest, exportTake, cancelExport, saveRawRecording, rawRecordingType, canRevealSaved, revealSaved, forgetSaved } from "./streamerExport.js";
import { shouldAutoStop, exportFileName, rawExtension, takeHoldStep, reviewStep } from "./recordModel.js";
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
// "I play": the part the musician plays, left out of the backing track they
// hear and export. Streamer's own choice per song (partChoice.js); the other
// modes keep theirs.
const PART_MODE = "streamer";

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
  output: [["rect", { x: 3, y: 4, width: 18, height: 16, rx: 2 }], "M15 4v16"],
  play: [["path", { d: "M7 4.5v15l12-7.5z", fill: "currentColor", stroke: "none" }]],
  pause: [["rect", { x: 6, y: 5, width: 4, height: 14, rx: 1, fill: "currentColor", stroke: "none" }], ["rect", { x: 14, y: 5, width: 4, height: 14, rx: 1, fill: "currentColor", stroke: "none" }]],
  stop: [["rect", { x: 6, y: 6, width: 12, height: 12, rx: 1.5, fill: "currentColor", stroke: "none" }]],
  speaker: [["path", { d: "M4 9h4l5-4v14l-5-4H4z", fill: "currentColor" }], "M16.5 8.5a5 5 0 0 1 0 7M19 6a8.5 8.5 0 0 1 0 12"],
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
  // Focus moves here on open (Delete, R and the arrows are then Streamer's).
  root.tabIndex = -1;

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
  // While a take records: the input's level, so sound arriving shows at once.
  const recLevel = el("span", "sm-rec-level");
  recLevel.setAttribute("aria-hidden", "true");
  pill.append(ring, tx(el("span", "sm-rec-label"), "streamer.recReady"), recLevel);
  const recTime = el("span", "sm-rec-time", clockHours(0));
  rec.append(pill, recTime);
  rec.setAttribute("aria-pressed", "false");
  tx(rec, "streamer.recStart", "aria-label");
  // Record and Stop (also the R key).
  rec.addEventListener("click", (e) => {
    e.stopPropagation();
    toggleRecording();
  });
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
  return { panel, preview, canvas, rec, recLabel: pill.querySelector(".sm-rec-label"), recTime, recLevel, selbox, camState, camText, camAct, clockNow, clockDur, undo, redo, layers, timeline };
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
    const name = el("span", "sm-tl-label-name");
    label.append(icon(ICONS.wave, { size: 14, width: 2 }), name);
    audioLabels.append(label);
    const c = el("canvas", `sm-tl-lane sm-tl-lane-${i}`);
    audio.append(c);
    lanes.push({ label, name, canvas: c, key: null });
  }
  // The take lane's mute (the take track's own, in Performance's mix).
  const takeMute = button("sm-tl-mute");
  takeMute.append(icon(ICONS.speaker, { size: 13, width: 2 }));
  tx(takeMute, "streamer.lane.muteTake", "label");
  takeMute.setAttribute("aria-pressed", "false");
  takeMute.hidden = true;
  takeMute.addEventListener("click", (e) => {
    e.stopPropagation();
    toggleTakeMute();
  });
  lanes[1].label.append(takeMute);
  // "I play": the part left out of the backing track (top left of the card).
  const partBox = el("div", "sm-part");
  const partSel = selectBox("sm-part-select");
  partSel.sel.id = "streamerPart";
  const partLabel = tx(el("label", "sm-part-label"), "streamer.part.label");
  partLabel.htmlFor = "streamerPart";
  tx(partSel.sel, "streamer.part.aria", "title");
  partSel.sel.addEventListener("change", () => choosePart(partSel.sel.value));
  partBox.append(partLabel, partSel.wrap);
  // The take lane before a take: empty, with a hint (never the stem's own wave).
  const takeHint = tx(el("p", "sm-tl-note sm-tl-take-hint"), "streamer.lane.emptyHint");
  takeHint.hidden = true;
  audio.append(takeHint);
  // The take on the video lane: a block that grows while it records, then
  // the take's frames (its filmstrip) where it sits in the song.
  const takeBlock = el("div", "sm-tl-take");
  takeBlock.hidden = true;
  const film = el("canvas", "sm-tl-film");
  film.setAttribute("aria-hidden", "true");
  takeBlock.append(film);
  // What the lane cannot show, said in words (no video part, frames that
  // failed, a take filmed without the camera).
  const videoNote = el("p", "sm-tl-video-note");
  videoNote.hidden = true;
  video.append(takeBlock, videoNote);
  // A song without stems, and one without sections, say so in their rows.
  const noStems = tx(el("p", "sm-tl-note sm-tl-no-stems"), "streamer.noStems");
  noStems.hidden = true;
  audio.append(noStems);
  const noSections = tx(el("p", "sm-tl-note sm-tl-no-sections"), "streamer.noSections");
  noSections.hidden = true;
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

  grid.append(mask, markers, noSections, ruler, videoLabel, video, audioLabels, audio, dims, overlay, tip);
  scroll.append(grid);
  scroll.addEventListener("scroll", () => { painted.lanes = null; });
  // A plain wheel scrolls the zoomed song sideways.
  scroll.addEventListener("wheel", (e) => {
    if (zoom <= 0 || e.ctrlKey || Math.abs(e.deltaX) > Math.abs(e.deltaY)) return;
    e.preventDefault();
    scroll.scrollLeft += e.deltaY;
  }, { passive: false });
  card.append(partBox, zoomBox, scroll);
  return {
    partSel: partSel.sel,
    takeHint, takeBlock, film, videoNote, takeMute,
    card, zoomBox, zTrack, zFill, zThumb, zOut, zIn, scroll, grid, mask, markers, ruler, video, audio, lanes,
    range, trimIn, trimOut, dimL, dimR, tip, head, headTime, noStems, noSections,
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
  asrc.sel.addEventListener("change", () => chooseInput(asrc.sel.value));
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
  for (const [v, k] of [["1080", "streamer.res1080"], ["720", "streamer.res720"]]) option(res.sel, v, k);
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
  // 60 fps is allowed, with a warning about the computer's load.
  const heavy = tx(el("p", "sm-heavy"), "streamer.heavy");
  heavy.hidden = true;
  const switches = el("div", "sm-out-switches");
  const sw = {};
  for (const [key, k] of [["recordMixedAudio", "streamer.recMixed"], ["includeClick", "streamer.recClick"], ["autoStopAtEnd", "streamer.recAutostop"]]) {
    sw[key] = makeSwitch("", k, settings[key], (on) => setSetting({ [key]: on }));
    sw[key].b.dataset.setting = key;
    switches.append(sw[key].b);
  }
  // The last take: Export MP4, its progress and Cancel, Show in folder, and
  // the raw recording when no MP4 can be made.
  const exp = el("div", "sm-export");
  exp.hidden = true;
  const expText = el("p", "sm-export-text");
  expText.setAttribute("role", "status");
  const expBar = el("progress", "sm-export-bar");
  expBar.max = 1;
  expBar.value = 0;
  expBar.hidden = true;
  const expRow = el("div", "sm-export-row");
  const expGo = button("sm-primary sm-export-go");
  expGo.addEventListener("click", () => runExport());
  const expCancel = tx(button("sm-ib sm-export-cancel"), "streamer.export.cancel");
  expCancel.addEventListener("click", () => cancelRunningExport());
  const expReveal = tx(button("sm-ib sm-export-reveal"), "streamer.export.reveal");
  expReveal.addEventListener("click", () => {
    revealSaved().catch((err) => {
      console.warn("[streamer] showing the file failed:", err);
      flashNote(t("streamer.export.revealFailed"), expReveal);
    });
  });
  const expRaw = tx(button("sm-ib sm-export-raw"), "streamer.export.saveRaw");
  expRaw.addEventListener("click", () => saveRaw());
  expRow.append(expGo, expCancel, expReveal, expRaw);
  exp.append(expText, expBar, expRow);
  body.append(
    field("streamer.videoSource", "streamerVideoSrc", vsrc.sel), vsrc.wrap, vstate.line,
    field("streamer.audioSource", "streamerAudioSrc", asrc.sel), asrc.wrap, astate.line,
    meterRow, grid, heavy, switches, exp,
  );
  rec.append(recHead, body);

  // Export to a file is the only way out for now (upload and streaming to
  // platforms are postponed: docs/plans/0.21.0/integrations-*.md).
  aside.append(rec);
  return {
    aside, fps: fps.sel, vsrc: vsrc.sel, asrc: asrc.sel, vstate, astate,
    meter, meterRows, level, res: res.sel, heavy, sw,
    exp, expText, expBar, expGo, expCancel, expReveal, expRaw,
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
  const was = root.classList.contains("sm-drawer-open");
  // The drawer opens under the mode header, wherever it ends (it wraps when narrow).
  const head = ui.head.card.getBoundingClientRect();
  root.style.setProperty("--sm-drawer-top", `${Math.round(head.bottom - root.getBoundingClientRect().top + 8)}px`);
  root.classList.toggle("sm-drawer-open", on);
  ui.head.output.setAttribute("aria-expanded", String(on));
  // Opened: focus goes into it. Closed with focus inside: back to Output.
  if (on && !was) ui.side.vsrc.focus({ preventScroll: true });
  else if (!on && was && ui.side.aside.contains(document.activeElement)) ui.head.output.focus({ preventScroll: true });
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
  // The panel's thumbnails show the remote picture; the canvas draws the
  // same picture from this origin (/api/jobs/{id}/cover), so it never taints
  // the canvas the recorder captures.
  const thumb = img && img.getAttribute("src") && !img.hidden && img.naturalWidth > 0 ? img : null;
  return { title: title === NO_TITLE ? "" : title, artist, art: thumb ? coverFor(currentJobId) : null, thumb };
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
  // Shown, not edited: nothing is saved (sceneStore.js: a song only viewed
  // leaves no trace).
  afterChange({ save: false });
}

/** The scene is now `next`, made from `from` (the scene before the edit):
 * one undo step, saved for this song. */
function commit(next, from = scene) {
  if (!next || next === from) return false;
  // While a take is open: no new aspect, set of layers, order or trim.
  if (takeOpen() && reshapes(from, next)) return false;
  history = pushHistory(history, from);
  scene = next;
  afterChange();
  return true;
}

// Pictures nothing can show any more (replaced, removed, their layer
// deleted) leave IndexedDB a moment after the change: kept while the scene or
// its undo history still names them.
let pruneTimer = 0;
function schedulePrune() {
  clearTimeout(pruneTimer);
  const job = sceneJob;
  if (!job) return;
  pruneTimer = setTimeout(() => {
    if (job !== sceneJob) return;
    const keep = new Set();
    for (const sc of [scene, ...history.past, ...history.future]) {
      for (const l of sc?.layers || []) if (l.props?.imageKey) keep.add(l.props.imageKey);
    }
    pruneImages(`${job}:`, keep).catch((err) => console.warn("[streamer] clearing old pictures failed:", err));
  }, 2000);
}

/** Whether `next` changes what a take films the shape of: the aspect, the
 * layers or their order, or the trim. */
function reshapes(from, next) {
  const ids = (sc) => sc.layers.map((l) => l.id).join("|");
  const trim = (sc) => JSON.stringify(sc.trim || null);
  return from.aspect !== next.aspect || ids(from) !== ids(next) || trim(from) !== trim(next);
}

/** Repaint, and save after the scene changed (an edit, undo or redo). */
function afterChange({ save = true } = {}) {
  if (selected && !scene.layers.some((l) => l.id === selected)) selected = null;
  if (save) {
    saveScene(sceneJob, scene);
    schedulePrune();
  }
  if (ui) ui.head.aspect.value = scene.aspect;
  painted.scene = null;
  painted.layers = null;
  painted.tlTrim = null;
  paintHistory();
}

function doUndo() {
  // While a take is open the scene's shape stays as it is being filmed.
  if (takeOpen()) return;
  const r = undoHistory(history, scene);
  if (!r.scene) return;
  history = r.history;
  scene = r.scene;
  afterChange();
}

function doRedo() {
  if (takeOpen()) return;
  const r = redoHistory(history, scene);
  if (!r.scene) return;
  history = r.history;
  scene = r.scene;
  afterChange();
}

function paintHistory() {
  if (!ui) return;
  ui.builder.undo.disabled = !history.past.length || takeOpen();
  ui.builder.redo.disabled = !history.future.length || takeOpen();
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
  // Focus goes into the view, and back to what opened it on close.
  opener = document.activeElement instanceof HTMLElement && !root.contains(document.activeElement) ? document.activeElement : null;
  focusView();
  return true;
}

let opener = null;

/** Focus the preview (the view itself while no song is open). */
function focusView() {
  const preview = ui?.builder.preview;
  const usable = preview && tab === "builder" && !ui.center.inert && preview.offsetParent;
  (usable ? preview : root).focus({ preventScroll: true });
}

export function closeStreamer() {
  if (!open) return;
  // A take in progress stops first and is kept (on the Streamer track): it
  // can still be exported when Streamer opens again.
  if (takeOpen()) stopRecording();
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
  // The whole song again (only playback changes; the choice stays saved).
  applyPart();
  const a = document.activeElement;
  if (!a || a === document.body || root.contains(a)) {
    const back = opener?.isConnected && opener.offsetParent ? opener : railBtn;
    back?.focus({ preventScroll: true });
  }
  opener = null;
}

export function toggleStreamer() {
  if (open) {
    if (refuseWhileTake(railBtn)) return;
    closeStreamer();
  } else openStreamer();
}

/** A Streamer take is open (starting, recording or stopping). */
export function isStreamerTakeOpen() {
  return takeOpen();
}

/** Leaving Streamer (the rail, another mode) waits for the take to stop:
 * true (and a note beside `anchor`) when it is refused. */
export function refuseWhileTake(anchor) {
  if (!open || !takeOpen()) return false;
  flashNote(t("streamer.rec.stopFirst"), anchor || railBtn);
  return true;
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
    // The last song's pictures are let go (they load again when shown).
    forgetAllPictures();
    if (job) showSceneFor(job);
    // The last song's export result is not this one's (an export still
    // running says whose take it is: paintExport).
    if (!exporting) {
      exportNote = "";
      exportError = null;
    }
    painted.exp = null;
    if (job) checkLastTake(job);
    loadPart(job);
  }
  const hasTrack = Boolean(job && transport() && totalDuration > 0);
  if (painted.hasTrack !== hasTrack) {
    painted.hasTrack = hasTrack;
    root.classList.toggle("sm-empty-view", !hasTrack);
    ui.noTrack.hidden = hasTrack;
    // No song: the message covers the view and nothing under it is reachable.
    for (const node of [ui.center, ui.side.aside]) node.toggleAttribute("inert", !hasTrack);
    if (!hasTrack) toggleDrawer(false);
  }
  // A take filming one song while another opens stops (and is kept with its
  // song): once, not every frame while it is stopping.
  if (takeOpen() && recordState().jobId && recordState().jobId !== job) {
    if (!songChangeStop) {
      songChangeStop = true;
      stopRecording();
      flashNote(t("streamer.rec.songChanged"), ui.builder.rec);
    }
  } else if (!takeOpen()) songChangeStop = false;
  const tNow = hasTrack ? now() : 0;
  const meta = trackMeta();
  paintTransport(hasTrack);
  paintDevices();
  paintMeter();
  syncTakeHold(job);
  reviewTake(job);
  const lyrics = lyricWindow(lyr.lines, tNow, 7);
  const data = frameData(tNow, meta, lyrics);
  takeTick(tNow, data);
  feedLive(tNow);
  paintRecord();
  if (tab !== "builder") return;
  paintLayers(meta, lyrics);
  paintPreview(tNow, meta, lyrics, data);
  paintClock(tNow);
  paintTimeline(tNow);
  paintPart();
}

let songChangeStop = false;
let lastOutMs = -Infinity;
let hiddenTimer = 0;

/**
 * While a take is open: the output frame, drawn when the next one is due at
 * the take's frame rate (the canvas stream takes no more than that), and the
 * stop at the trim's out point. From the frame loop, or from a timer while
 * the window is hidden (no frames are drawn there).
 */
function takeTick(tNow, data = null) {
  if (!takeOpen()) return;
  const nowMs = performance.now();
  const fps = Number(settings.fps) || 30;
  if (nowMs - lastOutMs >= 1000 / fps - 4) {
    lastOutMs = nowMs;
    const d = data || frameData(tNow, trackMeta(), lyricWindow(lyr.lines, tNow, 7));
    // The take films the scene without the editor's overlays, on every tab.
    drawOutput((ctx, w, h) => renderScene(ctx, scene, d, sceneOptions(w, h, null)));
  }
  const st = recordState();
  if (st.state === "recording" && shouldAutoStop({ t: tNow, range: trimRange(scene, totalDuration), duration: totalDuration, autoStop: settings.autoStopAtEnd })) {
    stopRecording();
  }
}

/** A hidden window draws no frames: a take keeps its picture and its
 * auto-stop going from a timer (about ten times a second) until it shows. */
function onVisibility() {
  clearInterval(hiddenTimer);
  hiddenTimer = 0;
  if (!document.hidden || !open) return;
  hiddenTimer = setInterval(() => {
    if (!document.hidden || !open || !takeOpen()) {
      clearInterval(hiddenTimer);
      hiddenTimer = 0;
      return;
    }
    try { takeTick(now()); } catch (err) { console.warn("[streamer] hidden take tick failed:", err); }
  }, 100);
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

/** One frame of the song for the renderer: the same for the preview and the take. */
function frameData(tNow, meta, lyrics) {
  return {
    t: tNow,
    duration: totalDuration || 0,
    title: meta.title,
    artist: meta.artist,
    art: meta.art,
    camera: cameraSource(),
    lyrics,
    bars: waveBars(),
    images: scenePictures(),
  };
}

/** The scene's chosen pictures that have loaded: imageKey -> <img>. */
function scenePictures() {
  const out = new Map();
  for (const l of scene.layers) {
    const key = l.props?.imageKey;
    if (!key || out.has(key)) continue;
    const img = pictureFor(key);
    if (img) out.set(key, img);
  }
  return out;
}

/** The output's width at the chosen resolution and the scene's aspect. */
function outputWidth() {
  return outputSize(scene.aspect, Number(settings.resolution) || 1080).width;
}

/** The renderer's options at `w` x `h`; `editor` null for the take. */
function sceneOptions(w, h, editor) {
  return {
    width: w,
    height: h,
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
    editor,
  };
}

function paintPreview(tNow, meta, lyrics, data) {
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
  const sig = [cw, ch, dpr, safeZones, selected, meta.title, meta.artist, meta.art ? meta.art.src : "", lyricSig, played, painted.barsSig, totalDuration, t("streamer.textPlaceholder"), cam ? cam.currentTime : -1].join("§");
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
  renderScene(ctx, scene, data, sceneOptions(f.w, f.h, { selection: selected, safeZones }));
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
// A drag in progress (the preview or a trim handle): a key that edits the
// scene (Delete, undo) ends it first, put back where it began, so no
// half-made step is left behind or undone twice.
let liveDrag = null;
function cancelLiveDrag() {
  const d = liveDrag;
  liveDrag = null;
  d?.cancel();
}

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
    const pointerId = e.pointerId;
    liveDrag = {
      cancel: () => {
        if (!drag) return;
        scene = drag.base;
        drag = null;
        painted.scene = null;
        try { preview.releasePointerCapture(pointerId); } catch { /* already released */ }
      },
    };
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
    liveDrag = null;
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
    case "background": return t(layer.props?.imageKey ? "streamer.sub.imageChosen" : "streamer.sub.background");
    case "text": return layer.props?.text || t("streamer.sub.textEmpty");
    case "image": return t(layer.props?.imageKey ? "streamer.sub.imageChosen" : "streamer.sub.image");
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
  const sig = order.map((l) => `${l.id}:${l.visible ? 1 : 0}:${l.name || ""}:${layerSub(l, meta, lyrics)}`).join("|") + `|${selected}|${locked}|${meta.thumb?.currentSrc || ""}`;
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
      const src = meta.thumb?.currentSrc || meta.thumb?.src || "";
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
    case "image":
    case "background":
      body.append(pictureFields(layer, set));
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

/** Choose a picture (PNG, JPEG or WebP) from the computer, or remove it.
 * The background covers the picture, an image layer contains it. */
function pictureFields(layer, set) {
  const wrap = el("div", "sm-props-picture");
  const file = el("input");
  file.type = "file";
  file.accept = IMAGE_TYPES.join(",");
  file.hidden = true;
  file.tabIndex = -1;
  const row = el("div", "sm-props-row");
  const choose = button("sm-primary sm-props-choose");
  const remove = button("sm-ib sm-props-remove");
  remove.textContent = t("streamer.props.removeImage");
  const msg = el("p", "sm-props-hint sm-props-picture-msg");
  msg.setAttribute("role", "status");
  const paint = (has) => {
    choose.textContent = t(has ? "streamer.props.replaceImage" : "streamer.props.chooseImage");
    remove.hidden = !has;
  };
  paint(Boolean(layer.props.imageKey));
  msg.textContent = t(layer.type === "background" ? "streamer.props.imageHintCover" : "streamer.props.imageHintContain");
  choose.addEventListener("click", () => file.click());
  remove.addEventListener("click", () => {
    set({ imageKey: "" });
    paint(false);
    msg.textContent = t("streamer.props.imageRemoved");
    choose.focus({ preventScroll: true });
  });
  const job = sceneJob;
  file.addEventListener("change", async () => {
    const f = file.files?.[0];
    file.value = "";
    if (!f || !job) return;
    msg.textContent = t("streamer.props.imageWorking");
    choose.disabled = true;
    try {
      const blob = await preparePicture(f, outputWidth());
      const key = imageKey(job, layer.id, Date.now().toString(36));
      await saveImage(key, blob);
      // The song may have changed while it was being shrunk: its scene only.
      if (sceneJob !== job) return;
      set({ imageKey: key });
      pictureFor(key);
      paint(true);
      msg.textContent = t("streamer.props.imageSaved", { kb: Math.max(1, Math.round(blob.size / 1024)) });
    } catch (err) {
      console.warn("[streamer] the picture was not kept:", err);
      const code = err?.code;
      msg.textContent = code === "too-big"
        ? t("streamer.props.imageTooBig", { mb: Math.round(IMAGE_MAX_BYTES / 1048576) })
        : t(code === "type" || code === "decode" ? "streamer.props.imageType" : "streamer.props.imageFailed");
    } finally {
      choose.disabled = false;
    }
  });
  row.append(choose, remove);
  wrap.append(file, row, msg);
  return wrap;
}

function closeProps({ focus = true } = {}) {
  if (!props) return;
  const { box, anchor } = props;
  props = null;
  // Its texts go with it (they would pile up with every panel opened).
  texts = texts.filter(([n]) => !box.contains(n));
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
  settings = applySettings(settings, patch);
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
// The devices a take opened with: kept as they are until it ends (no tab,
// layer or select change closes the camera or the input mid-take).
let takeDevices = null;

function wantedDevices() {
  if (takeOpen() && takeDevices) return takeDevices;
  const lists = deviceLists();
  const camLayer = scene.layers.some((l) => l.type === "camera" && l.visible);
  const camera = (tab === "builder" || takeOpen()) && camLayer && settings.videoDeviceId !== NONE
    ? resolveDeviceId(settings.videoDeviceId, lists.video) : null;
  // The input the take records (the studio's choice until one is picked here).
  const input = recordingInput();
  const audio = input ? input.deviceId : null;
  const audioChannelCount = input ? Math.max(...input.channels) + 1 : 2;
  return { camera, audio, settings, audioChannelCount };
}

// The inputs as the studio lists them (trackInputs.normaliseDevices), from
// the browser's list, kept until that list changes.
let inputs = { raw: null, devices: [] };
function inputDevices() {
  const raw = deviceLists().audio;
  if (inputs.raw !== raw) inputs = { raw, devices: normaliseDevices(raw) };
  return inputs.devices;
}

/** The input and channels a take records from now, or null (no input). */
function recordingInput() {
  const devices = inputDevices();
  return resolveInput(settings, devices, defaultInputDevice(devices, "audio"));
}

/** The Audio Source select: no input, then the studio's list (a microphone,
 * each channel and pair of an interface), the input in use selected. */
let inputChoices = new Map();
function fillInputChoice(sel) {
  const devices = inputDevices();
  const cur = recordingInput();
  const sig = `${devices.map((d) => `${d.deviceId}:${d.name}:${d.channels}`).join("|")}|${t("streamer.noAudioInput")}|${t("rec.input.voiceGroup")}`;
  if (sel.dataset.sig !== sig) {
    sel.dataset.sig = sig;
    inputChoices = devices.length ? fillInputSelect(sel, devices, { withChannels: true }) : new Map();
    if (!devices.length) {
      sel.replaceChildren();
      // Before permission the names are hidden: the Settings input is used.
      const o = el("option", null, t("capture.defaultDevice"));
      o.value = "";
      sel.append(o);
    }
    const none = el("option", null, t("streamer.noAudioInput"));
    none.value = NONE;
    sel.prepend(none);
  }
  const want = cur ? inputValue(cur.deviceId, cur.channels) : NONE;
  sel.value = [...sel.options].some((o) => o.value === want) ? want : (cur ? "" : NONE);
}

function chooseInput(value) {
  if (value === NONE) {
    setSetting({ audioDeviceId: NONE, audioChannels: null });
    return;
  }
  const picked = inputChoices.get(value);
  if (picked) setSetting({ audioDeviceId: picked.device.deviceId, audioChannels: picked.channels });
  else setSetting({ audioDeviceId: "", audioChannels: null });
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

function paintDeviceLine(line, kind, st, selectedNone, note = "") {
  const msg = note || deviceMessage(kind, st, selectedNone || (kind === "audio" && st.noEngine));
  line.line.hidden = !msg;
  line.line.classList.toggle("sm-dev-bad", Boolean(st.reason));
  if (line.text.textContent !== msg) line.text.textContent = msg;
  const key = note ? null : actionKey(st);
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
  fillInputChoice(side.asrc);
  side.res.value = settings.resolution;
  side.fps.value = String(settings.fps);
  for (const [key, s2] of Object.entries(side.sw)) s2.set(settings[key]);
  side.heavy.hidden = !isHeavy(settings);
  paintDeviceLine(side.vstate, "video", c, settings.videoDeviceId === NONE);
  // One Allow is enough: it opens both. The input's line says it only when
  // the camera's does not.
  const askBoth = !c.mayAsk && !c.reason && !a.mayAsk && !a.reason && settings.videoDeviceId !== NONE;
  // No input chosen: the take still records, with the song only.
  const noInput = settings.audioDeviceId === NONE ? t("streamer.mic.none") : "";
  paintDeviceLine(side.astate, "audio", a, settings.audioDeviceId === NONE || askBoth, noInput);
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
let autoPick = null;
let meterInput = null;
function paintMeter() {
  const side = ui.side;
  const live = inputState().live;
  const nowMs = performance.now();
  // The meter shows the channels the take records (a second row: the pair's
  // other half, else the same channel); the same input the take lane draws.
  if (!meterInput || painted.meterSettings !== settings || painted.meterInputs !== inputs.devices) {
    painted.meterSettings = settings;
    painted.meterInputs = inputs.devices;
    meterInput = recordingInput();
  }
  const chans = meterInput?.channels || [0];
  autoPickInput(live);
  let top = 0;
  side.meterRows.forEach((row, c) => {
    holdPeak(row.peak, live ? inputLevel(chans[c] ?? chans[0]) : 0, nowMs);
    top = Math.max(top, row.peak.value);
    const lit = litSegments(meterFraction(row.peak.value));
    if (lit === row.lit) return;
    const from = Math.min(lit, row.lit);
    const to = Math.max(lit, row.lit);
    for (let k = from; k < to; k++) row.segs[k].classList.toggle("on", k < lit);
    row.lit = lit;
  });
  const recFrac = takeOpen() ? Math.round(meterFraction(top) * 50) / 50 : 0;
  if (painted.recLevel !== recFrac) {
    painted.recLevel = recFrac;
    ui.builder.recLevel.style.transform = `scaleX(${recFrac})`;
  }
  const db = levelDb(top);
  if (painted.meterDb !== db) {
    painted.meterDb = db;
    side.level.textContent = `${db} dB`;
    side.meter.setAttribute("aria-valuenow", String(db));
  }
}

/** An input not picked by hand that stays silent while another channel of
 * the same device carries a signal moves to it, once (the studio's rule). */
function autoPickInput(live) {
  const cap = live ? streamerMedia().capture : null;
  if (!cap || !meterInput?.auto || meterInput.kind === "voice" || takeOpen()) {
    autoPick = null;
    return;
  }
  const step = autoPickStep(autoPick, meterInput.channels, (ch) => cap.channelLevel([ch]), cap.deviceChannels || 1);
  autoPick = step.state;
  if (step.pick < 0) return;
  setSetting({ audioDeviceId: meterInput.deviceId, audioChannels: [step.pick] });
  flashNote(t("streamer.mic.autoInput", { input: channelText([step.pick]) }), ui.side.asrc);
}

/** Phase 4's seam: the camera and input streams Streamer has open (or null). */
export function streamerMedia() {
  return getStreamerMedia();
}

// ── Recording and export ──

// The song's cover from this origin, one per song (null until it loads, or
// when the song has none).
const covers = new Map();
function coverFor(jobId) {
  if (!jobId) return null;
  let c = covers.get(jobId);
  if (!c) {
    const img = new Image();
    c = { img, ok: false };
    img.onload = () => { c.ok = true; painted.scene = null; };
    img.onerror = () => { c.ok = false; };
    img.src = `/api/jobs/${encodeURIComponent(jobId)}/cover`;
    covers.set(jobId, c);
  }
  return c.ok ? c.img : null;
}

// The Performance track's take plays with the backing, so the musician can
// review it (recordModel.takeHoldStep). While a NEW take records, the last
// one is held silent (mixer.holdLaneSilent: never a mute, never saved into
// any mode's record) and let go when the take ends.
let heldTake = null;

/** Hold or let go of the last take for the take now open (or not). From the
 * frame loop and from every recorder state change (the view may be closed). */
function syncTakeHold(job) {
  const open2 = takeOpen();
  const id = open2 ? streamerTrackId(recordState().jobId || job) : null;
  const step = takeHoldStep(heldTake, { open: open2, trackId: id });
  if (step.release) holdLaneSilent(step.release, false);
  if (step.hold) holdLaneSilent(step.hold, true);
  heldTake = step.held;
}

// A take just saved: { job, take }, until its track plays unmuted in
// Performance's mix (reviewStep). A mix saved muted by an earlier version,
// which muted this track every frame, is unmuted the same way.
let reviewPending = null;

function reviewTake(job) {
  const p = reviewPending;
  if (!p) return;
  const id = streamerTrackId(p.job);
  // The song reloads after the take with a new engine: done once that engine
  // is ready (its start put the playhead at 0). Twenty seconds without a new
  // engine count as done (nothing reloaded).
  const eng = audioEngine;
  if (eng && eng !== p.engine && p.waiting !== eng) {
    p.waiting = eng;
    Promise.resolve(eng.ready).then(() => { if (reviewPending === p && p.waiting === eng) p.readyEngine = eng; }, () => {});
  }
  const reloaded = (p.readyEngine && p.readyEngine === audioEngine) || performance.now() - p.at > 20000;
  const step = reviewStep({
    pending: p,
    job,
    mode: getMixMode(),
    switching: isMixSwitching(),
    open: takeOpen(),
    loaded: Boolean(id && trackIndex[id] !== undefined && mixerState[id]),
    peaksReady: Boolean(reloaded && overviewPeaks()?.data?.[p.take]),
    muted: Boolean(id && mixerState[id]?.muted),
  });
  if (step === "wait") return;
  const from = p.from;
  reviewPending = null;
  if (step === "unmute") toggleStemMute(id);
  painted.takeMute = null;
  // The song's reload after the take put the playhead at 0: back to where
  // the take began, so Play plays it with the backing at once.
  if (Number.isFinite(from) && step !== "drop" && job && !transport()?.isPlaying?.()) setPlayheadTime(from);
}

/** The take lane's mute: the take track's own mute in Performance's mix. */
function toggleTakeMute() {
  const job = currentJobId;
  const id = job && streamerTrackId(job);
  if (!id || takeOpen() || !mixerState[id] || trackIndex[id] === undefined) return;
  if (getMixMode() !== "streamer" || isMixSwitching()) return;
  toggleStemMute(id);
  painted.takeMute = null;
}

const BLOCK_KEY = {
  "tempo": "streamer.rec.tempo",
  "no-engine": "streamer.rec.noSong",
  "unsupported": "streamer.rec.unsupported",
  "busy": "streamer.rec.busy",
};

async function toggleRecording() {
  if (takeOpen()) {
    stopRecording();
    return;
  }
  const badge = ui.builder.rec;
  const job = currentJobId;
  if (!job || !totalDuration) {
    flashNote(t("streamer.rec.noSong"), badge);
    return;
  }
  const block = recordBlock();
  if (block) {
    flashNote(t(BLOCK_KEY[block] || "streamer.rec.failed"), badge);
    return;
  }
  const media = streamerMedia();
  // The last take is held silent from the "start" state change on
  // (syncTakeHold); a track the start finds on the server, from the next frame.
  const res = await startRecording({
    camera: cameraUse({ layerVisible: scene.layers.some((l) => l.type === "camera" && l.visible), live: cameraState().live }),
    remove: part.job === job ? part.remove : "",
    jobId: job,
    capture: inputState().live ? media.capture : null,
    channels: recordingInput()?.channels || [0],
    settings,
    aspect: scene.aspect,
    range: trimRange(scene, totalDuration),
    trackName: t("streamer.trackName"),
    draw: (ctx, w, h) => renderScene(ctx, scene, frameData(now(), trackMeta(), lyricWindow(lyr.lines, now(), 7)), sceneOptions(w, h, null)),
  });
  if (!res.ok) flashNote(t(BLOCK_KEY[res.reason] || "streamer.rec.failed"), badge);
  else if (!inputState().live) flashNote(t("streamer.rec.noMic"), badge);
}

let wasOpen = false;
/** The REC badge, the lock while a take is open, and the export block. */
function paintRecord() {
  const st = recordState();
  const open2 = takeOpen();
  if (open2 !== wasOpen) {
    wasOpen = open2;
    // While recording: no reorder, add or delete; no new canvas size.
    setStreamerLocked(open2);
    ui.head.aspect.disabled = open2;
    ui.side.res.disabled = open2;
    ui.side.fps.disabled = open2;
    ui.side.vsrc.disabled = open2;
    ui.side.asrc.disabled = open2;
    painted.part = null;
    takeDevices = open2 ? { ...wantedDevices() } : null;
    // A new take: the last one's export error is history.
    if (open2) {
      exportError = null;
      exportNote = "";
    }
    paintHistory();
    painted.devices = null;
    if (!open2 && st.hidden) flashNote(t("streamer.rec.hidden"), ui.builder.rec);
    else if (!open2 && st.stopReason === "transport") flashNote(t("streamer.rec.stopped"), ui.builder.rec);
  }
  // Back from a hidden window during a take: say the picture froze there.
  if (open2 && st.hidden && !document.hidden && !painted.hiddenWarned) {
    painted.hiddenWarned = true;
    flashNote(t("streamer.rec.hidden"), ui.builder.rec);
  }
  if (!open2) painted.hiddenWarned = false;
  const b = ui.builder;
  const recording = st.state === "recording" || st.state === "starting" || st.state === "stopping";
  const time = clockHours(st.elapsedSec);
  const sig = `${st.state}|${time}|${t("streamer.recReady")}`;
  if (painted.rec !== sig) {
    painted.rec = sig;
    b.rec.classList.toggle("recording", recording);
    b.rec.setAttribute("aria-pressed", String(recording));
    b.recLabel.textContent = t(recording ? "streamer.recOn" : "streamer.recReady");
    b.rec.setAttribute("aria-label", t(recording ? "streamer.recStop" : "streamer.recStart"));
    b.rec.title = b.rec.getAttribute("aria-label");
    b.recTime.textContent = time;
  }
  paintExport(st);
}

// The export in progress: { jobId, takeId, abort, raw }.
let exporting = null;
let exportNote = "";
let exportError = null; // { code, raw }

function paintExport(st) {
  const s = ui.side;
  const job = currentJobId;
  const take = job ? lastTake(job) : null;
  const busy = Boolean(exporting);
  const elsewhere = busy && exporting.jobId !== job;
  const shot = take ? takeInfo(take) : null;
  const asRecorded = shot && shot.aspect !== scene.aspect ? shot.aspect : "";
  const sig = `${st.state}|${take}|${busy}|${elsewhere}|${exportNote}|${exportError?.code || ""}|${asRecorded}|${t("streamer.export.go")}`;
  if (painted.exp === sig) return;
  painted.exp = sig;
  // Always there: the one way out of Streamer (export to a file), waiting
  // for a take when there is none.
  s.exp.hidden = false;
  if (takeOpen()) {
    s.expText.textContent = t(st.state === "stopping" ? "streamer.rec.saving" : "streamer.rec.recording");
    s.expBar.hidden = true;
    for (const btn of [s.expGo, s.expCancel, s.expReveal, s.expRaw]) btn.hidden = true;
    return;
  }
  s.expGo.hidden = busy;
  s.expGo.disabled = !take;
  s.expGo.textContent = t(exportError && exportError.code !== "no-encoder" ? "streamer.export.retry" : "streamer.export.go");
  s.expCancel.hidden = !busy;
  s.expBar.hidden = !busy;
  s.expReveal.hidden = !(st.state === "exported" && canRevealSaved());
  s.expRaw.hidden = exportError?.code !== "no-encoder";
  // A take recorded at another aspect than the scene's now is exported as
  // it was recorded (never stretched), and says so.
  const ready = asRecorded ? t("streamer.export.readyAsRecorded", { aspect: asRecorded }) : t("streamer.export.ready");
  s.expText.textContent = elsewhere
    ? t("streamer.export.otherSong", { note: exportNote })
    : exportNote || (take ? ready : t("streamer.export.none"));
}

async function runExport() {
  const job = currentJobId;
  const takeId = job ? lastTake(job) : null;
  if (!takeId || exporting || takeOpen()) return;
  const meta = trackMeta();
  const abort = new AbortController();
  exporting = { jobId: job, takeId, abort };
  exportError = null;
  exportNote = t("streamer.export.rendering", { pct: 0 });
  markExport("export", { jobId: job, takeId });
  forgetSaved();
  painted.exp = null;
  const bar = ui.side.expBar;
  bar.value = 0;
  try {
    // The take's own shape: the aspect, size and rate it was recorded at
    // (the scene may have changed since); never stretched.
    const shot = recordedShape(takeId);
    const body = renderRequest({
      trackId: streamerTrackId(job),
      settings: { ...settings, resolution: shot.resolution, fps: shot.fps },
      aspect: shot.aspect,
      // The part left out while it was recorded: the export's backing is the same.
      remove: shot.remove ?? (part.job === job ? part.remove : ""),
      range: trimRange(scene, totalDuration),
    });
    const res = await exportTake({
      jobId: job,
      takeId,
      body,
      filename: exportFileName(meta.title, meta.artist),
      signal: abort.signal,
      onProgress: (f) => {
        bar.value = f;
        exportNote = t("streamer.export.rendering", { pct: Math.round(f * 100) });
        painted.exp = null;
      },
      onTransferStart: () => {
        exportNote = t("streamer.export.saving");
        painted.exp = null;
      },
    });
    // Not saved (the save dialog was cancelled): back to ready, and Show in
    // folder does not point at an older file.
    markExport(res.saved ? "done" : "cancel");
    // Saved, with what made the video ("Encoded with NVIDIA GPU." or the
    // GPU fallback sentence) when the server said.
    const encoded = res.saved ? encoderNote(res, t) : "";
    exportNote = !res.saved
      ? t("streamer.export.notSaved")
      : encoded ? t("streamer.export.savedWith", { note: encoded }) : t("streamer.export.saved");
  } catch (err) {
    console.warn("[streamer] export failed:", err);
    if (err?.code === "cancelled") {
      markExport("cancel");
      exportNote = t("streamer.export.cancelled");
    } else if (err?.code === "gone") {
      // The take was deleted (in Advanced): nothing to export any more.
      markExport("fail");
      forgetTake(job, takeId);
      exportNote = t("streamer.export.takeGone");
    } else {
      markExport("fail");
      exportError = { code: err?.code || "failed" };
      // The server's reason, when it gave one, after the sentence.
      const reason = exportReason(err);
      exportNote = err?.code === "no-encoder" ? t("streamer.export.noEncoder")
        : reason ? t("streamer.export.failedWhy", { reason }) : t("streamer.export.failed");
    }
  } finally {
    exporting = null;
    painted.exp = null;
  }
}

/** What `takeId` was recorded at, else the current scene and settings. */
function recordedShape(takeId) {
  return takeInfo(takeId) || { aspect: scene.aspect, resolution: settings.resolution, fps: settings.fps, remove: null };
}

/** A short, readable reason from a failed export (the server's detail), or "". */
function exportReason(err) {
  const text = String(err?.message || "").replace(/\s+/g, " ").trim();
  if (!text || text === "render failed" || /^(failed|none)$/i.test(text)) return "";
  return text.length > 160 ? `${text.slice(0, 157)}...` : text;
}

/** The song's last take is still on the server (it can be deleted in
 * Advanced): when not, it is not offered for export. */
async function checkLastTake(job) {
  const takeId = lastTake(job);
  if (!takeId) return;
  try {
    const res = await fetch(`/api/jobs/${encodeURIComponent(job)}`, { cache: "no-store" });
    if (!res.ok) return;
    const takes = (await res.json())?.takes;
    if (!Array.isArray(takes)) return;
    const ids = takes.map((tk) => tk?.id ?? tk?.take_id);
    if (!ids.includes(takeId) && lastTake(job) === takeId && !takeOpen()) {
      forgetTake(job, takeId);
      painted.exp = null;
    }
  } catch (err) {
    console.warn("[streamer] checking the last take failed:", err);
  }
}

function cancelRunningExport() {
  if (!exporting) return;
  const { jobId, takeId, abort } = exporting;
  abort.abort();
  cancelExport(jobId, takeId);
}

function saveRaw() {
  const job = currentJobId;
  const takeId = job ? lastTake(job) : null;
  if (!takeId) return;
  const meta = trackMeta();
  // Named with the extension of what the browser actually recorded.
  rawRecordingType(job, takeId)
    .then((type) => saveRawRecording(job, takeId, exportFileName(meta.title, meta.artist, rawExtension(type))))
    .then((saved) => {
      exportNote = saved === false ? t("streamer.export.notSaved") : t("streamer.export.rawSaved");
      painted.exp = null;
    })
    .catch((err) => {
      console.warn("[streamer] saving the raw recording failed:", err);
      exportNote = t("streamer.export.failed");
      painted.exp = null;
    });
}

// ── Take timeline ──

/** The two lanes: the backing track (every stem but the part played) and the
 * part the musician plays (none when nothing is removed). */
function laneSpecs() {
  const present = part.job === currentJobId ? part.present : [];
  const remove = part.job === currentJobId ? part.remove : "";
  const { backing, part: played } = timelineLanes(remove, present);
  const out = [];
  if (backing.length) out.push({ key: `b:${backing.join(",")}`, names: backing, label: t("streamer.backingTrack"), color: "#9aa3ad" });
  else out.push(null);
  // The take lane: the musician's part (or their take over the whole song),
  // never the stem file's wave: empty, forming live, then the take's own.
  const label = played ? t("streamer.lane.yourPart", { name: partName(played) }) : t("streamer.lane.yourTake");
  const color = (played && STEM_COLORS[played]) || ui.accent;
  const lane = takeLane();
  if (lane.state === "live" || (lane.state === "saved" && !lane.peaksReady && live.take === lane.take && live.take)) {
    out.push({ key: `l:${live.bucket}:${live.take || ""}`, live: true, label, color });
  } else if (lane.state === "saved" && lane.peaksReady) {
    out.push({ key: `s:${lane.take}`, names: [lane.take], label, color, take: true });
  } else {
    out.push({ key: "e", empty: true, label, color });
  }
  return out;
}

// The live waveform of the take recording now: the input's peak per stretch
// of the song, at the playhead (inputModel.js). One store, reused per take.
const livePeaks = createLivePeaks(3000);
let liveBars = new Float32Array(0);
const live = { take: null, bucket: -1, active: false };

/** The take lane's state: { state, take, info, peaksReady }. */
function takeLane() {
  const job = currentJobId;
  const take = job ? lastTake(job) : null;
  const info = take ? takeInfo(take) : null;
  const remove = part.job === job ? part.remove : "";
  const state = takeLaneState({ recording: takeOpen(), lastTake: take, takePart: info ? info.remove : null, part: remove });
  const peaksReady = Boolean(take && overviewPeaks()?.data?.[take]);
  return { state, take, info, peaksReady };
}

/** Each frame of a take: the input's level into the live waveform. */
function feedLive(tNow) {
  const st = recordState();
  if (!takeOpen()) {
    if (live.active) {
      live.active = false;
      // The take that was just recorded keeps its live wave until its own
      // peaks arrive with the song's reload.
      live.take = st.takeId || lastTake(currentJobId) || live.take;
      painted.lanes = null;
    }
    return;
  }
  if (!live.active) {
    live.active = true;
    live.take = null;
    live.bucket = -1;
    resetLivePeaks(livePeaks, totalDuration);
    painted.lanes = null;
  }
  if (st.state !== "recording") return;
  const cap = streamerMedia().capture;
  const chans = recordingInput()?.channels || [0];
  const peak = cap && !cap.closed ? cap.channelLevel(chans) : 0;
  // A quiet floor so the formed part reads even where it is soft.
  const v = peak > 0 ? Math.max(0.04, meterFraction(peak)) : 0;
  const b = addLivePeak(livePeaks, tNow, v);
  if (b !== live.bucket) live.bucket = b;
}

// ── I play: the part left out of the backing ──

// The open song's choice: { job, remove, present (stems with a file), loaded }.
let part = { job: null, remove: "", present: [], loaded: false };
let partToken = 0;
// A reload to apply a new choice: the playhead goes back where it was.
let pendingSeek = null;

/** The song's stems on disk and Streamer's saved choice for it. */
async function loadPart(job) {
  const token = ++partToken;
  part = { job, remove: "", present: [], loaded: false };
  painted.part = null;
  painted.lanes = null;
  if (!job) {
    applyPart();
    return;
  }
  let present = [];
  try {
    const res = await fetch(`/api/jobs/${encodeURIComponent(job)}`, { cache: "no-store" });
    const data = res.ok ? await res.json() : null;
    present = (data?.stems || []).filter((s) => s?.url && BASE_STEMS.includes(s.name)).map((s) => s.name);
  } catch (err) {
    console.warn("[streamer] reading the song's stems failed:", err);
  }
  let stored = null;
  try { stored = await storeGet(choiceKey(job, PART_MODE), null); } catch (err) {
    console.warn("[streamer] reading the part choice failed:", err);
  }
  if (token !== partToken) return;
  part = { job, remove: effectiveChoice(parseChoice(stored), present), present, loaded: true, record: stored };
  painted.part = null;
  painted.lanes = null;
  applyPart();
}

/** The musician chose what they play: saved for this song in Streamer, and
 * heard now. Refused while a take is open (the take hears what it began with). */
function choosePart(value) {
  if (takeOpen()) {
    flashNote(t("streamer.rec.stopFirst"), ui.builder.timeline.partSel);
    painted.part = null;
    return;
  }
  const job = part.job;
  if (!job || job !== currentJobId || !part.loaded) return;
  const remove = effectiveChoice({ remove: value }, part.present);
  if (remove === part.remove) return;
  // The rest of the record (the voice form a lead/backing split froze,
  // modeStems.js) is kept: only "I play" changes here.
  const record = serializeChoice({ ...parseChoice(part.record), remove });
  part = { ...part, remove, record };
  storeSet(choiceKey(job, PART_MODE), record);
  painted.part = null;
  painted.lanes = null;
  // The backing file is made now, so the export does not wait for it.
  if (remove) fetch(`/api/jobs/${encodeURIComponent(job)}/backing/${remove}.wav`, { method: "HEAD" }).catch(() => {});
  applyPart();
}

/**
 * Make what is heard match the choice: while Streamer is open, the open
 * song's playback leaves the part out (player.js setPlaybackExclusion, read
 * when the song loads, so the song reloads); closed, nothing is left out.
 * Only the open song is ever affected, and only playback: no mode's saved
 * mix changes.
 */
function applyPart() {
  const job = currentJobId;
  const want = open && job && part.job === job && part.loaded ? excludedNames(part.remove) : new Set();
  const have = playbackExclusion();
  const haveForJob = have.jobId === job ? have.names : new Set();
  if (sameNames(want, haveForJob)) {
    // Another song's leftover choice is dropped without a reload.
    if (have.jobId && have.jobId !== job) setPlaybackExclusion(null, new Set());
    return;
  }
  setPlaybackExclusion(job, want);
  if (!job) return;
  // The loop region is cleared by a load: kept here and set again after.
  pendingSeek = {
    job, t: now(), engine: audioEngine, until: performance.now() + 20000, readyAt: 0,
    loop: loopEnabled && loopEnd > loopStart ? { start: loopStart, end: loopEnd } : null,
  };
  requestTakesReload(job);
  // Checked by a timer, not the frame loop: a close reloads too, after the
  // loop has stopped.
  clearInterval(seekTimer);
  seekTimer = setInterval(() => {
    finishPartReload();
    if (!pendingSeek || performance.now() > pendingSeek.until) {
      pendingSeek = null;
      clearInterval(seekTimer);
    }
  }, 100);
}
let seekTimer = 0;

/** After a reload for the choice: the playhead back where it was. */
function finishPartReload() {
  if (!pendingSeek) return;
  if (currentJobId !== pendingSeek.job) {
    pendingSeek = null;
    return;
  }
  if (!(audioEngine && audioEngine !== pendingSeek.engine && totalDuration > 0 && transport())) return;
  // The new engine is up; its load settles its own position a moment later,
  // so the seek waits a little and is checked until it holds.
  const nowMs = performance.now();
  if (!pendingSeek.readyAt) pendingSeek.readyAt = nowMs;
  if (nowMs - pendingSeek.readyAt < 300) return;
  const { t: t0, loop } = pendingSeek;
  if (loop && !loopEnabled) setLoopRange(loop.start, loop.end);
  if (t0 <= 0 || Math.abs(now() - t0) < 0.25) {
    pendingSeek = null;
    return;
  }
  setPlayheadTime(t0);
}

/** A part the musician plays, as "I play" names it: Keys and Voice, the
 * instrument families, not the piano and vocals stem names the rest of the
 * app shows. */
function partName(stem) {
  if (stem === "piano") return t("streamer.part.keys");
  if (stem === "vocals") return t("streamer.part.voice");
  return laneLabel(stem);
}

function paintPart() {
  const sel = ui.builder.timeline.partSel;
  const offered = part.job === currentJobId ? offeredChoices(part.present) : [""];
  const sig = `${offered.join(",")}|${part.remove}|${part.loaded}|${takeOpen()}|${t("streamer.part.none")}`;
  if (painted.part === sig) return;
  painted.part = sig;
  sel.replaceChildren(...offered.map((c) => {
    const o = el("option", null, c ? partName(c) : t("streamer.part.none"));
    o.value = c;
    return o;
  }));
  sel.value = part.remove;
  sel.disabled = takeOpen() || !part.loaded || offered.length < 2;
  sel.title = part.loaded && offered.length < 2 ? t("streamer.part.noStems") : t("streamer.part.aria");
}

/** The label column and its gap: the left edge of the song's column. */
function labelCol() {
  const tl = ui.builder.timeline;
  return (tl.mask.offsetWidth || 82) + 8;
}

function timelineScale() {
  const tl = ui.builder.timeline;
  const view = Math.max(1, tl.scroll.clientWidth - labelCol());
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

/** Where a trim point snaps: the song's ends and its sections' starts and
 * ends first; else its beats, while the beat grid's Snap is on. */
function snapTrim(time, dur, reach) {
  const inSong = (v) => Number.isFinite(v) && v >= 0 && v <= dur;
  const marks = [0, dur];
  for (const s of getSections()) marks.push(s.start, s.end);
  const snapped = snapTime(time, marks.filter(inSong), reach);
  if (snapped !== time || !getBeatGridSnap()) return snapped;
  return snapTime(time, getBeats().filter(inSong), reach);
}

/** Drag the in or out handle; it snaps to sections, then beats (Alt: no snapping). One
 * undo step per drag; the arrows move it a tenth (Shift: a second). */
function wireTrimHandle(handle, which) {
  let drag = null;
  const showTip = (time) => {
    const tip = ui.builder.timeline.tip;
    tip.hidden = false;
    tip.textContent = t(which === "in" ? "streamer.trimIn" : "streamer.trimOut", { time: clockTenths(time) });
    const { pps } = timelineScale();
    tip.style.left = `${labelCol() + time * pps}px`;
  };
  handle.addEventListener("pointerdown", (e) => {
    if (e.button !== 0) return;
    e.preventDefault();
    e.stopPropagation();
    // The trim a take is filming to stays put until it ends.
    if (takeOpen()) return;
    const { dur, pps } = timelineScale();
    if (!dur || !pps) return;
    handle.setPointerCapture(e.pointerId);
    // Where on the handle it was taken: the point does not jump to the pointer.
    const audio = ui.builder.timeline.audio.getBoundingClientRect();
    const point = trimRange(scene, dur)[which];
    drag = { base: scene, dur, pps, offset: (e.clientX - audio.left) / pps - point };
    showTip(point);
    const pointerId = e.pointerId;
    liveDrag = {
      cancel: () => {
        if (!drag) return;
        scene = drag.base;
        drag = null;
        painted.tlTrim = null;
        ui.builder.timeline.tip.hidden = true;
        try { handle.releasePointerCapture(pointerId); } catch { /* already released */ }
      },
    };
  });
  handle.addEventListener("pointermove", (e) => {
    if (!drag) return;
    const audio = ui.builder.timeline.audio.getBoundingClientRect();
    let time = (e.clientX - audio.left) / drag.pps - drag.offset;
    if (!e.altKey) time = snapTrim(time, drag.dur, 8 / drag.pps);
    scene = withTrimPoint(drag.base, which, time, drag.dur);
    painted.tlTrim = null;
    showTip(trimRange(scene, drag.dur)[which]);
  });
  const end = () => {
    if (!drag) return;
    const d = drag;
    drag = null;
    liveDrag = null;
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
    if (takeOpen()) return;
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
      // A marker at 0:00 keeps its whole pin right of the label column.
      b.style.left = `${Math.max(7, x(s.start))}px`;
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
    tl.noSections.hidden = !dur || sections.length > 0;
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
  const specs = laneSpecs();
  const left = tl.scroll.scrollLeft;
  const h = tl.audio.clientHeight;
  // Each lane redraws only when what it shows changed (the live lane as its
  // waveform grows a bucket, about every 75 ms of a 4-minute song).
  const base = `${view}x${h}|${left}|${pps}`;
  if (!painted.lanes || painted.lanesSrc !== src) {
    painted.lanesSrc = src;
    for (const lane of tl.lanes) lane.sig = null;
  }
  painted.lanes = "drawn";
  tl.lanes.forEach((lane, i) => {
    const sp = specs[i] || null;
    const sig = `${sp ? `${sp.key}:${sp.label}:${sp.color}` : "-"}|${base}`;
    if (lane.sig === sig) return;
    lane.sig = sig;
    drawLane(lane, sp, src, left, view, pps, dur);
  });
  const hint = Boolean(specs[1]?.empty && dur);
  if (tl.takeHint.hidden === hint) tl.takeHint.hidden = !hint;
  const noStems = !dur || !part.loaded || Boolean(specs[0]);
  if (tl.noStems.hidden !== noStems) tl.noStems.hidden = noStems;
  paintTakeBlock(x, dur);
  paintTakeMute();
}

/** The take lane's mute button: shown with a saved take on a loaded track,
 * pressed when the take track is muted, off while a take records. */
function paintTakeMute() {
  const btn = ui.builder.timeline.takeMute;
  const job = currentJobId;
  const id = job && streamerTrackId(job);
  const show = Boolean(id && takeLane().state === "saved" && mixerState[id] && trackIndex[id] !== undefined);
  const muted = Boolean(show && mixerState[id].muted);
  const sig = `${show}|${muted}|${takeOpen()}`;
  if (painted.takeMute === sig) return;
  painted.takeMute = sig;
  btn.hidden = !show;
  btn.disabled = takeOpen();
  btn.classList.toggle("off", muted);
  btn.setAttribute("aria-pressed", String(muted));
}

// Each take's filmstrip, asked once ("loading", "ok" with `loaded`, or
// "failed"); a failure is asked once more a few seconds later (the server
// may still be writing the camera part).
const films = new Map();
const FILM_RETRY_MS = 4000;

function filmFor(take) {
  const key = take?.camera_url;
  if (!key) return null;
  let f = films.get(key);
  if (f && f.status === "failed" && f.tries < 2 && performance.now() - f.at > FILM_RETRY_MS) f = null;
  if (f) return f;
  const tries = (films.get(key)?.tries || 0) + 1;
  f = { status: "loading", loaded: null, tries, at: performance.now() };
  films.set(key, f);
  const entry = loadFilmstrip(take);
  const done = (loaded) => {
    f.status = "ok";
    f.loaded = loaded;
    painted.takeBlock = null;
  };
  if (entry instanceof Promise) {
    entry.then(done).catch((err) => {
      console.warn("[streamer] the take's frames failed:", err);
      f.status = "failed";
      f.at = performance.now();
      painted.takeBlock = null;
    });
  } else done(entry);
  return f;
}

/** The server's record of the take lane's take (the Performance track's
 * active take, as the song's lanes loaded it), or null. */
function serverTake(take) {
  const id = currentJobId && streamerTrackId(currentJobId);
  if (!id || !take) return null;
  const active = getTracks().find((tr) => tr.id === id)?.active;
  return active && (active.id ?? active.take_id) === take ? active : null;
}

/** The take on the video lane: growing while it records, then its frames
 * from the camera part's first frame, or a note saying what is missing. */
function paintTakeBlock(x, dur) {
  const tl = ui.builder.timeline;
  const block = tl.takeBlock;
  const lane = takeLane();
  const take = lane.state === "saved" ? serverTake(lane.take) : null;
  const f = take?.has_camera ? filmFor(take) : null;
  const state = videoLaneState({ lane: lane.state, take, film: f?.status ?? null });
  let span = null;
  if (state === "recording") {
    if (recordState().state === "recording" && livePeaks.from >= 0) span = { from: (livePeaks.from / livePeaks.peaks.length) * dur, to: now() };
  } else if (state === "film") {
    span = filmSpan(take.camera_start_sec, f.loaded.meta.duration, dur);
  } else if (state === "loading" || state === "failed" || state === "pending") {
    // Where the take sits, from the server's record, else this browser's.
    const meta = f?.loaded?.meta;
    if (take?.has_camera && meta) span = filmSpan(take.camera_start_sec, meta.duration, dur);
    else if (Number.isFinite(lane.info?.from) && Number.isFinite(lane.info?.to)) span = { from: lane.info.from, to: lane.info.to };
  }
  const noteKey = videoLaneNote(state, lane.info?.camera ?? null);
  const sig = `${state}|${span ? `${Math.round(x(span.from))}|${Math.round(x(span.to))}` : "-"}|${lane.take}|${noteKey}|${t(noteKey || "streamer.trackVideo")}`;
  if (painted.takeBlock === sig) return;
  painted.takeBlock = sig;
  tl.video.dataset.state = state;
  tl.videoNote.hidden = !noteKey;
  tl.videoNote.textContent = noteKey ? t(noteKey) : "";
  block.hidden = !span;
  if (!span) return;
  block.classList.toggle("live", state === "recording");
  block.classList.toggle("failed", state === "failed");
  const left = x(span.from);
  // At least a few pixels: a half-second take still shows where it is.
  const width = Math.max(6, x(span.to) - left);
  block.style.left = `${left}px`;
  block.style.width = `${width}px`;
  tl.film.hidden = state !== "film";
  if (state === "film") {
    const from = Math.max(0, span.from - take.camera_start_sec);
    drawFilmstrip(tl.film, f.loaded, from, span.to - span.from);
  }
}

/** One lane: `spec` { names, label, color } (the peaks of `names`), or null. */
function drawLane(lane, spec, src, left, view, pps, dur) {
  lane.key = spec?.key ?? null;
  lane.label.hidden = !spec;
  lane.name.textContent = spec ? spec.label : "";
  lane.label.title = spec ? spec.label : "";
  const color = spec?.color || "#9aa3ad";
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
  if (!spec || spec.empty || !dur || !pps) return;
  const n = Math.max(1, Math.floor(w / 3));
  const from = (left + 16) / pps / dur;
  const to = (left + 16 + w) / pps / dur;
  let bars;
  if (spec.live) {
    // The live take: the buckets recorded so far (none drawn past them).
    if (liveBars.length !== n) liveBars = new Float32Array(n);
    bars = fillLiveBars(livePeaks, liveBars, from, to);
  } else {
    const names = (spec.names || []).filter((nm) => src?.data?.[nm]);
    if (!names.length) return;
    bars = peakBars(src.data, names, n, from, to);
  }
  // A take's lane draws only where the take has sound: no bars before or
  // after it, where a stem lane draws its quiet floor.
  drawBars(ctx, bars, n, w, h, color, Boolean(spec.live || spec.take));
}

/** One lane's bars: the same drawing for a stem, a saved take and a take
 * forming live (where a bar of 0 is not recorded yet and draws nothing). */
function drawBars(ctx, bars, n, w, h, color, skipEmpty) {
  const step = w / n;
  ctx.fillStyle = color;
  for (let i = 0; i < n; i++) {
    if (skipEmpty && !(bars[i] > 0)) continue;
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
  const mod = e.ctrlKey || e.metaKey;
  const typing = isTyping(e.target);
  // Delete and Backspace never reach the studio's "trash the open song"
  // (catalog.js) while Streamer is open, wherever focus is (the rail, the
  // library, a dialog), except where they edit text. In Streamer itself
  // they delete the selected layer.
  if ((e.key === "Delete" || e.key === "Backspace") && !typing) {
    e.preventDefault();
    e.stopPropagation();
    cancelLiveDrag();
    const elsewhere = menu?.box.contains(e.target) || props?.box.contains(e.target)
      || (e.target instanceof Element && e.target.closest("[role=dialog]:not(.sm-props), .settings-overlay, .mode-menu"));
    if (!mod && !elsewhere && streamerHasFocus(e) && selected && tab === "builder") deleteOf(selected);
    return;
  }
  if (menu?.box.contains(e.target) || props?.box.contains(e.target)) return;
  if (e.target instanceof Element && e.target.closest("[role=dialog]:not(.sm-props), .settings-overlay, .mode-menu")) return;
  const ours = streamerHasFocus(e);

  // Undo and redo of the scene.
  if (mod && !e.altKey && !typing && ours && (e.code === "KeyZ" || e.code === "KeyY")) {
    e.preventDefault();
    e.stopPropagation();
    cancelLiveDrag();
    if (e.code === "KeyY" || e.shiftKey) doRedo();
    else doUndo();
    return;
  }
  // Escape closes the Output drawer, from any control in it (a select too).
  if (e.key === "Escape" && !mod && root.classList.contains("sm-drawer-open")) {
    e.preventDefault();
    e.stopPropagation();
    toggleDrawer(false);
    ui.head.output.focus({ preventScroll: true });
    return;
  }
  if (mod || e.altKey || typing) return;
  // R records or stops (Streamer's own key; nothing in the studio uses R).
  if (e.code === "KeyR" && ours && !e.repeat) {
    e.preventDefault();
    e.stopPropagation();
    toggleRecording();
    return;
  }
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
  onRecordChange((state) => {
    painted.rec = null;
    painted.exp = null;
    syncTakeHold(currentJobId);
    if (state === "saved") {
      const st = recordState();
      if (st.jobId && st.takeId) reviewPending = { job: st.jobId, take: st.takeId, from: takeInfo(st.takeId)?.from ?? null, engine: audioEngine, at: performance.now() };
    }
    if (state === "failed") flashNote(t("streamer.rec.failed"), ui?.builder.rec);
  });
  onDevicesChange(() => {
    painted.devices = null;
    painted.layers = null;
  });
  onLanguageChange(() => relabel());
  onPictureLoaded(() => { painted.scene = null; });
  document.addEventListener("visibilitychange", onVisibility);
  if (railBtn) {
    railBtn.title = t("streamer.rail");
    railBtn.setAttribute("aria-label", t("streamer.rail"));
  }
}
