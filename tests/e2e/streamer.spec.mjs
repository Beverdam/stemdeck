// Streamer Mode (static/js/streamer/): a view over the workspace. These pin
// the phase 1 contract: entering and leaving from the rail and the Mode menu
// keeps the song and its position; a saved mix of its own for every song,
// apart from Practice's, Advanced's and Karaoke's (mixer.js, mixMode.js); the
// footer hidden while open (as in Karaoke) and back after, with Streamer's
// own Stop and Play / Pause; the aspect is saved per song; the tabs; the safe
// zones switch; and one workspace view at a time with Karaoke.

import { test, expect } from "@playwright/test";
import { JOB_ID, SIBLING_JOB_ID, openStudio } from "./helpers.mjs";

const ev = (page, fn, arg) => page.evaluate(fn, arg);
const sm = (page, sel) => page.locator(`#streamer ${sel}`);
const seek = (page, s) => ev(page, async (x) => (await import("/js/transport.js")).setPlayheadTime(x), s);
const now = (page) => ev(page, async () => (await import("/js/transport.js")).transport().getCurrentTime());
const setMode = async (page, mode) => {
  await ev(page, async (m) => (await import("/js/mode.js")).setMode(m), mode);
  await page.waitForTimeout(700);
};
const mixOf = (page) => ev(page, async () => {
  const { mixerState, trackIndex } = await import("/js/state.js");
  const { mixGlobals } = await import("/js/mixer.js");
  const lanes = Object.fromEntries(Object.keys(trackIndex).map((n) => [n, `${mixerState[n].muted ? "M" : "-"}${mixerState[n].soloed ? "S" : "-"}`]));
  return { lanes, speed: mixGlobals.speed };
});
const toggleMute = (page, name) => ev(page, async (n) => (await import("/js/mixer.js")).toggleStemMute(n), name);
const savedMix = (page, mode) => ev(page, async ([id, m]) => (await import("/js/utils.js")).storeGet(`stemdeck:mix:${id}:${m}`, null), [JOB_ID, mode]);
const savedScene = (page, id = JOB_ID) => ev(page, async (jid) => (await import("/js/utils.js")).storeGet(`stemdeck:streamer:scene:${jid}`, null), id);

async function openStreamer(page) {
  await page.locator("#streamerBtn").click();
  await expect(page.locator("#streamer")).toBeVisible();
  await expect(page.locator("#streamerBtn")).toHaveAttribute("aria-pressed", "true");
}

async function closeStreamer(page) {
  await page.locator("#streamerBtn").click();
  await expect(page.locator("#streamer")).toBeHidden();
  await expect(page.locator("#streamerBtn")).toHaveAttribute("aria-pressed", "false");
}

test.describe("Streamer Mode", () => {
  test.beforeEach(async ({ page }) => {
    await page.setViewportSize({ width: 1800, height: 1020 });
  });

  test("the rail item opens and closes it over the lanes, keeping the song and position", async ({ page }) => {
    await openStudio(page);
    await seek(page, 3);
    await openStreamer(page);
    await expect(page.locator("html")).toHaveClass(/streamer-open/);
    await expect(page.locator("#lanes")).toHaveAttribute("inert", "");
    await expect(sm(page, ".sm-head-title")).toHaveText("Streamer Mode");
    expect(Math.abs((await now(page)) - 3)).toBeLessThan(0.3);
    await closeStreamer(page);
    await expect(page.locator("#lanes")).not.toHaveAttribute("inert", "");
    await expect(page.locator("html")).not.toHaveClass(/streamer-open/);
    expect(Math.abs((await now(page)) - 3)).toBeLessThan(0.3);
  });

  test("the footer is hidden while open and back after; Stop and Play / Pause are Streamer's own", async ({ page }) => {
    await openStudio(page);
    const footer = page.locator(".daw-footer");
    await expect(footer).toBeVisible();
    await openStreamer(page);
    await expect(footer).toBeHidden();
    // The view takes the footer's place: down to the bottom of the column.
    const view = await page.locator("#streamer").boundingBox();
    const col = await page.locator(".daw-main-col").boundingBox();
    expect(Math.abs(view.y + view.height - (col.y + col.height))).toBeLessThanOrEqual(1);
    const playing = () => ev(page, async () => (await import("/js/transport.js")).transport().isPlaying());
    const play = sm(page, ".sm-play");
    await expect(play).toHaveAttribute("aria-label", "Play");
    await play.click();
    await expect.poll(playing).toBe(true);
    await expect(play).toHaveAttribute("aria-label", "Pause");
    await play.click();
    await expect.poll(playing).toBe(false);
    await seek(page, 3);
    await sm(page, ".sm-stop").click();
    await expect.poll(() => now(page)).toBeLessThan(0.3);
    await closeStreamer(page);
    await expect(footer).toBeVisible();
    // Karaoke and back: the footer follows whichever view is open.
    await openStreamer(page);
    await page.locator("#karaokeBtn").click();
    await expect(footer).toBeHidden();
    await page.locator("#karaokeBtn").click();
    await expect(footer).toBeVisible();
  });

  test("its own saved mix: nothing leaks into Practice, Advanced or Karaoke", async ({ page }) => {
    await openStudio(page);
    await setMode(page, "daw");
    const advanced = await mixOf(page);
    await setMode(page, "practice");
    await toggleMute(page, "drums");
    await page.waitForTimeout(500);
    const practice = await mixOf(page);
    const practiceSaved = await savedMix(page, "practice");

    await openStreamer(page);
    // Streamer starts from its defaults, not Practice's muted drums.
    await expect.poll(async () => (await mixOf(page)).lanes.drums).toBe("--");
    await toggleMute(page, "bass");
    await ev(page, async () => (await import("/js/transport.js")).setSpeed(0.75));
    await page.waitForTimeout(500);
    const streamer = await mixOf(page);
    expect(streamer.lanes.bass).toBe("M-");
    await closeStreamer(page);

    await expect.poll(() => mixOf(page)).toEqual(practice);
    expect(await savedMix(page, "practice")).toEqual(practiceSaved);
    await setMode(page, "daw");
    await expect.poll(() => mixOf(page)).toEqual(advanced);
    await setMode(page, "practice");

    // Karaoke keeps its own mix too, with the voice off.
    await page.locator("#karaokeBtn").click();
    await expect(page.locator("#karaoke")).toBeVisible();
    await expect.poll(async () => (await mixOf(page)).lanes.vocals).toBe("M-");
    expect((await mixOf(page)).lanes.bass).toBe("--");
    await page.locator("#karaokeBtn").click();

    // Back in Streamer: its own record is still there.
    await openStreamer(page);
    await expect.poll(() => mixOf(page)).toEqual(streamer);
    expect(await savedMix(page, "streamer")).not.toBeNull();
  });

  test("one view at a time with Karaoke", async ({ page }) => {
    await openStudio(page);
    await openStreamer(page);
    await page.locator("#karaokeBtn").click();
    await expect(page.locator("#karaoke")).toBeVisible();
    await expect(page.locator("#streamer")).toBeHidden();
    await expect(page.locator("#lanes")).toHaveAttribute("inert", "");
    await page.locator("#streamerBtn").click();
    await expect(page.locator("#streamer")).toBeVisible();
    await expect(page.locator("#karaoke")).toBeHidden();
    await closeStreamer(page);
    await expect(page.locator("#lanes")).not.toHaveAttribute("inert", "");
  });

  test("the Mode menu lists Streamer and shows it current while open", async ({ page }) => {
    await openStudio(page);
    await page.locator("#modeBtn").click();
    await expect(page.locator('.mode-item[data-mode="streaming"]')).toHaveAttribute("aria-disabled", "true");
    await page.locator('.mode-item[data-mode="streamer"]').click();
    await expect(page.locator("#streamer")).toBeVisible();
    await page.locator("#modeBtn").click();
    await expect(page.locator('.mode-item[data-mode="streamer"]')).toHaveAttribute("aria-checked", "true");
    await page.locator('.mode-item[data-mode="practice"]').click();
    await expect(page.locator("#streamer")).toBeHidden();
  });

  test("tabs: Live Controls and Templates are not available yet", async ({ page }) => {
    await openStudio(page);
    await openStreamer(page);
    await expect(sm(page, '[role=tab][data-tab="builder"]')).toHaveAttribute("aria-selected", "true");
    await sm(page, '[role=tab][data-tab="live"]').click();
    await expect(page.locator("#streamerBuilderPanel")).toBeHidden();
    await expect(page.locator("#streamerOtherPanel")).toContainText("Live Controls");
    await expect(page.locator("#streamerOtherPanel")).toContainText("Not available yet.");
    await sm(page, '[role=tab][data-tab="templates"]').click();
    await expect(page.locator("#streamerOtherPanel")).toContainText("Templates");
    await sm(page, '[role=tab][data-tab="builder"]').click();
    await expect(page.locator("#streamerBuilderPanel")).toBeVisible();
    await expect(sm(page, ".sm-canvas")).toBeVisible();
  });

  test("the aspect is saved per song; a new song starts with the default scene", async ({ page }) => {
    await openStudio(page);
    await openStreamer(page);
    const aspect = sm(page, ".sm-aspect select");
    await expect(aspect).toHaveValue("16:9");
    await aspect.selectOption("9:16");
    await expect.poll(async () => (await savedScene(page))?.aspect).toBe("9:16");
    // The preview stays 16:9 on screen whatever the scene's aspect.
    const box = await sm(page, ".sm-preview").boundingBox();
    expect(Math.abs(box.width / box.height - 16 / 9)).toBeLessThan(0.02);

    await page.locator(`.cat-item[data-id="${SIBLING_JOB_ID}"]`).first().click();
    await expect(aspect).toHaveValue("16:9");
    expect(await savedScene(page, SIBLING_JOB_ID)).toBeNull();
    await page.locator(`.cat-item[data-id="${JOB_ID}"]`).first().click();
    await expect(aspect).toHaveValue("9:16");
  });

  test("Show Safe Zones switches and is remembered", async ({ page }) => {
    await openStudio(page);
    await openStreamer(page);
    const sw = sm(page, ".sm-safe");
    await expect(sw).toHaveAttribute("aria-checked", "false");
    await sw.click();
    await expect(sw).toHaveAttribute("aria-checked", "true");
    expect(await ev(page, () => localStorage.getItem("stemdeck.streamer.safeZones"))).toBe("1");
    // Space on the switch presses it, and does not start playback.
    await sw.focus();
    await page.keyboard.press("Space");
    await expect(sw).toHaveAttribute("aria-checked", "false");
    expect(await ev(page, async () => (await import("/js/transport.js")).transport().isPlaying())).toBe(false);
  });

  test("a layer can be hidden, for this song only", async ({ page }) => {
    await openStudio(page);
    await openStreamer(page);
    const lyrics = sm(page, '.sm-layer[data-layer="lyrics"] [role=switch]');
    await expect(lyrics).toHaveAttribute("aria-checked", "true");
    await lyrics.click();
    await expect(lyrics).toHaveAttribute("aria-checked", "false");
    await expect.poll(async () => (await savedScene(page))?.layers.find((l) => l.id === "lyrics").visible).toBe(false);
  });

  test("export to a file is the only way out: no upload card, Export MP4 waits for a take", async ({ page }) => {
    await openStudio(page);
    await openStreamer(page);
    await expect(sm(page, ".sm-yt")).toHaveCount(0);
    await expect(sm(page, ".sm-export-go")).toBeVisible();
    await expect(sm(page, ".sm-export-go")).toBeDisabled();
    await expect(sm(page, ".sm-export-text")).toHaveText("Record a take, then export it here as an MP4.");
  });
});

// Phase 2: editing the scene and the take timeline.
test.describe("Streamer Mode: layers and timeline", () => {
  const layerOf = async (page, id) => (await savedScene(page))?.layers.find((l) => l.id === id);
  const sceneBox = (page) => ev(page, () => {
    const p = document.querySelector("#streamer .sm-preview");
    const r = p.getBoundingClientRect();
    return { x: r.left + p.clientLeft, y: r.top + p.clientTop, w: p.clientWidth, h: p.clientHeight };
  });
  const undoOn = (page) => ev(page, () => !document.querySelector("#streamer .sm-undo").disabled);
  async function dragMouse(page, from, to, { alt = false } = {}) {
    await page.mouse.move(...from);
    if (alt) await page.keyboard.down("Alt");
    await page.mouse.down();
    await page.mouse.move(...to, { steps: 8 });
    await page.mouse.up();
    if (alt) await page.keyboard.up("Alt");
  }
  async function menu(page, id, item) {
    await sm(page, `.sm-layer[data-layer="${id}"] .sm-layer-kebab`).click();
    await page.locator(`.sm-menu [data-item="${item}"]`).click();
  }

  test.beforeEach(async ({ page }) => {
    await page.setViewportSize({ width: 1800, height: 1020 });
    await openStudio(page);
    await openStreamer(page);
  });

  test("select by row and by clicking the preview", async ({ page }) => {
    await sm(page, '.sm-layer[data-layer="lyrics"] .sm-layer-pick').click();
    await expect(sm(page, '.sm-layer[data-layer="lyrics"]')).toHaveClass(/selected/);
    await expect(sm(page, ".sm-selbox")).toBeVisible();
    const f = await sceneBox(page);
    await page.mouse.click(f.x + f.w * 0.06, f.y + f.h * 0.92);
    await expect(sm(page, '.sm-layer[data-layer="lowerThird"]')).toHaveClass(/selected/);
  });

  test("a drag moves a layer, snaps to the safe zone, and is one undo step", async ({ page }) => {
    const f = await sceneBox(page);
    await page.mouse.click(f.x + f.w * 0.06, f.y + f.h * 0.92);
    const start = [f.x + f.w * 0.06, f.y + f.h * 0.92];
    // The lower third's left edge (12/716) moved to 3 px right of the 10% line.
    const dx = (0.1 - 12 / 716) * f.w + 3;
    await dragMouse(page, start, [start[0] + dx, start[1] - f.h * 0.3]);
    await expect.poll(async () => (await layerOf(page, "lowerThird"))?.frame.x).toBeCloseTo(0.1, 9);
    await sm(page, ".sm-undo").click();
    await expect.poll(async () => (await layerOf(page, "lowerThird")).frame.x).toBeCloseTo(12 / 716, 6);
    await expect.poll(() => undoOn(page)).toBe(false);
    // Alt: no snapping.
    await dragMouse(page, start, [start[0] + dx, start[1] - f.h * 0.3], { alt: true });
    await expect.poll(async () => Math.abs((await layerOf(page, "lowerThird")).frame.x - 0.1) > 1e-4).toBe(true);
  });

  test("resize from a corner keeps the opposite corner", async ({ page }) => {
    await sm(page, '.sm-layer[data-layer="lyrics"] .sm-layer-pick').click();
    const h = await sm(page, ".sm-handle-se").boundingBox();
    await dragMouse(page, [h.x + 4, h.y + 4], [h.x - 56, h.y - 36], { alt: true });
    await expect.poll(async () => (await layerOf(page, "lyrics"))?.frame.w).toBeLessThan(216 / 716 - 0.05);
    const fr = (await layerOf(page, "lyrics")).frame;
    expect(fr.x).toBeCloseTo(494 / 716, 6);
    expect(fr.y).toBeCloseTo(263 / 403, 6);
  });

  test("reorder by the handle: the list is the drawing order", async ({ page }) => {
    const grip = await sm(page, '.sm-layer[data-layer="lyrics"] .sm-layer-grip').boundingBox();
    const first = await sm(page, ".sm-layer").first().boundingBox();
    await dragMouse(page, [grip.x + grip.width / 2, grip.y + grip.height / 2], [grip.x + grip.width / 2, first.y + 4]);
    await expect(sm(page, ".sm-layer").first()).toHaveAttribute("data-layer", "lyrics");
    await expect.poll(async () => (await savedScene(page))?.layers.at(-1).id).toBe("lyrics");
  });

  test("the layer menu: rename, duplicate, edit, delete; camera keeps its place", async ({ page }) => {
    await menu(page, "lowerThird", "rename");
    await page.keyboard.press("Control+A");
    await page.keyboard.type("My handle");
    await page.keyboard.press("Enter");
    await expect.poll(async () => (await layerOf(page, "lowerThird"))?.name).toBe("My handle");
    await menu(page, "lowerThird", "duplicate");
    await expect.poll(async () => Boolean(await layerOf(page, "lowerThird-2"))).toBe(true);
    await menu(page, "lowerThird", "edit");
    await page.locator(".sm-props input").first().fill("@me");
    await page.locator(".sm-props input").first().press("Tab");
    await expect.poll(async () => (await layerOf(page, "lowerThird")).props.handle).toBe("@me");
    await page.keyboard.press("Escape");
    await expect(page.locator(".sm-props")).toHaveCount(0);
    await menu(page, "lowerThird-2", "delete");
    await expect.poll(async () => Boolean(await layerOf(page, "lowerThird-2"))).toBe(false);
    await sm(page, '.sm-layer[data-layer="camera"] .sm-layer-kebab').click();
    await expect(page.locator('.sm-menu [data-item="delete"]')).toHaveAttribute("aria-disabled", "true");
    await expect(page.locator('.sm-menu [data-item="duplicate"]')).toHaveAttribute("aria-disabled", "true");
    await page.keyboard.press("Escape");
    await expect(page.locator(".sm-menu")).toHaveCount(0);
    await expect(sm(page, '.sm-layer[data-layer="camera"] .sm-layer-kebab')).toBeFocused();
  });

  test("+ Add Layer adds every type; undo takes them all back", async ({ page }) => {
    for (const type of ["text", "image", "lowerThird", "lyrics", "waveform", "albumArt", "title"]) {
      await sm(page, ".sm-add").click();
      await page.locator(`.sm-menu [data-item="${type}"]`).click();
    }
    await expect.poll(async () => (await savedScene(page))?.layers.length).toBe(14);
    for (let i = 0; i < 7; i++) await sm(page, ".sm-undo").click();
    await expect.poll(async () => (await savedScene(page))?.layers.length).toBe(7);
    await expect.poll(() => undoOn(page)).toBe(false);
  });

  test("Delete removes the selected layer, never the song", async ({ page }) => {
    await sm(page, ".sm-add").click();
    await page.locator('.sm-menu [data-item="text"]').click();
    await expect.poll(async () => Boolean(await layerOf(page, "text"))).toBe(true);
    await sm(page, ".sm-fit").focus();
    await page.keyboard.press("Delete");
    await expect.poll(async () => Boolean(await layerOf(page, "text"))).toBe(false);
    await expect(page.locator(`#catalogList .cat-item[data-id="${JOB_ID}"]`).first()).not.toHaveClass(/in-trash/);
    await sm(page, '.sm-layer[data-layer="camera"] .sm-layer-pick').click();
    const before = JSON.stringify(await savedScene(page));
    await page.keyboard.press("Delete");
    await page.keyboard.press("Backspace");
    await page.waitForTimeout(500);
    expect(JSON.stringify(await savedScene(page))).toBe(before);
    await expect(page.locator(`#catalogList .cat-item[data-id="${JOB_ID}"]`).first()).not.toHaveClass(/in-trash/);
  });

  test("arrows nudge 1% and 5%; Ctrl+Z undoes", async ({ page }) => {
    await sm(page, '.sm-layer[data-layer="waveform"] .sm-layer-pick').click();
    await sm(page, ".sm-preview").focus();
    await page.keyboard.press("ArrowRight");
    await page.keyboard.press("Shift+ArrowDown");
    await expect.poll(async () => (await layerOf(page, "waveform"))?.frame.y).toBeCloseTo(74 / 403 + 0.05, 9);
    expect((await layerOf(page, "waveform")).frame.x).toBeCloseTo(582 / 716 + 0.01, 9);
    await page.keyboard.press("Control+z");
    await expect.poll(async () => (await layerOf(page, "waveform")).frame.y).toBeCloseTo(74 / 403, 9);
  });

  test("zoom, Fit and the ruler", async ({ page }) => {
    const widths = () => ev(page, () => {
      const s = document.querySelector("#streamer .sm-tl-scroll");
      return [s.clientWidth, s.scrollWidth];
    });
    for (let i = 0; i < 4; i++) await sm(page, ".sm-zoom-in").click();
    await expect.poll(async () => { const [c, s] = await widths(); return s > c * 1.2; }).toBe(true);
    await sm(page, ".sm-fit").click();
    await expect.poll(async () => { const [c, s] = await widths(); return s <= c + 1; }).toBe(true);
    const rb = await sm(page, ".sm-tl-ruler").boundingBox();
    await page.mouse.click(rb.x + rb.width / 2, rb.y + rb.height / 2);
    const dur = await ev(page, async () => (await import("/js/state.js")).totalDuration);
    await expect.poll(() => now(page)).toBeGreaterThan(dur * 0.45);
    expect(await now(page)).toBeLessThan(dur * 0.55);
  });

  test("trim: the in handle sets the range, saved per song", async ({ page }) => {
    const h = await sm(page, ".sm-tl-trim-l").boundingBox();
    const rb = await sm(page, ".sm-tl-ruler").boundingBox();
    await dragMouse(page, [h.x + 6, h.y + h.height / 2], [h.x + 6 + rb.width * 0.3, h.y + h.height / 2], { alt: true });
    await expect.poll(async () => (await savedScene(page))?.trim?.in ?? 0).toBeGreaterThan(1);
    const saved = (await savedScene(page)).trim;
    await page.reload({ waitUntil: "domcontentloaded" });
    await page.locator(`.cat-item[data-id="${JOB_ID}"]`).first().click();
    await openStreamer(page);
    await expect.poll(async () => (await savedScene(page))?.trim).toEqual(saved);
  });
});

// Phase 3: the camera, the input and the output settings, on Chromium's fake
// camera and microphone.
test.describe("Streamer Mode: devices and meter", () => {
  test.use({ launchOptions: { args: ["--use-fake-device-for-media-stream", "--use-fake-ui-for-media-stream", "--mute-audio"] } });
  const media = (page) => ev(page, async () => {
    const m = (await import("/js/streamer/streamerDevices.js")).getStreamerMedia();
    return { camera: Boolean(m.camera?.active), audio: Boolean(m.audio) };
  });
  const savedSettings = (page) => ev(page, async () => (await import("/js/utils.js")).storeGet("stemdeck:streamer:recording", null));

  test.beforeEach(async ({ page }) => {
    await page.setViewportSize({ width: 1800, height: 1020 });
    await openStudio(page);
    await openStreamer(page);
    const allow = sm(page, ".sm-cam-act");
    if (await allow.isVisible()) await allow.click();
  });

  test("the device lists fill and the live camera and the meter run", async ({ page }) => {
    await expect.poll(() => page.locator("#streamerVideoSrc option").count()).toBeGreaterThan(2);
    await expect.poll(() => page.locator("#streamerAudioSrc option").count()).toBeGreaterThan(2);
    await expect.poll(async () => (await media(page)).camera).toBe(true);
    await expect(sm(page, '.sm-layer[data-layer="camera"] .sm-layer-sub')).toContainText("×");
    const meter = sm(page, ".sm-meter");
    await expect(meter).toHaveAttribute("role", "meter");
    await expect(meter).toHaveAttribute("aria-valuemin", "-60");
    await expect.poll(async () => Number(await meter.getAttribute("aria-valuenow"))).toBeGreaterThan(-60);
  });

  test("closing Streamer stops the camera and the input", async ({ page }) => {
    await expect.poll(async () => (await media(page)).camera).toBe(true);
    await ev(page, async () => {
      const m = (await import("/js/streamer/streamerDevices.js")).getStreamerMedia();
      window.__tracks = [...m.camera.getTracks(), ...(m.audio?.getTracks() || [])];
    });
    await closeStreamer(page);
    await expect.poll(() => ev(page, () => window.__tracks.every((tr) => tr.readyState === "ended"))).toBe(true);
  });

  test("hiding the Camera layer or choosing No camera releases it", async ({ page }) => {
    await expect.poll(async () => (await media(page)).camera).toBe(true);
    await sm(page, '.sm-layer[data-layer="camera"] [role=switch]').click();
    await expect.poll(async () => (await media(page)).camera).toBe(false);
    await sm(page, '.sm-layer[data-layer="camera"] [role=switch]').click();
    await expect.poll(async () => (await media(page)).camera).toBe(true);
    await page.locator("#streamerVideoSrc").selectOption("none");
    await expect.poll(async () => (await media(page)).camera).toBe(false);
  });

  test("output settings are kept per user, 60 fps warns", async ({ page }) => {
    await expect(sm(page, ".sm-heavy")).toBeHidden();
    await page.locator("#streamerFps").selectOption("60");
    await expect(sm(page, ".sm-heavy")).toBeVisible();
    await page.locator("#streamerRes").selectOption("720");
    await page.locator("#streamerFps").selectOption("24");
    await expect(sm(page, ".sm-heavy")).toBeHidden();
    await sm(page, '[data-setting="autoStopAtEnd"]').click();
    await expect.poll(async () => (await savedSettings(page))?.resolution).toBe("720");
    expect((await savedSettings(page)).fps).toBe(24);
    expect((await savedSettings(page)).autoStopAtEnd).toBe(false);
    await page.reload({ waitUntil: "domcontentloaded" });
    await page.locator(`.cat-item[data-id="${JOB_ID}"]`).first().click();
    await openStreamer(page);
    await expect(page.locator("#streamerRes")).toHaveValue("720");
    await expect(page.locator("#streamerFps")).toHaveValue("24");
    await expect(sm(page, '[data-setting="autoStopAtEnd"]')).toHaveAttribute("aria-checked", "false");
  });
});

test.describe("Streamer Mode: camera refused", () => {
  test("a refusal shows the reason with Retry, in the preview and the panel", async ({ page }) => {
    await page.setViewportSize({ width: 1800, height: 1020 });
    await page.addInitScript(() => {
      navigator.mediaDevices.getUserMedia = () => Promise.reject(Object.assign(new Error("denied"), { name: "NotAllowedError" }));
    });
    await openStudio(page);
    await openStreamer(page);
    const act = sm(page, ".sm-cam-act");
    await expect(act).toBeVisible();
    await act.click();
    await expect(sm(page, ".sm-cam-text")).toContainText("blocked");
    await expect(act).toHaveText("Retry");
    await expect(sm(page, ".sm-dev-state").first()).toContainText("blocked");
  });
});

// Phase 4: recording the scene and exporting it through the server.
test.describe("Streamer Mode: recording and export", () => {
  test.use({ launchOptions: { args: ["--use-fake-device-for-media-stream", "--use-fake-ui-for-media-stream", "--mute-audio", "--autoplay-policy=no-user-gesture-required"] } });
  const recording = (page) => ev(page, () => document.querySelector("#streamer .sm-rec")?.classList.contains("recording"));

  async function setUp(page, trim = { in: 1, out: 4 }) {
    await page.setViewportSize({ width: 1800, height: 1020 });
    await openStudio(page);
    await ev(page, async ([id, tr]) => {
      const m = await import("/js/streamer/streamerModel.js");
      const { storeSet } = await import("/js/utils.js");
      await storeSet(`stemdeck:streamer:scene:${id}`, m.serializeScene({ ...m.defaultScene("16:9"), trim: tr }));
    }, [JOB_ID, trim]);
    await page.reload({ waitUntil: "domcontentloaded" });
    await page.locator(`.cat-item[data-id="${JOB_ID}"]`).first().click();
    await page.waitForFunction(() => !/\/\s*00:00\s*$/.test(document.querySelector("#t-time")?.textContent || "00:00 / 00:00"));
    await openStreamer(page);
    const allow = sm(page, ".sm-cam-act");
    if (await allow.isVisible()) await allow.click();
  }

  test("R records from the trim's start, auto-stops at its end, and the take is kept", async ({ page }) => {
    await setUp(page);
    await sm(page, ".sm-preview").focus();
    await page.keyboard.press("r");
    await expect.poll(() => recording(page)).toBe(true);
    expect(Math.abs((await now(page)) - 1)).toBeLessThan(1);
    await expect(sm(page, ".sm-add")).toBeDisabled();
    await expect.poll(() => recording(page), { timeout: 20000 }).toBe(false);
    await expect(sm(page, ".sm-export-go")).toBeVisible({ timeout: 30000 });
    await expect(sm(page, ".sm-add")).toBeEnabled();
  });

  test("speed not 100% refuses recording with the reason", async ({ page }) => {
    await setUp(page);
    await ev(page, async () => (await import("/js/transport.js")).setSpeed(0.75));
    await sm(page, ".sm-rec").click();
    await expect(page.locator("#streamerNote")).toContainText("100%");
    expect(await recording(page)).toBe(false);
  });

  test("export makes an MP4 named after the song", async ({ page }) => {
    await setUp(page);
    await sm(page, ".sm-rec").click();
    await expect.poll(() => recording(page), { timeout: 20000 }).toBe(false);
    await expect(sm(page, ".sm-export-go")).toBeEnabled({ timeout: 30000 });
    const download = page.waitForEvent("download", { timeout: 120000 });
    await sm(page, ".sm-export-go").click();
    const file = await download;
    expect(file.suggestedFilename()).toMatch(/\(Streamer\)\.mp4$/);
    await expect(sm(page, ".sm-export-text")).toContainText("Saved");
    // No desktop app here: Show in folder is not offered.
    await expect(sm(page, ".sm-export-reveal")).toBeHidden();
  });

  test("Delete during a take does not trash the song", async ({ page }) => {
    await setUp(page, { in: 0, out: 5 });
    await sm(page, ".sm-rec").click();
    await expect.poll(() => recording(page)).toBe(true);
    await sm(page, ".sm-preview").focus();
    await page.keyboard.press("Delete");
    await expect(page.locator(`#catalogList .cat-item[data-id="${JOB_ID}"]`).first()).not.toHaveClass(/in-trash/);
    await page.keyboard.press("r");
    await expect.poll(() => recording(page)).toBe(false);
  });
});

// Phase 5: narrow layouts, empty and error states, pictures, the second lane.
test.describe("Streamer Mode polish", () => {
  // A small PNG, made by the browser itself.
  const pngOf = async (page) => Buffer.from(await ev(page, () => {
    const c = document.createElement("canvas");
    c.width = 64;
    c.height = 36;
    c.getContext("2d").fillRect(0, 0, 64, 36);
    return c.toDataURL("image/png").split(",")[1];
  }), "base64");

  test("under 1000 px: Output opens a drawer, focus moves in, Escape closes it", async ({ page }) => {
    await page.setViewportSize({ width: 1280, height: 800 });
    await openStudio(page);
    await openStreamer(page);
    const out = sm(page, ".sm-output-btn");
    await expect(out).toBeVisible();
    await out.click();
    await expect(out).toHaveAttribute("aria-expanded", "true");
    expect(await ev(page, () => document.querySelector("#streamer .sm-side").contains(document.activeElement))).toBe(true);
    await page.keyboard.press("Escape");
    await expect(out).toHaveAttribute("aria-expanded", "false");
    await expect(out).toBeFocused();
  });

  test("under 1000 px: the label column is 56 px and the preview never under 480 px", async ({ page }) => {
    await page.setViewportSize({ width: 800, height: 700 });
    await openStudio(page);
    await openStreamer(page);
    const label = await sm(page, ".sm-tl-label-video").boundingBox();
    const preview = await sm(page, ".sm-preview").boundingBox();
    expect(Math.round(label.width)).toBe(56);
    expect(preview.width).toBeGreaterThanOrEqual(479);
    expect(await ev(page, () => document.documentElement.scrollWidth > window.innerWidth)).toBe(false);
  });

  test("no song open: the view says so and nothing under it is reachable", async ({ page }) => {
    await page.goto("/");
    await openStreamer(page);
    await expect(sm(page, ".sm-no-track")).toBeVisible();
    expect(await ev(page, () => document.querySelector("#streamer .sm-center").inert)).toBe(true);
  });

  test("a background picture is chosen, kept, shown in the row and undone", async ({ page }) => {
    await openStudio(page);
    await openStreamer(page);
    const row = sm(page, '.sm-layer[data-layer="background"]');
    await row.locator(".sm-layer-kebab").click();
    await page.locator('.sm-menu-item[data-item="edit"]').click();
    await page.setInputFiles(".sm-props input[type=file]", { name: "p.png", mimeType: "image/png", buffer: await pngOf(page) });
    await expect(page.locator(".sm-props-picture-msg")).toContainText("KB");
    await expect(page.locator(".sm-props-remove")).toBeVisible();
    await page.locator(".sm-props-done").click();
    await expect(row.locator(".sm-layer-sub")).toHaveText("Your image");
    expect((await savedScene(page))?.layers?.find((l) => l.id === "background")?.props?.imageKey).toMatch(new RegExp(`^${JOB_ID}:background:`));
    await sm(page, ".sm-undo").click();
    await expect(row.locator(".sm-layer-sub")).not.toHaveText("Your image");
  });

  test("a file that is not a picture is refused with a message", async ({ page }) => {
    await openStudio(page);
    await openStreamer(page);
    await sm(page, '.sm-layer[data-layer="background"] .sm-layer-kebab').click();
    await page.locator('.sm-menu-item[data-item="edit"]').click();
    await page.setInputFiles(".sm-props input[type=file]", { name: "n.txt", mimeType: "text/plain", buffer: Buffer.from("x") });
    await expect(page.locator(".sm-props-picture-msg")).toContainText("PNG, JPEG or WebP");
  });

  test("I play leaves the part out of what Streamer plays, for Streamer only", async ({ page }) => {
    await openStudio(page);
    await openStreamer(page);
    const sel = page.locator("#streamerPart");
    const values = await sel.locator("option").evaluateAll((os) => os.map((o) => o.value));
    expect(values[0]).toBe("");
    // Keys and Voice, the instrument families, not the stem names Piano and Vocals.
    const texts = await sel.locator("option").evaluateAll((os) => Object.fromEntries(os.map((o) => [o.value, o.textContent])));
    if ("piano" in texts) expect(texts.piano).toBe("Keys");
    if ("vocals" in texts) expect(texts.vocals).toBe("Voice");
    test.skip(!values.includes("drums"), "the test song has no drums stem");
    await sel.selectOption("drums");
    await expect.poll(() => ev(page, async () => [...(await import("/js/player.js")).playbackExclusion().names])).toContain("drums");
    await expect(sm(page, ".sm-tl-label-stem").first()).toHaveText("Backing track");
    expect(await ev(page, (id) => JSON.parse(localStorage.getItem(`stemdeck:stems:${id}:streamer`)).remove, JOB_ID)).toBe("drums");
    expect(await ev(page, (id) => localStorage.getItem(`stemdeck:stems:${id}:practice`), JOB_ID)).toBe(null);
    await closeStreamer(page);
    await expect.poll(() => ev(page, async () => (await import("/js/player.js")).playbackExclusion().names.size)).toBe(0);
  });

  test("an export failure says why and offers Retry", async ({ page }) => {
    await openStudio(page);
    await ev(page, (id) => localStorage.setItem(`stemdeck:streamer:take:${id}`, "fake-take"), JOB_ID);
    await page.route("**/takes/fake-take/render", (r) => r.fulfill({ status: 500, contentType: "application/json", body: JSON.stringify({ detail: "ffmpeg exited with code 1" }) }));
    // Streamer checks that the last take is still on the server: the job lists it.
    await page.route(`**/api/jobs/${JOB_ID}`, async (r) => {
      if (r.request().method() !== "GET") return r.continue();
      const res = await r.fetch();
      const job = await res.json();
      return r.fulfill({ response: res, json: { ...job, takes: [...(job.takes || []), { id: "fake-take" }] } });
    });
    await openStreamer(page);
    await sm(page, ".sm-export-go").click();
    await expect(sm(page, ".sm-export-text")).toContainText("ffmpeg exited with code 1");
    await expect(sm(page, ".sm-export-go")).toHaveText("Try again");
  });

  test("no audio input: the line says the take records the song only", async ({ page }) => {
    await openStudio(page);
    await openStreamer(page);
    await page.selectOption("#streamerAudioSrc", "none");
    await expect(sm(page, ".sm-dev-state").nth(1)).toContainText("song only");
  });
});

// The fix pass: the song is never trashed while Streamer is open, focus, a
// take's protections, the export at the recorded shape, no 4K.
test.describe("Streamer Mode fix pass", () => {
  test.beforeEach(async ({ page }) => {
    await page.setViewportSize({ width: 1800, height: 1020 });
  });

  test("Delete and Backspace never trash the song while Streamer is open, wherever focus is", async ({ page }) => {
    await openStudio(page);
    await openStreamer(page);
    // Focus moved into the view on open.
    expect(await ev(page, () => document.getElementById("streamer").contains(document.activeElement))).toBe(true);
    for (const target of ["#streamerBtn", `#catalogList .cat-item[data-id="${JOB_ID}"]`]) {
      await page.locator(target).first().focus();
      await page.keyboard.press("Delete");
      await page.keyboard.press("Backspace");
    }
    await page.waitForTimeout(400);
    await expect(page.locator(`#catalogList .cat-item[data-id="${JOB_ID}"]`).first()).not.toHaveClass(/in-trash/);
    await closeStreamer(page);
    // Focus is back on what opened it.
    await expect(page.locator("#streamerBtn")).toBeFocused();
  });

  test("no 4K: 720p and 1080p only, and settings saved at 4K open as 1080p", async ({ page }) => {
    await openStudio(page);
    await ev(page, async () => {
      const { storeSet } = await import("/js/utils.js");
      const { SETTINGS_KEY, defaultRecordingSettings } = await import("/js/streamer/outputSettings.js");
      await storeSet(SETTINGS_KEY, { ...defaultRecordingSettings(), resolution: "2160", fps: 30 });
    });
    const errors = [];
    page.on("pageerror", (e) => errors.push(e.message));
    await page.reload({ waitUntil: "domcontentloaded" });
    await page.locator(`.cat-item[data-id="${JOB_ID}"]`).first().click();
    await openStreamer(page);
    await expect(page.locator("#streamerRes option")).toHaveCount(2);
    expect(await page.locator("#streamerRes option").evaluateAll((os) => os.map((o) => o.value).sort())).toEqual(["1080", "720"]);
    await expect(page.locator("#streamerRes")).toHaveValue("1080");
    await expect(page.locator("#streamerFps")).toHaveValue("30");
    await expect(page.locator('#streamerFps option[value="60"]')).toBeEnabled();
    await expect(sm(page, ".sm-heavy")).toBeHidden();
    await page.locator("#streamerFps").selectOption("60");
    await expect(sm(page, ".sm-heavy")).toBeVisible();
    expect(errors).toEqual([]);
  });

  test("viewing a song's scene saves nothing", async ({ page }) => {
    await openStudio(page);
    await ev(page, (id) => localStorage.removeItem(`stemdeck:streamer:scene:${id}`), JOB_ID);
    await openStreamer(page);
    await page.waitForTimeout(1000);
    expect(await savedScene(page)).toBe(null);
  });

  test("a take is protected while it records, and exports at its recorded aspect", async ({ page }) => {
    await openStudio(page);
    await ev(page, async (id) => {
      const m = await import("/js/streamer/streamerModel.js");
      const { storeSet } = await import("/js/utils.js");
      await storeSet(`stemdeck:streamer:scene:${id}`, m.serializeScene({ ...m.defaultScene("16:9"), trim: { in: 1, out: 4 } }));
    }, JOB_ID);
    await page.reload({ waitUntil: "domcontentloaded" });
    await page.locator(`.cat-item[data-id="${JOB_ID}"]`).first().click();
    await openStreamer(page);
    await sm(page, ".sm-rec").click();
    await expect(sm(page, ".sm-rec")).toHaveClass(/recording/, { timeout: 15000 });
    await expect(sm(page, ".sm-undo")).toBeDisabled();
    await expect(page.locator("#streamerAudioSrc")).toBeDisabled();
    // Karaoke and the rail are refused while it records.
    await page.locator("#karaokeBtn").click();
    await expect(page.locator("#karaokeNote")).toContainText("Stop recording first");
    await page.locator("#streamerBtn").click();
    await expect(page.locator("html")).toHaveClass(/streamer-open/);
    await expect(sm(page, ".sm-rec")).toHaveClass(/recording/);
    // It stops at the trim's end; the scene then goes 9:16; the export says
    // it stays 16:9.
    await expect(sm(page, ".sm-export-go")).toBeEnabled({ timeout: 30000 });
    await sm(page, ".sm-aspect select").selectOption("9:16");
    await expect(sm(page, ".sm-export-text")).toContainText("16:9");
  });
});

// The input a take records and the take lane (fix: the drums on an audio
// interface were never recorded; the played part's lane showed the stem).
test.describe("Streamer Mode input and take lane", () => {
  test.beforeEach(async ({ page }) => {
    await page.setViewportSize({ width: 1800, height: 1020 });
  });

  test("Audio Source lists the studio's inputs with their channels", async ({ page }) => {
    await openStudio(page);
    await openStreamer(page);
    const opts = await page.locator("#streamerAudioSrc option").evaluateAll((os) => os.map((o) => o.textContent));
    expect(opts[0]).toBe("No audio input");
    expect(opts.some((o) => /Input 1/.test(o))).toBe(true);
  });

  test("the played part's lane is empty until a take, never the stem's wave", async ({ page }) => {
    await openStudio(page);
    await openStreamer(page);
    const values = await page.locator("#streamerPart option").evaluateAll((os) => os.map((o) => o.value));
    test.skip(!values.includes("drums"), "the test song has no drums stem");
    await page.locator("#streamerPart").selectOption("drums");
    await expect(sm(page, ".sm-tl-label-stem").nth(1)).toContainText("(you)");
    await expect(sm(page, ".sm-tl-take-hint")).toBeVisible();
    const ink = await ev(page, () => {
      const c = document.querySelector("#streamer .sm-tl-lane-1");
      const d = c.getContext("2d").getImageData(0, 0, c.width, c.height).data;
      for (let i = 3; i < d.length; i += 4) if (d[i] > 0) return true;
      return false;
    });
    expect(ink).toBe(false);
  });
});
