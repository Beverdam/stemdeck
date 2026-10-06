// The track header: each lane's row in the mixer column (mixer.js
// renderMixerRow, capture/takeLanes.js buildRow), in muted Chromium on the
// real backend.
//
// The controls were made large enough to read from across a room (a practice
// screen seen from the drum stool), without making a row taller or the
// 300px column wider: they sit on two lines beside the name, and the EQ tab
// moved from the waveform lane into the header. These are measurements of
// that, at the three window sizes the change was designed for:
//
// 1. K, M, S, download, arm, the track menu, the input picker and the EQ tab
//    are at least 28px tall, their labels 13px bold; the name 15px.
// 2. Nothing leaves its row or the column, nothing overlaps, no label is
//    cut; rows keep --lane-h and the column keeps --daw-col-w.
// 3. Rows and waveform lanes stay aligned within 1px (names within 2px of
//    their waveform's centre line), with a take folder and an EQ panel open.
// 4. The longest stem names of every language fit in two lines.

import { test, expect } from "@playwright/test";
import { openStudio, JOB_ID } from "./helpers.mjs";
import { removeTracks } from "./recording-helpers.mjs";

test.use({
  launchOptions: {
    args: [
      "--mute-audio",
      "--autoplay-policy=no-user-gesture-required",
      "--use-fake-device-for-media-stream",
      "--use-fake-ui-for-media-stream",
    ],
  },
});

test.afterEach(async ({ request }) => removeTracks(request));

const VIEWPORTS = [[1280, 720], [1600, 1000], [1920, 1080]];

/** Page errors and console errors, minus the browser's generic network lines. */
function watchErrors(page) {
  const errors = [];
  page.on("pageerror", (e) => errors.push(String(e)));
  page.on("console", (m) => {
    if (m.type() !== "error") return;
    if (/^Failed to load resource/.test(m.text())) return;
    errors.push(m.text());
  });
  return errors;
}

/** A recording track with two takes: its take folder opens by default. */
async function addTrackWithTakes(request) {
  const r = await request.post(`/api/jobs/${JOB_ID}/tracks`, { data: {} });
  const trackId = (await r.json()).id;
  for (let k = 0; k < 2; k++) {
    const t = await request.post(`/api/jobs/${JOB_ID}/takes`, { data: { track_id: trackId } });
    const takeId = (await t.json()).take_id;
    const buf = Buffer.alloc(48000 * 4);
    for (let i = 0; i < 48000; i++) buf.writeFloatLE(0.3 * Math.sin((2 * Math.PI * 330 * i) / 48000), i * 4);
    await request.put(`/api/jobs/${JOB_ID}/takes/${takeId}/parts/audio?seq=0`, { data: buf, headers: { "content-type": "application/octet-stream" } });
    const fin = await request.post(`/api/jobs/${JOB_ID}/takes/${takeId}/finish`, {
      data: { v: 1, timeline: { first_sample_song_sec: 0.5, tempo: 1.0 }, latency: { round_trip_ms: 0, source: "estimated", user_nudge_ms: 0 }, capture: { rate: 48000, channels: 1, device_label: "E2E tone" } },
    });
    expect(fin.status()).toBe(200);
  }
  return trackId;
}

/** Every visible lane header, with the box, font and overflow of each control. */
async function headers(page) {
  return page.evaluate(() => {
    const CONTROLS = {
      eq: ".eq-tab",
      keyDown: ".lane-key-step.down",
      key: ".lane-key-value",
      keyUp: ".lane-key-step.up",
      mute: ".mute",
      solo: ".solo",
      dl: ".lane-dl:not(.track-dl-off)",
      arm: ".track-arm",
      menu: ".take-menu-btn",
      input: ".track-input",
      fader: ".mx-fader-input",
      val: ".mx-val",
      name: ".lane-name-vu .mx-name",
      folder: ".take-folder-toggle",
    };
    const box = (e) => { const b = e.getBoundingClientRect(); return { l: b.left, t: b.top, r: b.right, b: b.bottom, w: b.width, h: b.height }; };
    const col = document.querySelector(".daw-stems-panel");
    const app = document.querySelector(".app");
    const rows = [...document.querySelectorAll(".mixer-column .lane-header[data-stem]")]
      .filter((e) => !e.classList.contains("hidden") && e.getBoundingClientRect().height > 0)
      .map((row) => {
        const controls = {};
        for (const [k, sel] of Object.entries(CONTROLS)) {
          const e = row.querySelector(sel);
          if (!e || e.getClientRects().length === 0) continue;
          const cs = getComputedStyle(e);
          if (cs.visibility === "hidden") continue;
          controls[k] = {
            ...box(e),
            font: parseFloat(cs.fontSize),
            weight: Number(cs.fontWeight),
            lineH: parseFloat(cs.lineHeight) || parseFloat(cs.fontSize) * 1.2,
            cut: e.scrollWidth > e.clientWidth + 1,
          };
        }
        const svg = row.querySelector(".lane-dl svg");
        return { stem: row.dataset.stem, track: !!row.dataset.take, row: box(row), controls, dlIcon: svg ? box(svg).w : 0 };
      });
    return {
      rows,
      col: box(col),
      colVar: parseFloat(getComputedStyle(document.documentElement).getPropertyValue("--daw-col-w")),
      laneH: parseFloat(getComputedStyle(app).getPropertyValue("--lane-h")),
    };
  });
}

/** Every visible row of both columns, top to bottom; names against their waveform. */
async function stack(page) {
  return page.evaluate(() => {
    const read = (sel) => [...document.querySelectorAll(sel)]
      .filter((e) => !e.classList.contains("hidden") && e.getBoundingClientRect().height > 0)
      .sort((a, b) => a.getBoundingClientRect().top - b.getBoundingClientRect().top);
    const mix = read(".mixer-column .lane-header");
    const wave = read(".stem-waveform-layer > .stem-waveform-row");
    const mid = (e) => { const b = e.getBoundingClientRect(); return b.top + b.height / 2; };
    return {
      mix: mix.map((e) => { const b = e.getBoundingClientRect(); const n = e.dataset.stem ? e.querySelector(".lane-name-vu .mx-name") : null; return { top: b.top, h: b.height, name: n ? mid(n) : null }; }),
      wave: wave.map((e) => { const b = e.getBoundingClientRect(); return { top: b.top, h: b.height, mid: b.top + b.height / 2 }; }),
    };
  });
}

function expectAligned(s, label) {
  expect(s.mix.length, `${label}: rows`).toBe(s.wave.length);
  let worstRow = 0;
  let worstName = 0;
  s.mix.forEach((m, i) => {
    worstRow = Math.max(worstRow, Math.abs(m.top - s.wave[i].top), Math.abs(m.h - s.wave[i].h));
    if (m.name !== null) worstName = Math.max(worstName, Math.abs(m.name - s.wave[i].mid));
  });
  expect(worstRow, `${label}: worst row drift ${worstRow.toFixed(2)} px`).toBeLessThanOrEqual(1);
  expect(worstName, `${label}: worst name drift ${worstName.toFixed(2)} px`).toBeLessThanOrEqual(2);
}

/** Sizes, containment, overlap and cut labels of every header. */
function expectHeaders(h, label) {
  expect(h.col.w, `${label}: column width`).toBeCloseTo(h.colVar, 0);
  const sized = ["eq", "key", "mute", "solo", "dl", "arm", "menu", "input"];
  const labelled = ["eq", "key", "mute", "solo", "val"];
  for (const r of h.rows) {
    const at = `${label}, ${r.stem}`;
    expect(Math.abs(r.row.h - h.laneH), `${at}: row height ${r.row.h} against --lane-h ${h.laneH}`).toBeLessThanOrEqual(1);
    const c = r.controls;
    for (const k of sized) {
      if (!c[k]) continue;
      expect(c[k].h, `${at}: ${k} height`).toBeGreaterThanOrEqual(28);
    }
    for (const k of ["key", "mute", "solo", "dl", "arm", "menu"]) {
      if (c[k]) expect(c[k].w, `${at}: ${k} width`).toBeGreaterThanOrEqual(28);
    }
    if (c.eq) expect(c.eq.w, `${at}: EQ tab width`).toBeGreaterThanOrEqual(44);
    for (const k of ["keyDown", "keyUp"]) {
      if (c[k]) {
        expect(c[k].h, `${at}: ${k} height`).toBeGreaterThanOrEqual(28);
        expect(c[k].w, `${at}: ${k} width`).toBeGreaterThanOrEqual(18);
      }
    }
    for (const k of labelled) {
      if (!c[k]) continue;
      expect(c[k].font, `${at}: ${k} font`).toBeGreaterThanOrEqual(13);
      expect(c[k].weight, `${at}: ${k} weight`).toBeGreaterThanOrEqual(700);
      expect(c[k].cut, `${at}: ${k} label cut`).toBe(false);
    }
    if (c.input) expect(c.input.font, `${at}: input font`).toBeGreaterThanOrEqual(13);
    expect(c.name.font, `${at}: name font`).toBeGreaterThanOrEqual(15);
    expect(c.name.weight, `${at}: name weight`).toBeGreaterThanOrEqual(600);
    // Two lines at most: a long name wraps once, then ends in an ellipsis.
    expect(c.name.h, `${at}: name lines`).toBeLessThanOrEqual(2 * c.name.lineH + 1);
    if (c.dl) expect(r.dlIcon, `${at}: download icon`).toBeGreaterThanOrEqual(16);
    if (c.fader) expect(c.fader.w, `${at}: fader length`).toBeGreaterThanOrEqual(60);
    // Inside the row and the column.
    for (const [k, b] of Object.entries(c)) {
      expect(b.t, `${at}: ${k} above its row`).toBeGreaterThanOrEqual(r.row.t - 0.5);
      expect(b.b, `${at}: ${k} below its row`).toBeLessThanOrEqual(r.row.b + 0.5);
      expect(b.l, `${at}: ${k} left of the column`).toBeGreaterThanOrEqual(h.col.l - 0.5);
      expect(b.r, `${at}: ${k} right of the column`).toBeLessThanOrEqual(h.col.r + 0.5);
    }
    // Nothing on top of anything else.
    const keys = Object.keys(c);
    for (let i = 0; i < keys.length; i++) {
      for (let j = i + 1; j < keys.length; j++) {
        const a = c[keys[i]];
        const b = c[keys[j]];
        const ox = Math.min(a.r, b.r) - Math.max(a.l, b.l);
        const oy = Math.min(a.b, b.b) - Math.max(a.t, b.t);
        expect(ox > 0.5 && oy > 0.5, `${at}: ${keys[i]} overlaps ${keys[j]}`).toBe(false);
      }
    }
  }
}

for (const [w, hgt] of VIEWPORTS) {
  test(`the header's controls are large, fit, and stay aligned at ${w}x${hgt}`, async ({ page, request }) => {
    const errors = watchErrors(page);
    await page.setViewportSize({ width: w, height: hgt });
    const trackId = await addTrackWithTakes(request);
    await openStudio(page);
    await expect(page.locator(`.take-folder-row[data-folder-of="${trackId}"]`)).toHaveCount(2, { timeout: 20000 });
    await expect(page.locator(`.eq-tab[data-eq-lane="${trackId}"]`)).toBeVisible();
    await page.waitForTimeout(300);

    const h = await headers(page);
    // The four stems, the track, and the original if shown.
    expect(h.rows.filter((r) => r.track)).toHaveLength(1);
    expect(h.rows.length).toBeGreaterThanOrEqual(5);
    for (const r of h.rows) expect(r.controls.eq, `${r.stem}: EQ tab`).toBeTruthy();
    expectHeaders(h, `${w}x${hgt}`);
    expectAligned(await stack(page), `${w}x${hgt}, take folder open`);

    // With an EQ panel open under a stem and under the track.
    await page.locator('.eq-tab[data-eq-lane="drums"]').click();
    await page.locator(`.eq-tab[data-eq-lane="${trackId}"]`).click();
    await expect(page.locator(".eq-panel-lane")).toHaveCount(2);
    await page.waitForTimeout(300);
    expectAligned(await stack(page), `${w}x${hgt}, EQ panels open`);
    expectHeaders(await headers(page), `${w}x${hgt}, EQ panels open`);
    await page.locator('.eq-tab[data-eq-lane="drums"]').click();
    await page.locator(`.eq-tab[data-eq-lane="${trackId}"]`).click();
    await expect(page.locator(".eq-panel-lane")).toHaveCount(0);
    expect(errors).toEqual([]);
  });
}

test("the longest stem names of every language fit the header", async ({ page, request }) => {
  test.setTimeout(90_000);
  const errors = watchErrors(page);
  await page.setViewportSize({ width: 1280, height: 720 });
  await addTrackWithTakes(request);
  await openStudio(page);
  await expect(page.locator(".mixer-column .track-lane")).toHaveCount(1, { timeout: 20000 });
  const codes = await page.evaluate(async () => (await import("/js/i18n.js")).LANGUAGES.map((l) => l.code));
  expect(codes.length).toBeGreaterThanOrEqual(10);
  for (const code of codes) {
    // Each visible header gets one of the language's longest stem names, the
    // longest first (the fixture has four stems; a split song shows the
    // lead and backing vocal names, the longest there are).
    await page.evaluate(async (c) => {
      const i18n = await import("/js/i18n.js");
      await i18n.setLanguage(c);
      const names = ["original", "vocals", "lead_vocals", "backing_vocals", "drums", "bass", "guitar", "piano", "other"]
        .map((s) => i18n.t(`stem.${s}`))
        .sort((a, b) => b.length - a.length);
      const els = [...document.querySelectorAll(".mixer-column .lane-header[data-stem]:not(.hidden) .lane-name-vu .mx-name")];
      els.forEach((e, i) => { e.textContent = names[i % names.length]; });
    }, code);
    await page.waitForTimeout(50);
    expectHeaders(await headers(page), `language ${code}`);
  }
  expect(errors).toEqual([]);
});
