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

  test("Connect YouTube says it is coming soon", async ({ page }) => {
    await openStudio(page);
    await openStreamer(page);
    await sm(page, ".sm-yt-connect").click();
    await expect(page.locator("#streamerNote")).toBeVisible();
    await expect(page.locator("#streamerNote")).toHaveText("YouTube upload is coming soon.");
  });
});
