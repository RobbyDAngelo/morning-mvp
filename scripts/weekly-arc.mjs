// Weekly arc / mission tracking. The principle: every action in the morning
// brief should resolve upward to a one-sentence mission. Each week, on Monday,
// Robby declares the mission. The skill displays it under The One Thing every
// other day of the week and offers a recap on Sunday.
//
// State at data/week-state.json. Shape:
//   {
//     version: 1,
//     current: {
//       week_start: "2026-05-11",   // ISO date of Monday
//       mission: "Close TPA partner directory + ship Q2 NorthStar comp",
//       set_at: "2026-05-11T08:00:00Z"
//     },
//     history: [ {week_start, mission, set_at, ended_at, recap} ]
//   }

import { readFile, writeFile, mkdir } from "node:fs/promises";
import { existsSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const STATE_PATH = resolve(__dirname, "..", "data", "week-state.json");
const VERSION = 1;

function isoDate(d) {
  return new Date(d).toISOString().slice(0, 10);
}

// Returns the Monday on or before `d`. Used to align week boundaries.
export function mondayOf(d = new Date()) {
  const date = new Date(d);
  const dow = date.getDay(); // 0=Sunday, 1=Monday, ..., 6=Saturday
  const offset = dow === 0 ? -6 : 1 - dow;
  date.setDate(date.getDate() + offset);
  date.setHours(0, 0, 0, 0);
  return date;
}

export function dayOfWeekName(d = new Date()) {
  return ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"][d.getDay()];
}

export function isMonday(d = new Date()) {
  return d.getDay() === 1;
}

export function isSunday(d = new Date()) {
  return d.getDay() === 0;
}

export async function loadWeekState() {
  if (!existsSync(STATE_PATH)) {
    return { version: VERSION, current: null, history: [] };
  }
  try {
    const raw = JSON.parse(await readFile(STATE_PATH, "utf8"));
    if (!raw.history) raw.history = [];
    if (!raw.version) raw.version = VERSION;
    return raw;
  } catch {
    return { version: VERSION, current: null, history: [] };
  }
}

export async function saveWeekState(state) {
  await mkdir(dirname(STATE_PATH), { recursive: true });
  await writeFile(STATE_PATH, JSON.stringify(state, null, 2));
}

// Decide what action the brief workflow should take based on the day and state.
// Returns one of:
//   { action: "prompt_new_mission", reason }       - Monday with no current mission
//   { action: "rotate_and_prompt", reason }        - Monday with a different week's mission
//   { action: "display_current", mission, day_of_week, days_in }
//   { action: "offer_recap", mission, day_of_week } - Sunday with a current mission set this week
//   { action: "none", reason }                     - no mission yet, non-Monday
export function decideAction(state, now = new Date()) {
  const today = mondayOf(now);
  const currentWeek = state.current?.week_start;
  const isMon = isMonday(now);
  const isSun = isSunday(now);

  if (isMon) {
    if (!state.current || state.current.week_start !== isoDate(today)) {
      return state.current
        ? { action: "rotate_and_prompt", reason: "new week begins; archive last week's mission and set a new one" }
        : { action: "prompt_new_mission", reason: "no mission set yet" };
    }
    return {
      action: "display_current",
      mission: state.current.mission,
      day_of_week: "Monday",
      days_in: 1,
    };
  }

  if (!state.current) {
    return { action: "none", reason: "no current mission; not Monday so won't prompt" };
  }

  // Mid-week display.
  const startMs = new Date(state.current.week_start + "T00:00:00Z").getTime();
  const daysIn = Math.floor((now.getTime() - startMs) / (24 * 60 * 60 * 1000)) + 1;

  if (isSun) {
    return {
      action: "offer_recap",
      mission: state.current.mission,
      day_of_week: "Sunday",
      days_in: daysIn,
    };
  }
  return {
    action: "display_current",
    mission: state.current.mission,
    day_of_week: dayOfWeekName(now),
    days_in: daysIn,
  };
}

// Persist a newly-declared mission. Caller must have run decideAction first to
// know whether to rotate or set fresh.
export async function setMission(state, missionText, now = new Date()) {
  const weekStart = isoDate(mondayOf(now));
  if (state.current && state.current.week_start !== weekStart) {
    state.history.push({ ...state.current, ended_at: new Date().toISOString() });
  }
  state.current = {
    week_start: weekStart,
    mission: missionText.trim(),
    set_at: new Date().toISOString(),
  };
  return state;
}
