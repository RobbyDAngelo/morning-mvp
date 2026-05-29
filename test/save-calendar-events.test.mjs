import { test } from "node:test";
import assert from "node:assert/strict";
import { writeFile, readFile, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { spawn } from "node:child_process";

const __dirname = dirname(fileURLToPath(import.meta.url));
const SCRIPT = resolve(__dirname, "..", "scripts", "save-calendar-events.mjs");

function runSave(rawPath, json) {
  return new Promise((resolveP) => {
    const child = spawn(process.execPath, [SCRIPT, "--raw", rawPath, "--json", JSON.stringify(json)], {
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (c) => (stdout += c.toString("utf8")));
    child.stderr.on("data", (c) => (stderr += c.toString("utf8")));
    child.on("close", (code) => resolveP({ code, stdout, stderr }));
  });
}

test("save-calendar-events normalizes Fantastical items shape", async () => {
  const dir = await mkdtemp(join(tmpdir(), "cal-"));
  const rawPath = join(dir, "raw.json");
  await writeFile(rawPath, JSON.stringify({ mail: {}, basecamp: {} }));

  const payload = {
    items: [
      {
        title: "Toelle Sync",
        calendarId: "abc123",
        startDate: "2026-05-12T13:00:00-04:00",
        endDate: "2026-05-12T14:00:00-04:00",
        id: "evt-1",
      },
      {
        title: "Northstar LES",
        calendarId: "def456",
        startDate: "2026-05-11T09:00:00-04:00",
        endDate: "2026-05-11T09:45:00-04:00",
        location: "Zoom",
        id: "evt-2",
      },
    ],
    timezone: "America/New_York",
  };

  const r = await runSave(rawPath, payload);
  assert.equal(r.code, 0, r.stderr);

  const raw = JSON.parse(await readFile(rawPath, "utf8"));
  await rm(dir, { recursive: true, force: true });

  assert.equal(raw.calendar.source, "fantastical");
  assert.equal(raw.calendar.events.length, 2);
  assert.equal(raw.calendar.events[0].title, "Toelle Sync");
  assert.equal(raw.calendar.events[0].calendar, "abc123");
  assert.equal(raw.calendar.events[0].start, "2026-05-12T13:00:00-04:00");
  assert.equal(raw.calendar.events[0].fantastical_id, "evt-1");
});

test("save-calendar-events handles AppleScript shape", async () => {
  const dir = await mkdtemp(join(tmpdir(), "cal-"));
  const rawPath = join(dir, "raw.json");
  await writeFile(rawPath, JSON.stringify({}));

  const payload = {
    events: [
      {
        calendar: "Work",
        title: "Tech Talk",
        start: "Monday, May 11, 2026 at 9:00:00 AM",
        end: "Monday, May 11, 2026 at 10:00:00 AM",
        location: "",
        attendees: ["a@example.com"],
        notes_preview: "",
      },
    ],
  };

  const r = await runSave(rawPath, payload);
  assert.equal(r.code, 0, r.stderr);

  const raw = JSON.parse(await readFile(rawPath, "utf8"));
  await rm(dir, { recursive: true, force: true });

  assert.equal(raw.calendar.events.length, 1);
  assert.equal(raw.calendar.events[0].calendar, "Work");
  assert.equal(raw.calendar.events[0].title, "Tech Talk");
  assert.deepEqual(raw.calendar.events[0].attendees, ["a@example.com"]);
});

test("save-calendar-events drops events with empty / placeholder titles", async () => {
  const dir = await mkdtemp(join(tmpdir(), "cal-"));
  const rawPath = join(dir, "raw.json");
  await writeFile(rawPath, JSON.stringify({}));

  const payload = {
    items: [
      { title: "Real Meeting", calendarId: "x", startDate: "2026-05-11T09:00:00-04:00" },
      { title: "", calendarId: "x", startDate: "2026-05-11T10:00:00-04:00" },
      { title: "(no title)", calendarId: "x", startDate: "2026-05-11T11:00:00-04:00" },
    ],
  };

  const r = await runSave(rawPath, payload);
  assert.equal(r.code, 0, r.stderr);

  const raw = JSON.parse(await readFile(rawPath, "utf8"));
  await rm(dir, { recursive: true, force: true });

  assert.equal(raw.calendar.events.length, 1);
  assert.equal(raw.calendar.events[0].title, "Real Meeting");
});

test("save-calendar-events accepts a bare events array", async () => {
  const dir = await mkdtemp(join(tmpdir(), "cal-"));
  const rawPath = join(dir, "raw.json");
  await writeFile(rawPath, JSON.stringify({}));

  const payload = [
    { title: "Bare Array Event", calendarId: "x", startDate: "2026-05-11T09:00:00-04:00" },
  ];

  const r = await runSave(rawPath, payload);
  assert.equal(r.code, 0, r.stderr);

  const raw = JSON.parse(await readFile(rawPath, "utf8"));
  await rm(dir, { recursive: true, force: true });

  assert.equal(raw.calendar.events.length, 1);
  assert.equal(raw.calendar.events[0].title, "Bare Array Event");
});
