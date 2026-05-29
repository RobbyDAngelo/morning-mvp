// Tests for Google Calendar shape support in scripts/save-calendar-events.mjs.
// The Fantastical / AppleScript paths are already covered by
// save-calendar-events.test.mjs; this file covers the new google-calendar
// shape added in phase 3.

import { test } from "node:test";
import assert from "node:assert/strict";
import { writeFile, readFile, mkdtemp, rm } from "node:fs/promises";
import { spawn } from "node:child_process";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

const __dirname = dirname(fileURLToPath(import.meta.url));
const SCRIPT = resolve(__dirname, "..", "scripts", "save-calendar-events.mjs");

function runSave(args) {
  return new Promise((resolveP) => {
    const child = spawn("node", [SCRIPT, ...args], { stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (c) => (stdout += c.toString("utf8")));
    child.stderr.on("data", (c) => (stderr += c.toString("utf8")));
    child.on("close", (code) => resolveP({ code, stdout, stderr }));
  });
}

async function setupTmp() {
  const dir = await mkdtemp(join(tmpdir(), "mmvp-gcal-"));
  const rawPath = join(dir, "raw-test.json");
  await writeFile(rawPath, JSON.stringify({ generated_at: "2026-05-01T08:00:00Z" }));
  return { dir, rawPath };
}

test("GCAL-1: normalizes Google Calendar event shape", async () => {
  const { dir, rawPath } = await setupTmp();
  try {
    const payload = {
      items: [
        {
          id: "gcal-evt-1",
          summary: "Partner sync",
          status: "confirmed",
          htmlLink: "https://calendar.google.com/event?eid=abc",
          start: { dateTime: "2026-05-12T17:00:00Z" },
          end: { dateTime: "2026-05-12T18:00:00Z" },
          location: "Zoom",
          description: "Weekly check-in. Agenda: revenue, ops, hiring.",
          attendees: [
            { email: "user@example.com", responseStatus: "accepted" },
            { email: "partner@example.com", responseStatus: "accepted" },
          ],
          organizer: { email: "user@example.com" },
        },
      ],
    };
    const pp = join(dir, "gcal.json");
    await writeFile(pp, JSON.stringify(payload));
    const res = await runSave(["--raw", rawPath, "--file", pp]);
    assert.equal(res.code, 0, `stderr: ${res.stderr}`);
    const raw = JSON.parse(await readFile(rawPath, "utf8"));
    assert.equal(raw.calendar.events.length, 1);
    const ev = raw.calendar.events[0];
    assert.equal(ev.source, "google-calendar");
    assert.equal(ev.title, "Partner sync");
    assert.equal(ev.start, "2026-05-12T17:00:00Z");
    assert.equal(ev.end, "2026-05-12T18:00:00Z");
    assert.equal(ev.location, "Zoom");
    assert.deepEqual(ev.attendees, ["user@example.com", "partner@example.com"]);
    assert.match(ev.notes_preview, /Agenda/);
    assert.equal(ev.google_id, "gcal-evt-1");
    assert.equal(ev.html_link, "https://calendar.google.com/event?eid=abc");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("GCAL-2: all-day events use start.date when dateTime is absent", async () => {
  const { dir, rawPath } = await setupTmp();
  try {
    const payload = {
      items: [
        {
          id: "ad-1",
          summary: "Holiday",
          start: { date: "2026-05-25" },
          end: { date: "2026-05-26" },
        },
      ],
    };
    const pp = join(dir, "ad.json");
    await writeFile(pp, JSON.stringify(payload));
    await runSave(["--raw", rawPath, "--file", pp]);
    const raw = JSON.parse(await readFile(rawPath, "utf8"));
    const ev = raw.calendar.events[0];
    assert.equal(ev.start, "2026-05-25");
    assert.equal(ev.end, "2026-05-26");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("GCAL-3: declined events are dropped", async () => {
  const { dir, rawPath } = await setupTmp();
  try {
    const payload = {
      items: [
        {
          id: "ok",
          summary: "Live event",
          status: "confirmed",
          start: { dateTime: "2026-05-12T17:00:00Z" },
          end: { dateTime: "2026-05-12T18:00:00Z" },
        },
        {
          id: "skip",
          summary: "Declined event",
          status: "declined",
          start: { dateTime: "2026-05-12T19:00:00Z" },
          end: { dateTime: "2026-05-12T20:00:00Z" },
        },
      ],
    };
    const pp = join(dir, "d.json");
    await writeFile(pp, JSON.stringify(payload));
    await runSave(["--raw", rawPath, "--file", pp]);
    const raw = JSON.parse(await readFile(rawPath, "utf8"));
    assert.equal(raw.calendar.events.length, 1);
    assert.equal(raw.calendar.events[0].title, "Live event");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("GCAL-4: attendees as bare-string-array passes through", async () => {
  const { dir, rawPath } = await setupTmp();
  try {
    const payload = {
      items: [
        {
          id: "se",
          summary: "Strings",
          start: { dateTime: "2026-05-12T17:00:00Z" },
          end: { dateTime: "2026-05-12T18:00:00Z" },
          attendees: ["a@x", "b@x"],
        },
      ],
    };
    const pp = join(dir, "sa.json");
    await writeFile(pp, JSON.stringify(payload));
    await runSave(["--raw", rawPath, "--file", pp]);
    const raw = JSON.parse(await readFile(rawPath, "utf8"));
    assert.deepEqual(raw.calendar.events[0].attendees, ["a@x", "b@x"]);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("GCAL-5: events without summary are dropped", async () => {
  const { dir, rawPath } = await setupTmp();
  try {
    const payload = {
      items: [
        {
          id: "no-sum",
          start: { dateTime: "2026-05-12T17:00:00Z" },
          end: { dateTime: "2026-05-12T18:00:00Z" },
        },
      ],
    };
    const pp = join(dir, "ns.json");
    await writeFile(pp, JSON.stringify(payload));
    await runSave(["--raw", rawPath, "--file", pp]);
    const raw = JSON.parse(await readFile(rawPath, "utf8"));
    assert.equal(raw.calendar.events.length, 0);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
