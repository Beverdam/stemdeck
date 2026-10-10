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
  TABS, tabOf, isSquareLayer, migrateLayers,
} from "../../static/js/streamer/streamerModel.js";

let failed = 0;
let passed = 0;
function check(name, ok, detail = "") {
  if (ok) { passed += 1; console.log(`PASS  ${name}`); } else { failed += 1; console.log(`FAIL  ${name} ${detail}`); }
}
const eq = (a, b) => JSON.stringify(a) === JSON.stringify(b);
const near = (a, b, e = 1e-9) => Math.abs(a - b) < e;
const inUnit = (f) => f.x >= 0 && f.y >= 0 && f.w > 0 && f.h > 0 && f.x + f.w <= 1 + 1e-9 && f.y + f.h <= 1 + 1e-9;

// Tabs: Scene Builder and Templates. Live Controls is gone, so a "live" from
// an older build (or anything unknown) opens the Scene Builder, no error.
check("two tabs: Scene Builder and Templates", eq(TABS, ["builder", "templates"]));
check("a known tab is itself", tabOf("builder") === "builder" && tabOf("templates") === "templates");
check("the removed live tab falls back to the Scene Builder", tabOf("live") === "builder");
check("unknown or missing tabs fall back to the Scene Builder", [undefined, null, "", "LIVE", 7, {}].every((v) => tabOf(v) === "builder"));

// Defaults
const s = defaultScene();
check("default scene is 16:9, current version", s.aspect === "16:9" && s.v === SCENE_VERSION && DEFAULT_ASPECT === "16:9");
check("five default layers, one of each built-in type", s.layers.length === 5 && eq([...s.layers.map((l) => l.type)].sort(), ["background", "camera", "lowerThird", "lyrics", "trackInfo"]));
check("the old song layers are no layer types any more", !["title", "albumArt", "waveform"].some((type) => LAYER_TYPES.includes(type)) && LAYER_TYPES.includes("trackInfo"));
check("text and image are layer types too", LAYER_TYPES.includes("text") && LAYER_TYPES.includes("image"));
check("a new scene keeps the whole song (no trim)", s.trim === null);
check("ids are unique", new Set(s.layers.map((l) => l.id)).size === s.layers.length);
check("everything shown but the background image", s.layers.every((l) => l.visible === (l.type !== "background")));
check("background at the back, Track Info in front", s.layers[0].type === "background" && s.layers[1].type === "camera" && s.layers[s.layers.length - 1].type === "trackInfo");
check("Track Info shows every part by default", eq(s.layers.find((l) => l.type === "trackInfo").props, { art: true, title: true, waveform: true, showArtist: true, bars: 34 }));
check("camera and background fill the frame", eq(defaultFrame("camera"), { x: 0, y: 0, w: 1, h: 1 }) && eq(defaultFrame("background", "9:16"), { x: 0, y: 0, w: 1, h: 1 }));
check("every default frame is inside the output, at every aspect", ASPECTS.every((a) => defaultScene(a).layers.every((l) => inUnit(l.frame))));
check("frames are fractions of the design preview", near(defaultFrame("trackInfo").x, 472 / 716) && near(defaultFrame("trackInfo").w, 238 / 716) && near(defaultFrame("lyrics").h, 134 / 403));
check("Track Info is where the title card was, at every aspect", eq(defaultFrame("trackInfo", "9:16"), { x: 16 / 403, y: 76 / 716, w: 371 / 403, h: 140 / 716 }) && eq(defaultFrame("trackInfo", "1:1"), { x: 197 / 483, y: 8 / 483, w: 280 / 483, h: 124 / 483 }));
check("an unknown aspect gives the default scene", defaultScene("4:3").aspect === "16:9");
check("a new scene is a new object each time", defaultScene() !== defaultScene() && defaultScene().layers[0].frame !== defaultScene().layers[0].frame);
check("default props", eq(s.layers.find((l) => l.type === "lowerThird").props, { handle: "", subtitle: "" }) && s.layers.find((l) => l.type === "trackInfo").props.bars === 34);

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
    { id: "a", type: "text", frame: { x: -1, y: 2, w: 5, h: 0 } },
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
check("+ Add Layer offers text, image and the song layers, never camera or background", eq(ADDABLE_TYPES, ["text", "image", "lowerThird", "lyrics", "trackInfo"]));
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
check("an added layer goes in front, shown, with its defaults", withText.layers.length === 6 && withText.layers[5].type === "text" && withText.layers[5].visible && eq(withText.layers[5].props, { text: "", size: 1, color: "white" }) && s.layers.length === 5);
// Overlays: the layers that are not full frame (camera and background are).
const overlays = (sc) => sc.layers.filter((l) => !(l.frame.w >= 0.99 && l.frame.h >= 0.99));
const clashes = (sc, id) => {
  const me = sc.layers.find((l) => l.id === id);
  return overlays(sc).filter((l) => l.id !== id && framesOverlap(me.frame, l.frame)).map((l) => l.id);
};
const insideSafe = (f) => f.x >= 0.05 - 1e-9 && f.y >= 0.05 - 1e-9 && f.x + f.w <= 0.95 + 1e-9 && f.y + f.h <= 0.95 + 1e-9;
check("overlap test: touching edges are not an overlap", !framesOverlap({ x: 0, y: 0, w: 0.5, h: 0.5 }, { x: 0.5, y: 0, w: 0.5, h: 0.5 }) && framesOverlap({ x: 0, y: 0, w: 0.5, h: 0.5 }, { x: 0.4, y: 0.4, w: 0.5, h: 0.5 }));
// The default scene: no overlay touches another, at every aspect.
for (const a of ASPECTS) {
  const sc = defaultScene(a);
  const f = (type) => sc.layers.find((l) => l.type === type).frame;
  const groups = [["trackInfo"], ["lyrics"], ["lowerThird"]];
  let apart = true;
  for (let i = 0; i < groups.length; i++) {
    for (let j = i + 1; j < groups.length; j++) {
      for (const p of groups[i]) for (const q of groups[j]) if (framesOverlap(f(p), f(q))) apart = false;
    }
  }
  check(`default ${a}: no overlay overlaps another`, apart);
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
const dup = duplicateLayer(setLayerProps(s, "trackInfo", { waveform: false }), "trackInfo");
const dl = dup.layers[dup.layers.findIndex((l) => l.id === "trackInfo") + 1];
check("duplicate sits just in front, same size and props, on no other overlay", dl.id === "trackInfo-2" && near(dl.frame.w, defaultFrame("trackInfo").w) && eq(dl.props, { art: true, title: true, waveform: false, showArtist: true, bars: 34 }) && clashes(dup, "trackInfo-2").length === 0);
check("a second Track Info can be added, every part on, on no other overlay", (() => {
  const two = addLayer(s, "trackInfo");
  const l2 = two.layers.at(-1);
  return l2.id === "trackInfo-2" && l2.props.art && l2.props.title && l2.props.waveform && clashes(two, "trackInfo-2").length === 0 && near(l2.frame.w, defaultFrame("trackInfo").w);
})());
check("duplicating the lower third does not cover the first", clashes(duplicateLayer(s, "lowerThird"), "lowerThird-2").length === 0);
check("duplicate is a deep copy", (dl.props.bars = 4, s.layers.find((l) => l.id === "trackInfo").props.bars === 34));
check("camera is not duplicated or deleted", duplicateLayer(s, "camera") === s && deleteLayer(s, "camera") === s && deleteLayer(s, "background") === s);
check("delete removes one layer", deleteLayer(s, "lyrics").layers.length === 4 && !deleteLayer(s, "lyrics").layers.some((l) => l.id === "lyrics"));
check("delete of an unknown id or while locked does nothing", deleteLayer(s, "nope") === s && deleteLayer(s, "lyrics", { locked: true }) === s);

// Reorder
const front = reorderLayer(s, "lyrics", 4);
check("reorder to the front", front.layers[4].id === "lyrics" && front.layers.length === 5);
check("reorder to the back", reorderLayer(s, "trackInfo", 0).layers[0].id === "trackInfo");
check("reorder clamps the index", reorderLayer(s, "lyrics", 99).layers[4].id === "lyrics" && reorderLayer(s, "lyrics", -5).layers[0].id === "lyrics");
check("reorder to the same place or while locked returns the scene", reorderLayer(s, "lyrics", 3) === s && reorderLayer(s, "lyrics", 4, { locked: true }) === s);

// Rename and properties
check("rename sets a name of its own", renameLayer(s, "lyrics", "  Chorus words ").layers.find((l) => l.id === "lyrics").name === "Chorus words");
check("an empty name goes back to the type's", !("name" in renameLayer(renameLayer(s, "lyrics", "x"), "lyrics", "  ").layers.find((l) => l.id === "lyrics")));
check("names are cut at 60", renameLayer(s, "lyrics", "a".repeat(80)).layers.find((l) => l.id === "lyrics").name.length === 60);
const p1 = setLayerProps(s, "lyrics", { lines: 12 });
check("lyric lines are held to 3..7", p1.layers.find((l) => l.id === "lyrics").props.lines === 7 && setLayerProps(s, "lyrics", { lines: 1 }).layers.find((l) => l.id === "lyrics").props.lines === 3);
const tl = setLayerProps(withText, "text", { text: "Hi", color: "purple", size: 9 }).layers.find((l) => l.id === "text").props;
check("text: an unknown colour is white, the size is held to 0.5..3", tl.text === "Hi" && tl.color === "white" && tl.size === 3);
check("lower third, camera, Track Info props", (() => {
  let x = setLayerProps(s, "lowerThird", { handle: "@me", subtitle: "Covers" });
  x = setLayerProps(x, "camera", { mirror: true });
  x = setLayerProps(x, "trackInfo", { showArtist: false });
  const get = (id) => x.layers.find((l) => l.id === id).props;
  return eq(get("lowerThird"), { handle: "@me", subtitle: "Covers" }) && get("camera").mirror === true && get("trackInfo").showArtist === false;
})());
check("Track Info parts switch one at a time, and stay true or false", (() => {
  const x = setLayerProps(s, "trackInfo", { art: false, waveform: 0, title: "yes", bars: 999 }).layers.find((l) => l.id === "trackInfo").props;
  return x.art === false && x.waveform === true && x.title === true && x.bars === 96 && setLayerProps(s, "trackInfo", { bars: "x" }).layers.at(-1).props.bars === 34;
})());
check("Track Info parts survive save and load", eq(parseScene(serializeScene(setLayerProps(s, "trackInfo", { art: false, showArtist: false }))).layers.find((l) => l.id === "trackInfo").props, { art: false, title: true, waveform: true, showArtist: false, bars: 34 }));
check("a square Track Info is the one with only the album art", isSquareLayer({ type: "trackInfo", props: { art: true, title: false, waveform: false } })
  && !isSquareLayer(s.layers.find((l) => l.id === "trackInfo")) && !isSquareLayer({ type: "trackInfo", props: { art: false, title: false, waveform: false } }) && !isSquareLayer({ type: "image", props: {} }));
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
const nudged = nudgeLayer(s, "trackInfo", -0.01, 0.05).layers.find((l) => l.id === "trackInfo").frame;
check("nudge moves by fractions", near(nudged.x, defaultFrame("trackInfo").x - 0.01) && near(nudged.y, defaultFrame("trackInfo").y + 0.05));
check("nudge stops at the edge", near(nudgeLayer(s, "lowerThird", -1, 0).layers.find((l) => l.id === "lowerThird").frame.x, 0));
check("setLayerFrame clamps", eq(setLayerFrame(s, "lyrics", { x: -1, y: 0.5, w: 0.5, h: 0.2 }).layers.find((l) => l.id === "lyrics").frame, { x: 0, y: 0.5, w: 0.5, h: 0.2 }));
check("the front-most shown layer is picked", layerAt(s, 0.7, 0.1).id === "trackInfo" && layerAt(s, 0.95, 0.22).id === "trackInfo" && layerAt(s, 0.8, 0.8).id === "lyrics" && layerAt(s, 0.3, 0.5).id === "camera");
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

// ── Version 1 scenes: Song Title, Album Art and Waveform become Track Info ──
// A version 1 scene as that build saved it: its default frames per aspect.
const v1px = (x, y, w, h, W, H) => ({ x: x / W, y: y / H, w: w / W, h: h / H });
const V1_FRAMES = {
  "16:9": { title: v1px(472, 8, 238, 108, 716, 403), albumArt: v1px(482, 18, 88, 88, 716, 403), waveform: v1px(582, 74, 118, 28, 716, 403) },
  "9:16": { title: v1px(16, 76, 371, 140, 403, 716), albumArt: v1px(29, 89, 114, 114, 403, 716), waveform: v1px(159, 162, 215, 36, 403, 716) },
  "1:1": { title: v1px(197, 8, 280, 124, 483, 483), albumArt: v1px(209, 19, 101, 101, 483, 483), waveform: v1px(324, 84, 142, 32, 483, 483) },
};
const v1Scene = (aspect = "16:9") => {
  const now = defaultScene(aspect);
  const keep = now.layers.filter((l) => l.type !== "trackInfo");
  const f = V1_FRAMES[aspect];
  return JSON.parse(JSON.stringify({
    v: 1, aspect, trim: null,
    layers: [...keep,
      { id: "title", type: "title", visible: true, frame: f.title, props: { showArtist: true } },
      { id: "waveform", type: "waveform", visible: true, frame: f.waveform, props: { bars: 34 } },
      { id: "albumArt", type: "albumArt", visible: true, frame: f.albumArt, props: {} }],
  }));
};
const tiOf = (sc) => sc.layers.filter((l) => l.type === "trackInfo");
for (const a of ASPECTS) {
  const m = parseScene(JSON.stringify(v1Scene(a)));
  check(`version 1 default ${a}: becomes the version 2 default scene`, eq(m, defaultScene(a)), JSON.stringify(tiOf(m)));
}
check("a version 1 scene is read as the current version", parseScene(v1Scene()).v === SCENE_VERSION && SCENE_VERSION === 2);
{
  // Customised: the card moved and renamed, the waveform hidden, a text layer between them.
  const old = v1Scene();
  const t = old.layers.find((l) => l.id === "title");
  t.frame = { x: 0.1, y: 0.6, w: 0.4, h: 0.25 };
  t.name = "Now playing";
  t.props.showArtist = false;
  old.layers.find((l) => l.id === "waveform").visible = false;
  old.layers.find((l) => l.id === "waveform").props.bars = 20;
  old.layers.splice(old.layers.findIndex((l) => l.id === "waveform"), 0, { id: "text", type: "text", visible: true, frame: { x: 0.3, y: 0.4, w: 0.2, h: 0.1 }, props: { text: "Hi" } });
  const m = parseScene(old);
  const ti = tiOf(m);
  check("customised: one Track Info, the old three gone", ti.length === 1 && !m.layers.some((l) => ["title", "albumArt", "waveform"].includes(l.type)));
  check("customised: the Song Title's frame is kept", eq(ti[0].frame, { x: 0.1, y: 0.6, w: 0.4, h: 0.25 }));
  check("customised: a hidden waveform is a part switched off", ti[0].props.art === true && ti[0].props.title === true && ti[0].props.waveform === false && ti[0].visible === true);
  check("customised: the artist switch, bar count and own name are kept", ti[0].props.showArtist === false && ti[0].props.bars === 20 && ti[0].name === "Now playing");
  check("customised: at the earliest of their places, the rest in order", eq(m.layers.map((l) => l.id), ["background", "camera", "lowerThird", "lyrics", "trackInfo", "text"]));
}
{
  // Reordered: the album art at the back, the title in front of the lyrics.
  const old = v1Scene();
  const art = old.layers.find((l) => l.id === "albumArt");
  old.layers = [art, ...old.layers.filter((l) => l !== art)];
  check("the Track Info takes the earliest place of the three", parseScene(old).layers[0].type === "trackInfo" && parseScene(old).layers.length === 5);
}
{
  const hide = (sc, ids) => (sc.layers.forEach((l) => { if (ids.includes(l.id)) l.visible = false; }), sc);
  const art = tiOf(parseScene(hide(v1Scene(), ["albumArt"])))[0];
  check("a hidden album art is the art part off", art.props.art === false && art.props.title && art.props.waveform && art.visible);
  const all = tiOf(parseScene(hide(v1Scene(), ["albumArt", "title", "waveform"])))[0];
  check("all three hidden: the card is hidden with every part on", all.visible === false && all.props.art && all.props.title && all.props.waveform);
  const onlyTitle = tiOf(parseScene(hide(v1Scene(), ["albumArt", "waveform"])))[0];
  check("only the title shown: title on, art and waveform off", onlyTitle.visible && onlyTitle.props.title && !onlyTitle.props.art && !onlyTitle.props.waveform);
}
{
  // Only some of the three.
  const only = (types) => {
    const sc = v1Scene();
    sc.layers = sc.layers.filter((l) => !["title", "albumArt", "waveform"].includes(l.type) || types.includes(l.type));
    return tiOf(parseScene(sc));
  };
  const aw = only(["albumArt", "waveform"]);
  check("album art and waveform, no title: the album art's frame, title off", aw.length === 1 && eq(aw[0].frame, V1_FRAMES["16:9"].albumArt) && aw[0].props.art && aw[0].props.waveform && !aw[0].props.title);
  const w = only(["waveform"]);
  check("the waveform alone: its frame, only the waveform on", w.length === 1 && eq(w[0].frame, V1_FRAMES["16:9"].waveform) && !w[0].props.art && !w[0].props.title && w[0].props.waveform);
  const t = only(["title"]);
  check("the title alone: the title card, only the title on", t.length === 1 && eq(t[0].frame, V1_FRAMES["16:9"].title) && t[0].props.title && !t[0].props.art && !t[0].props.waveform);
  const none = only([]);
  check("none of the three: no Track Info is made up", none.length === 0);
}
{
  // Two of the same: the duplicate becomes a Track Info of its own, where it was.
  const old = v1Scene();
  old.layers.push({ id: "waveform-2", type: "waveform", visible: true, frame: { x: 0.1, y: 0.1, w: 0.2, h: 0.05 }, props: { bars: 40 }, name: "Second wave" });
  old.layers.push({ id: "title-2", type: "title", visible: false, frame: { x: 0.1, y: 0.3, w: 0.3, h: 0.2 }, props: { showArtist: false } });
  const m = parseScene(old);
  const ti = tiOf(m);
  check("two of the same: three Track Info layers, unique ids", ti.length === 3 && eq(ti.map((l) => l.id), ["trackInfo", "trackInfo-2", "trackInfo-3"]));
  check("the first of each merged as usual", eq(ti[0].frame, V1_FRAMES["16:9"].title) && ti[0].props.art && ti[0].props.title && ti[0].props.waveform && ti[0].props.bars === 34);
  check("a second waveform: only its waveform, its frame, bars and name", ti[1].props.waveform && !ti[1].props.art && !ti[1].props.title && ti[1].props.bars === 40 && ti[1].name === "Second wave" && eq(ti[1].frame, { x: 0.1, y: 0.1, w: 0.2, h: 0.05 }));
  check("a second hidden title: hidden, only the title, its artist switch", ti[2].visible === false && ti[2].props.title && !ti[2].props.waveform && ti[2].props.showArtist === false);
}
{
  // An id already called trackInfo (a text layer, say) is not taken over.
  const old = v1Scene();
  old.layers.push({ id: "trackInfo", type: "text", visible: true, frame: { x: 0.3, y: 0.4, w: 0.2, h: 0.1 }, props: {} });
  const m = parseScene(old);
  check("a taken id: the Track Info gets the next one", m.layers.find((l) => l.type === "trackInfo").id === "trackInfo-2" && m.layers.find((l) => l.type === "text").id === "trackInfo");
}
{
  // Bad data: frames, props and visibility that are not what they should be.
  const bad = parseScene({ v: 1, aspect: "16:9", layers: [
    { type: "camera" },
    { type: "title", frame: "nope", props: "x", visible: "yes" },
    { type: "albumArt", frame: { x: -3, y: 9, w: 7, h: 0 } },
    { type: "waveform", props: { bars: "lots" } },
    null, 7, { type: "title", frame: null },
  ] });
  const ti = tiOf(bad);
  check("bad data: no throw, the frame falls back and is clamped", ti.length === 2 && inUnit(ti[0].frame) && eq(ti[0].frame, { x: 0, y: 0.99, w: 1, h: 0.01 }));
  check("bad data: props cleaned (bars default, artist shown)", ti[0].props.bars === 34 && ti[0].props.showArtist === true && ti[0].props.art && ti[0].props.title && ti[0].props.waveform);
  check("bad data: a missing frame takes Track Info's default", eq(ti[1].frame, defaultFrame("trackInfo")));
  check("migrateLayers passes non-arrays and plain lists through", eq(migrateLayers(null), []) && migrateLayers(s.layers) === s.layers);
}
{
  // Idempotence: migrating twice, or loading what was saved, gives the same scene.
  const old = v1Scene("9:16");
  old.layers.find((l) => l.id === "albumArt").visible = false;
  const once = parseScene(old);
  check("idempotent: parse twice is the same", eq(parseScene(once), once) && eq(parseScene(serializeScene(once)), once));
  check("idempotent: migrateLayers on its own output changes nothing", eq(migrateLayers(migrateLayers(old.layers)), migrateLayers(old.layers)));
  check("the saved form carries version 2 and no old layer", serializeScene(once).v === 2 && !JSON.stringify(serializeScene(once)).includes("\"albumArt\""));
}


console.log(`\n${passed} passed, ${failed} failed`);
if (failed) process.exit(1);
