// Which stem a mode leaves out of a song ("I play"), kept per song and per
// mode: the choice of one mode never changes what another shows or plays.
//
// Record key: stemdeck:stems:<jobId>:<mode>, value { v: 1, remove }. `remove`
// is one of the six Demucs stems, or "" for the whole song. Streamer Mode is
// the first (and for now only) user; Practice, Advanced and Karaoke can adopt
// it with their own mode string. Pure: no DOM, no store, testable in Node.

export const CHOICE_VERSION = 1;

/** What can be left out: "" (nothing, the whole song) and the parts a
 * musician plays. "other" is not offered: nobody plays "other". */
export const STEM_CHOICES = Object.freeze(["", "drums", "bass", "guitar", "piano", "vocals"]);

/** The six Demucs stems (app/core/config.py STEM_NAMES). */
export const BASE_STEMS = Object.freeze(["vocals", "drums", "bass", "guitar", "piano", "other"]);

const MODE_RE = /^[a-z][a-z0-9-]{0,23}$/;

/** The store key of `jobId`'s choice in `mode`. */
export function choiceKey(jobId, mode) {
  if (!jobId || !MODE_RE.test(String(mode || ""))) throw new Error("a job and a mode are required");
  return `stemdeck:stems:${jobId}:${mode}`;
}

/** A stored choice made safe: anything unknown is the whole song. */
export function parseChoice(raw) {
  let data = raw;
  if (typeof data === "string") {
    try { data = JSON.parse(data); } catch { data = null; }
  }
  const remove = data && typeof data === "object" && STEM_CHOICES.includes(data.remove) ? data.remove : "";
  return { remove };
}

export function serializeChoice(choice) {
  return { v: CHOICE_VERSION, remove: parseChoice(choice).remove };
}

/** The choices a song offers: the whole song always, and each part whose
 * stem file it has (`present`: stem names with a file). */
export function offeredChoices(present) {
  const have = new Set(present || []);
  return STEM_CHOICES.filter((c) => c === "" || have.has(c));
}

/** A choice the song can no longer offer reads as the whole song. */
export function effectiveChoice(choice, present) {
  const remove = parseChoice(choice).remove;
  return offeredChoices(present).includes(remove) ? remove : "";
}

/**
 * The lanes and playback parts a removed stem takes out: Voice is the vocals
 * stem and, after a lead/backing split, both of its halves.
 */
export function excludedNames(remove) {
  if (!remove) return new Set();
  if (remove === "vocals") return new Set(["vocals", "lead_vocals", "backing_vocals"]);
  return new Set([remove]);
}

/** Two sets hold the same names. */
export function sameNames(a, b) {
  if (a.size !== b.size) return false;
  for (const n of a) if (!b.has(n)) return false;
  return true;
}

/**
 * The take timeline's two lanes for a choice: the backing track (every base
 * stem the song has but the removed one) and the part the musician plays.
 * Returns { backing: [stem names], part: stem name or null }.
 */
export function timelineLanes(remove, present) {
  const have = new Set(present || []);
  const out = excludedNames(remove);
  return {
    backing: BASE_STEMS.filter((n) => have.has(n) && !out.has(n)),
    part: remove && have.has(remove) ? remove : null,
  };
}
