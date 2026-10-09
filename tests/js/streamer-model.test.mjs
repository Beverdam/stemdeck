// Streamer Mode's arithmetic (static/js/streamer/streamerModel.js).
import {
  SCENE_VERSION, ASPECTS, DEFAULT_ASPECT, LAYER_TYPES, sceneKey,
  aspectRatio, outputSize, fitAspect,
  defaultScene, defaultFrame, withAspect, withLayerVisible,
  clampFrame, parseScene, serializeScene,
  lyricWindow, peakBars, clockTenths, clockHours, rulerTicks,
  ADDABLE_TYPES, layerRules, newLayerId, addLayer, framesOverlap, freeSpot, duplicateLayer, deleteLayer, reorderLayer, renameLayer,
  setLayerProps, setLayerFrame, nudgeLayer, moveFrame, resizeFrame, nearestLine, layerAt,
  emptyHistory, pushHistory, undoHistory, redoHistory, HISTORY_CAP,
  TRIM_MIN, trimRange, snapTime, withTrimPoint, pixelsPerSecond, tickStep, ticksEvery, ZOOM_MAX_PPS,
  IMAGE_MAX_BYTES, IMAGE_TYPES, downscaleSize, fitRect, imageKey,
} from "../../static/js/streamer/streamerModel.js";

let failed = 0;
let passed = 0;
function check(name, ok, detail = "") {
  if (ok) { passed += 1; console.log(`PASS  ${name}`); } else { failed += 1; console.log(`FAIL  ${name} ${detail}`); }
}
const eq = (a, b) => JSON.stringify(a) === JSON.stringify(b);
const near = (a, b, e = 1e-9) => Math.abs(a - b) < e;
const inUnit = (f) => f.x >= 0 && f.y >= 0 && f.w > 0 && f.h > 0 && f.x + f.w <= 1 + 1e-9 && f.y + f.h <= 1 + 1e-9;

// Defaults
const s = defaultScene();
check("default scene is 16:9, current version", s.aspect === "16:9" && s.v === SCENE_VERSION && DEFAULT_ASPECT === "16:9");
check("seven default layers, one of each built-in type", s.layers.length === 7 && eq([...s.layers.map((l) => l.type)].sort(), ["albumArt", "background", "camera", "lowerThird", "lyrics", "title", "waveform"]));
check("text and image are layer types too", LAYER_TYPES.includes("text") && LAYER_TYPES.includes("image"));
check("a new scene keeps the whole song (no trim)", s.trim === null);
check("ids are unique", new Set(s.layers.map((l) => l.id)).size === s.layers.length);
check("everything shown but the background image", s.layers.every((l) => l.visible === (l.type !== "background")));
check("background at the back, album art in front", s.layers[0].type === "background" && s.layers[1].type === "camera" && s.layers[s.layers.length - 1].type === "albumArt");
check("album art is drawn over the title card", s.layers.findIndex((l) => l.type === "albumArt") > s.layers.findIndex((l) => l.type === "title"));
check("camera and background fill the frame", eq(defaultFrame("camera"), { x: 0, y: 0, w: 1, h: 1 }) && eq(defaultFrame("background", "9:16"), { x: 0, y: 0, w: 1, h: 1 }));
check("every default frame is inside the output, at every aspect", ASPECTS.every((a) => defaultScene(a).layers.every((l) => inUnit(l.frame))));
check("frames are fractions of the design preview", near(defaultFrame("title").x, 472 / 716) && near(defaultFrame("title").w, 238 / 716) && near(defaultFrame("lyrics").h, 134 / 403));
check("the album art sits inside the title card", (() => {
  const t = defaultFrame("title"), a = defaultFrame("albumArt");
  return a.x >= t.x && a.y >= t.y && a.x + a.w <= t.x + t.w && a.y + a.h <= t.y + t.h;
})());
check("an unknown aspect gives the default scene", defaultScene("4:3").aspect === "16:9");
check("a new scene is a new object each time", defaultScene() !== defaultScene() && defaultScene().layers[0].frame !== defaultScene().layers[0].frame);
check("default props", eq(s.layers.find((l) => l.type === "lowerThird").props, { handle: "", subtitle: "" }) && s.layers.find((l) => l.type === "waveform").props.bars === 34);

// Aspect fractions
check("aspect ratios", near(aspectRatio("16:9"), 16 / 9) && near(aspectRatio("9:16"), 9 / 16) && aspectRatio("1:1") === 1 && near(aspectRatio("nope"), 16 / 9));
check("output sizes keep the short side", eq(outputSize("16:9"), { width: 1920, height: 1080 }) && eq(outputSize("9:16"), { width: 1080, height: 1920 }) && eq(outputSize("1:1", 720), { width: 720, height: 720 }));
check("16:9 fills a 16:9 box", eq(fitAspect(1600, 900, "16:9"), { x: 0, y: 0, w: 1600, h: 900 }));
const p = fitAspect(1600, 900, "9:16");
check("9:16 is pillarboxed and centred", near(p.h, 900) && near(p.w, 900 * 9 / 16) && near(p.x, (1600 - p.w) / 2) && p.y === 0);
const q = fitAspect(1600, 900, "1:1");
check("1:1 is pillarboxed and square", near(q.w, 900) && near(q.h, 900) && near(q.x, 350));
const l = fitAspect(400, 400, "16:9");
check("16:9 in a square box is letterboxed", near(l.w, 400) && near(l.h, 225) && near(l.y, 87.5));

// Changing the aspect
const portrait = withAspect(s, "9:16");
check("withAspect returns a new scene", portrait !== s && s.aspect === "16:9" && portrait.aspect === "9:16");
check("default frames move to the new aspect's defaults", eq(portrait.layers.find((x) => x.type === "lyrics").frame, defaultFrame("lyrics", "9:16")));
const moved = { ...s, layers: s.layers.map((x) => (x.type === "lyrics" ? { ...x, frame: { x: 0.1, y: 0.1, w: 0.3, h: 0.2 } } : x)) };
check("a frame placed by hand keeps its fractions", eq(withAspect(moved, "1:1").layers.find((x) => x.type === "lyrics").frame, { x: 0.1, y: 0.1, w: 0.3, h: 0.2 }));
check("an unknown aspect changes nothing", withAspect(s, "21:9") === s);
check("round trip to 16:9 restores the defaults", eq(withAspect(portrait, "16:9").layers.map((x) => x.frame), s.layers.map((x) => x.frame)));

// Visibility
const hidden = withLayerVisible(s, "lyrics", false);
check("withLayerVisible hides one layer only", hidden.layers.find((x) => x.id === "lyrics").visible === false && hidden.layers.filter((x) => !x.visible).length === 2 && s.layers.find((x) => x.id === "lyrics").visible === true);

// Per-song key
check("scene key is per song", sceneKey("ff5490ec654a") === "stemdeck:streamer:scene:ff5490ec654a" && sceneKey("a") !== sceneKey("b"));

// Serialization
const round = parseScene(JSON.stringify(serializeScene(hidden)));
check("serialize then parse is the same scene", eq(round, hidden));
check("serialize copies (no shared objects)", serializeScene(s).layers[0] !== s.layers[0]);
check("serialize keeps only the scene's fields", eq(Object.keys(serializeScene({ ...s, extra: 1 })).sort(), ["aspect", "layers", "trim", "v"]));
check("garbage gives the default scene", eq(parseScene("{nope"), defaultScene()) && eq(parseScene(null), defaultScene()) && eq(parseScene({ layers: "x" }), defaultScene()));
check("no readable layers keeps the aspect", eq(parseScene({ aspect: "1:1", layers: [{ type: "laser" }] }), defaultScene("1:1")));
const dirty = parseScene({
  aspect: "4:3",
  layers: [
    { id: "a", type: "title", frame: { x: -1, y: 2, w: 5, h: 0 } },
    { id: "a", type: "lyrics", visible: false, props: { lines: 3 } },
    { type: "spaceship" },
  ],
});
check("unknown aspect becomes 16:9", dirty.aspect === "16:9");
check("unknown layer types are dropped", dirty.layers.length === 2);
check("a duplicate id is renamed", dirty.layers[0].id === "a" && dirty.layers[1].id !== "a");
check("frames are clamped inside the output", inUnit(dirty.layers[0].frame) && eq(dirty.layers[0].frame, { x: 0, y: 0.99, w: 1, h: 0.01 }));
check("a missing frame takes the default", eq(dirty.layers[1].frame, defaultFrame("lyrics")));
check("visible defaults to true, false is kept", dirty.layers[0].visible === true && dirty.layers[1].visible === false);
check("props merge over the defaults", dirty.layers[1].props.lines === 3);
check("clampFrame keeps a 1% minimum", eq(clampFrame({ x: 0.995, y: 0.5, w: 0, h: 0.2 }), { x: 0.99, y: 0.5, w: 0.01, h: 0.2 }));

// Lyrics in view
const lines = [10, 14, 20, 25, 30, 36, 40].map((time, i) => ({ time, text: `line ${i}` }));
check("no lines, nothing shown", eq(lyricWindow([], 5), []) && eq(lyricWindow(null, 5), []));
check("before the first line: first five, none current", eq(lyricWindow(lines, 2).map((x) => x.role), ["next", "next", "next", "later", "later"]) && lyricWindow(lines, 2)[0].text === "line 0");
const w = lyricWindow(lines, 21);
check("the sung line is current, two next, then dim", w[0].text === "line 2" && eq(w.map((x) => x.role), ["current", "next", "next", "later", "later"]));
check("near the end fewer lines", eq(lyricWindow(lines, 41).map((x) => x.text), ["line 6"]) && lyricWindow(lines, 37, 3).length === 2);
check("a line starts exactly on its time", lyricWindow(lines, 14)[0].text === "line 1");

// Waveform bars
const peaks = { vocals: [[0, 0.5], [-1, 0.2], [0, 0.1], [0, 0]], bass: [[-0.25, 0.25], [0, 0], [0, 0.75], [0, 0]] };
check("bars from one stem, normalised", eq(peakBars(peaks, ["vocals"], 4), [0.5, 1, 0.1, 0]));
check("bars take the loudest stem heard", eq(peakBars(peaks, ["vocals", "bass"], 4), [0.5, 1, 0.75, 0]));
check("bars bucket many points", eq(peakBars(peaks, ["bass"], 2), [1 / 3, 1]));
check("muted stems are left out by the caller", eq(peakBars(peaks, [], 3), [0, 0, 0]) && eq(peakBars(null, ["vocals"], 2), [0, 0]));
check("zero bars", eq(peakBars(peaks, ["vocals"], 0), []));

// Time
check("clock in tenths", clockTenths(42.3) === "00:42.3" && clockTenths(186) === "03:06.0" && clockTenths(-1) === "00:00.0" && clockTenths(62.99) === "01:02.9");
check("REC clock", clockHours(0) === "00:00:00" && clockHours(42.9) === "00:00:42" && clockHours(3725) === "01:02:05");
const ticks = rulerTicks(186);
check("ruler ticks every 30 s for a 3 minute song", eq(ticks.map((x) => x.label), ["0:00", "0:30", "1:00", "1:30", "2:00", "2:30", "3:00"]));
check("ruler ticks stay under the maximum", rulerTicks(600, 8).length <= 8 && rulerTicks(20, 8).map((x) => x.label).join(",") === "0:00,0:05,0:10,0:15,0:20");
check("no duration, no ticks", eq(rulerTicks(0), []));

// ── Phase 2: editing ──

// Add, duplicate, delete: rules
check("+ Add Layer offers text, image and the song layers, never camera or background", eq(ADDABLE_TYPES, ["text", "image", "lowerThird", "lyrics", "waveform", "albumArt", "title"]));
check("camera and background cannot be deleted or duplicated", ["camera", "background"].every((type) => {
  const r = layerRules({ type });
  return !r.canDelete && !r.canDuplicate && r.canReorder;
}));
check("the recording lock stops add, delete, duplicate and reorder", (() => {
  const r = layerRules({ type: "text" }, { locked: true });
  return !r.canDelete && !r.canDuplicate && !r.canReorder && !r.canAdd;
})());
check("new ids are unique", newLayerId(s, "text") === "text" && newLayerId(s, "lyrics") === "lyrics-2" && newLayerId(addLayer(s, "lyrics"), "lyrics") === "lyrics-3");
const withText = addLayer(s, "text");
check("an added layer goes in front, shown, with its defaults", withText.layers.length === 8 && withText.layers[7].type === "text" && withText.layers[7].visible && eq(withText.layers[7].props, { text: "", size: 1, color: "white" }) && s.layers.length === 7);
// Overlays: the layers that are not full frame (camera and background are).
const overlays = (sc) => sc.layers.filter((l) => !(l.frame.w >= 0.99 && l.frame.h >= 0.99));
const clashes = (sc, id) => {
  const me = sc.layers.find((l) => l.id === id);
  return overlays(sc).filter((l) => l.id !== id && framesOverlap(me.frame, l.frame)).map((l) => l.id);
};
const insideSafe = (f) => f.x >= 0.05 - 1e-9 && f.y >= 0.05 - 1e-9 && f.x + f.w <= 0.95 + 1e-9 && f.y + f.h <= 0.95 + 1e-9;
check("overlap test: touching edges are not an overlap", !framesOverlap({ x: 0, y: 0, w: 0.5, h: 0.5 }, { x: 0.5, y: 0, w: 0.5, h: 0.5 }) && framesOverlap({ x: 0, y: 0, w: 0.5, h: 0.5 }, { x: 0.4, y: 0.4, w: 0.5, h: 0.5 }));
// The default scene: the title card holds the album art and the waveform by
// design; otherwise no overlay touches another, at every aspect.
for (const a of ASPECTS) {
  const sc = defaultScene(a);
  const f = (type) => sc.layers.find((l) => l.type === type).frame;
  const groups = [["title", "albumArt", "waveform"], ["lyrics"], ["lowerThird"]];
  const inCard = ["albumArt", "waveform"].every((type) => {
    const c = f("title"), g = f(type);
    return g.x >= c.x && g.y >= c.y && g.x + g.w <= c.x + c.w + 1e-9 && g.y + g.h <= c.y + c.h + 1e-9;
  });
  let apart = true;
  for (let i = 0; i < groups.length; i++) {
    for (let j = i + 1; j < groups.length; j++) {
      for (const p of groups[i]) for (const q of groups[j]) if (framesOverlap(f(p), f(q))) apart = false;
    }
  }
  check(`default ${a}: album art and waveform inside the title card, no other overlay overlaps`, inCard && apart);
  check(`default ${a}: a new text layer lands on no overlay, inside the safe inset`, clashes(addLayer(sc, "text"), "text").length === 0 && insideSafe(addLayer(sc, "text").layers.at(-1).frame));
  check(`default ${a}: text then image do not land on each other`, (() => {
    const two = addLayer(addLayer(sc, "text"), "image");
    return clashes(two, "image").length === 0 && clashes(two, "text").length === 0;
  })());
}
const lyr2 = addLayer(s, "lyrics").layers.find((l) => l.id === "lyrics-2");
check("a second lyrics box goes to a free spot, not on the first", clashes(addLayer(s, "lyrics"), "lyrics-2").length === 0 && insideSafe(lyr2.frame) && near(lyr2.frame.w, defaultFrame("lyrics").w));
check("free spot: the wanted place when it is free", eq(freeSpot(s, { x: 0.3, y: 0.4, w: 0.2, h: 0.1 }, "text"), { x: 0.3, y: 0.4, w: 0.2, h: 0.1 }));
check("free spot: nowhere free, 2% further per layer of the type (unavoidable)", (() => {
  const full = { ...s, layers: [...s.layers, { id: "big", type: "image", visible: true, frame: { x: 0.02, y: 0.02, w: 0.96, h: 0.96 }, props: {} }] };
  const spot = freeSpot(full, { x: 0.3, y: 0.3, w: 0.2, h: 0.2 }, "image");
  return near(spot.x, 0.32) && near(spot.y, 0.32);
})());
check("camera, background and unknown types are not added", addLayer(s, "camera") === s && addLayer(s, "background") === s && addLayer(s, "rocket") === s);
check("adding while locked does nothing", addLayer(s, "text", { locked: true }) === s);
const dup = duplicateLayer(s, "waveform");
const dl = dup.layers[dup.layers.findIndex((l) => l.id === "waveform") + 1];
check("duplicate sits just in front, same size and props, on no other overlay", dl.id === "waveform-2" && near(dl.frame.w, defaultFrame("waveform").w) && eq(dl.props, { bars: 34 }) && clashes(dup, "waveform-2").length === 0);
check("duplicating the lower third does not cover the first", clashes(duplicateLayer(s, "lowerThird"), "lowerThird-2").length === 0);
check("duplicate is a deep copy", (dl.props.bars = 4, s.layers.find((l) => l.id === "waveform").props.bars === 34));
check("camera is not duplicated or deleted", duplicateLayer(s, "camera") === s && deleteLayer(s, "camera") === s && deleteLayer(s, "background") === s);
check("delete removes one layer", deleteLayer(s, "lyrics").layers.length === 6 && !deleteLayer(s, "lyrics").layers.some((l) => l.id === "lyrics"));
check("delete of an unknown id or while locked does nothing", deleteLayer(s, "nope") === s && deleteLayer(s, "lyrics", { locked: true }) === s);

// Reorder
const front = reorderLayer(s, "lyrics", 6);
check("reorder to the front", front.layers[6].id === "lyrics" && front.layers.length === 7);
check("reorder to the back", reorderLayer(s, "albumArt", 0).layers[0].id === "albumArt");
check("reorder clamps the index", reorderLayer(s, "lyrics", 99).layers[6].id === "lyrics" && reorderLayer(s, "lyrics", -5).layers[0].id === "lyrics");
check("reorder to the same place or while locked returns the scene", reorderLayer(s, "lyrics", 3) === s && reorderLayer(s, "lyrics", 6, { locked: true }) === s);

// Rename and properties
check("rename sets a name of its own", renameLayer(s, "lyrics", "  Chorus words ").layers.find((l) => l.id === "lyrics").name === "Chorus words");
check("an empty name goes back to the type's", !("name" in renameLayer(renameLayer(s, "lyrics", "x"), "lyrics", "  ").layers.find((l) => l.id === "lyrics")));
check("names are cut at 60", renameLayer(s, "lyrics", "a".repeat(80)).layers.find((l) => l.id === "lyrics").name.length === 60);
const p1 = setLayerProps(s, "lyrics", { lines: 12 });
check("lyric lines are held to 3..7", p1.layers.find((l) => l.id === "lyrics").props.lines === 7 && setLayerProps(s, "lyrics", { lines: 1 }).layers.find((l) => l.id === "lyrics").props.lines === 3);
const tl = setLayerProps(withText, "text", { text: "Hi", color: "purple", size: 9 }).layers.find((l) => l.id === "text").props;
check("text: an unknown colour is white, the size is held to 0.5..3", tl.text === "Hi" && tl.color === "white" && tl.size === 3);
check("lower third, camera, title props", (() => {
  let x = setLayerProps(s, "lowerThird", { handle: "@me", subtitle: "Covers" });
  x = setLayerProps(x, "camera", { mirror: true });
  x = setLayerProps(x, "title", { showArtist: false });
  const get = (id) => x.layers.find((l) => l.id === id).props;
  return eq(get("lowerThird"), { handle: "@me", subtitle: "Covers" }) && get("camera").mirror === true && get("title").showArtist === false;
})());
check("props survive save and load", eq(parseScene(serializeScene(setLayerProps(withText, "text", { text: "Yo", color: "red", size: 2 }))).layers.find((l) => l.id === "text").props, { text: "Yo", size: 2, color: "red" }));

// Frames: move, resize, snap, nudge
const card = { x: 0.3, y: 0.3, w: 0.2, h: 0.1 };
check("move without snapping", eq(moveFrame(card, 0.1, 0.05, { snap: false }), { x: 0.4, y: 0.35, w: 0.2, h: 0.1 }) || near(moveFrame(card, 0.1, 0.05, { snap: false }).x, 0.4));
check("the left edge snaps to the 10% safe line", near(moveFrame(card, -0.195, 0, { tx: 0.01 }).x, 0.1, 1e-12));
check("the right edge snaps to 95%", near(moveFrame(card, 0.447, 0, { tx: 0.01 }).x + 0.2, 0.95, 1e-12));
check("the centre snaps to the middle", near(moveFrame(card, 0.097, 0, { tx: 0.01 }).x + 0.1, 0.5, 1e-12));
check("the top snaps to 5%", near(moveFrame(card, 0, -0.245, { ty: 0.01 }).y, 0.05, 1e-12));
check("out of reach does not snap", near(moveFrame(card, -0.17, 0, { tx: 0.01 }).x, 0.13, 1e-12));
check("Alt (no snap) keeps the exact spot", near(moveFrame(card, -0.195, 0, { snap: false }).x, 0.105, 1e-12));
check("a move is held inside the output", eq(moveFrame(card, 2, 2, { snap: false }), { x: 0.8, y: 0.9, w: 0.2, h: 0.1 }) || (near(moveFrame(card, 2, 2, { snap: false }).x, 0.8) && near(moveFrame(card, 2, 2, { snap: false }).y, 0.9)));
check("nearest snap line", nearestLine(0.104, 0.01) === 0.1 && nearestLine(0.3, 0.01) === null && nearestLine(0.497, 0.01) === 0.5);
const se = resizeFrame(card, "se", 0.1, 0.05, { snap: false });
check("resize from the bottom right keeps the top left", near(se.x, 0.3) && near(se.y, 0.3) && near(se.w, 0.3) && near(se.h, 0.15));
const nw = resizeFrame(card, "nw", -0.1, -0.1, { snap: false });
check("resize from the top left keeps the bottom right", near(nw.x, 0.2) && near(nw.y, 0.2) && near(nw.x + nw.w, 0.5) && near(nw.y + nw.h, 0.4));
check("resize never goes under 3%", near(resizeFrame(card, "se", -1, -1, { snap: false }).w, 0.03) && near(resizeFrame(card, "nw", 1, 1, { snap: false }).h, 0.03));
check("a resized edge snaps", near(resizeFrame(card, "ne", 0.445, 0, { tx: 0.01 }).x + resizeFrame(card, "ne", 0.445, 0, { tx: 0.01 }).w, 0.95, 1e-12));
check("resize is held inside the output", (() => { const r = resizeFrame(card, "se", 5, 5, { snap: false }); return near(r.x + r.w, 1) && near(r.y + r.h, 1); })());
const nudged = nudgeLayer(s, "waveform", 0.01, 0.05).layers.find((l) => l.id === "waveform").frame;
check("nudge moves by fractions", near(nudged.x, defaultFrame("waveform").x + 0.01) && near(nudged.y, defaultFrame("waveform").y + 0.05));
check("nudge stops at the edge", near(nudgeLayer(s, "lowerThird", -1, 0).layers.find((l) => l.id === "lowerThird").frame.x, 0));
check("setLayerFrame clamps", eq(setLayerFrame(s, "lyrics", { x: -1, y: 0.5, w: 0.5, h: 0.2 }).layers.find((l) => l.id === "lyrics").frame, { x: 0, y: 0.5, w: 0.5, h: 0.2 }));
check("the front-most shown layer is picked", layerAt(s, 0.7, 0.1).id === "albumArt" && layerAt(s, 0.95, 0.05).id === "title" && layerAt(s, 0.95, 0.22).id === "waveform" && layerAt(s, 0.3, 0.5).id === "camera");
check("hidden layers are not picked", layerAt(withLayerVisible(s, "camera", false), 0.3, 0.5) === null);

// Undo history
let h = emptyHistory();
const s1 = nudgeLayer(s, "lyrics", 0.01, 0);
h = pushHistory(h, s);
const s2 = nudgeLayer(s1, "lyrics", 0.01, 0);
h = pushHistory(h, s1);
let u = undoHistory(h, s2);
check("undo gives the scene before the last edit", u.scene === s1 && u.history.past.length === 1 && u.history.future[0] === s2);
u = undoHistory(u.history, u.scene);
check("undo again gives the first", u.scene === s && u.history.past.length === 0);
check("nothing more to undo", undoHistory(u.history, u.scene).scene === null);
let r = redoHistory(u.history, u.scene);
check("redo gives the next", r.scene === s1);
r = redoHistory(r.history, r.scene);
check("redo again gives the last", r.scene === s2 && redoHistory(r.history, r.scene).scene === null);
check("a new edit clears redo", pushHistory(undoHistory(h, s2).history, s1).future.length === 0);
let big = emptyHistory();
for (let i = 0; i < HISTORY_CAP + 20; i++) big = pushHistory(big, { i });
check("history is capped at 100, oldest dropped", big.past.length === HISTORY_CAP && big.past[0].i === 20);

// Trim
check("no trim is the whole song", eq(trimRange(s, 186), { in: 0, out: 186 }));
const tr = withTrimPoint(s, "in", 12.5, 186);
check("in point set", eq(trimRange(tr, 186), { in: 12.5, out: 186 }) && eq(tr.trim, { in: 12.5, out: 186 }));
check("out point set", eq(trimRange(withTrimPoint(tr, "out", 100, 186), 186), { in: 12.5, out: 100 }));
check("the range stays at least one second", eq(trimRange(withTrimPoint(tr, "out", 5, 186), 186), { in: 12.5, out: 13.5 }) && eq(trimRange(withTrimPoint(withTrimPoint(tr, "out", 50, 186), "in", 80, 186), 186), { in: 49, out: 50 }) && TRIM_MIN === 1);
check("points are held to the song", eq(trimRange(withTrimPoint(s, "in", -5, 186), 186), { in: 0, out: 186 }) && eq(trimRange(withTrimPoint(s, "out", 999, 186), 186), { in: 0, out: 186 }));
check("the whole song again stores no trim", withTrimPoint(tr, "in", 0, 186).trim === null);
check("trim survives save and load", eq(parseScene(serializeScene(tr)).trim, { in: 12.5, out: 186 }));
check("a bad trim reads as none", parseScene({ layers: s.layers, trim: { in: 10, out: 10.5 } }).trim === null && parseScene({ layers: s.layers, trim: "x" }).trim === null);
check("a trim past a shorter song is held to it", eq(trimRange({ trim: { in: 10, out: 300 } }, 186), { in: 10, out: 186 }));
check("snap to the nearest target in reach", snapTime(47.8, [0, 48, 78, 186], 0.5) === 48 && snapTime(50, [0, 48, 78], 0.5) === 50 && snapTime(77.9, [78, 77.95], 0.5) === 77.95);

// Zoom
check("zoom 0 fits the song in view", near(pixelsPerSecond(200, 1000, 0), 5));
check("zoom 1 is the closest", near(pixelsPerSecond(200, 1000, 1), ZOOM_MAX_PPS));
check("zoom grows with each step", [0, 0.2, 0.4, 0.6, 0.8, 1].map((z) => pixelsPerSecond(200, 1000, z)).every((v, i, a) => i === 0 || v > a[i - 1]));
check("a song that already fits wider than the max never shrinks", near(pixelsPerSecond(2, 1000, 1), 500));
check("zoom is clamped", near(pixelsPerSecond(200, 1000, -1), 5) && near(pixelsPerSecond(200, 1000, 3), ZOOM_MAX_PPS));
check("tick step keeps labels apart", tickStep(5) === 15 && tickStep(100) === 1 && tickStep(0.1) === 300);
check("ticks every step", eq(ticksEvery(65, 30).map((x) => x.label), ["0:00", "0:30", "1:00"]) && eq(ticksEvery(0, 5), []));

// Waveform bars over a stretch
const pk = { v: [[0, 1], [0, 0.5], [0, 0.25], [0, 0.125]] };
check("bars of a stretch, against the whole song", eq(peakBars(pk, ["v"], 2, 0.5, 1), [0.25, 0.125]) && eq(peakBars(pk, ["v"], 2), [1, 0.25]));

// Pictures (phase 5)
check("a picture is stored no wider than the output", eq(downscaleSize(4000, 3000, 1920), { width: 1920, height: 1440 }) && eq(downscaleSize(800, 600, 1920), { width: 800, height: 600 }));
check("a portrait picture keeps its aspect", eq(downscaleSize(3000, 6000, 1080), { width: 1080, height: 2160 }));
check("bad sizes never give zero", eq(downscaleSize(0, NaN, 0), { width: 1, height: 1 }));
check("cover fills the box (cut at the sides)", eq(fitRect(200, 100, 100, 100, "cover"), { x: -50, y: 0, w: 200, h: 100 }));
check("contain fits inside the box (bars above and below)", eq(fitRect(200, 100, 100, 100, "contain"), { x: 0, y: 25, w: 100, h: 50 }));
check("an empty picture or box draws nothing", eq(fitRect(0, 100, 100, 100), { x: 0, y: 0, w: 0, h: 0 }));
check("pictures are capped at 2 MB, PNG, JPEG or WebP", IMAGE_MAX_BYTES === 2097152 && eq([...IMAGE_TYPES], ["image/png", "image/jpeg", "image/webp"]));
const ik = imageKey("ff5490ec654a", "image-2", "lq3x9");
check("a picture's key is per song, layer and choice", ik === "ff5490ec654a:image-2:lq3x9" && imageKey("a", "b") === "a:b");
const withPic = setLayerProps(addLayer(defaultScene(), "image"), "image", { imageKey: ik });
check("the picture's key survives save and load", parseScene(serializeScene(withPic)).layers.find((l) => l.id === "image").props.imageKey === ik);
check("a bad picture key is dropped", parseScene(serializeScene(setLayerProps(withPic, "image", { imageKey: "../../x y" }))).layers.find((l) => l.id === "image").props.imageKey === "");
check("the background takes a picture too", defaultScene().layers.find((l) => l.type === "background").props.imageKey === "");


console.log(`\n${passed} passed, ${failed} failed`);
if (failed) process.exit(1);
