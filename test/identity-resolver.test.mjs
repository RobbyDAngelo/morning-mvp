// Tests for scripts/identity-resolver.mjs. Covers H1 name extraction,
// email scanning + gmail-preference, hard rules parsing, role inference,
// persona hints, missing-file handling, and graceful fallback.

import { test } from "node:test";
import assert from "node:assert/strict";
import { writeFile, mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { resolveIdentity, writeIdentity, loadResolvedIdentity } from "../scripts/identity-resolver.mjs";

async function setupTmp(files) {
  const dir = await mkdtemp(join(tmpdir(), "mmvp-id-"));
  const out = {};
  for (const [name, content] of Object.entries(files)) {
    const p = join(dir, name);
    await writeFile(p, content);
    out[name] = p;
  }
  out.__dir = dir;
  return out;
}

test("IR-1: extracts name from first H1 of CLAUDE.md", async () => {
  const { __dir, "CLAUDE.md": cm } = await setupTmp({
    "CLAUDE.md": "# Jane Doe\n\nFounder of Acme.\n",
  });
  try {
    const id = await resolveIdentity({ claudeMdPath: cm, memoryMdPath: "/nonexistent" });
    assert.equal(id.name, "Jane Doe");
    assert.equal(id.first_name, "Jane");
  } finally {
    await rm(__dir, { recursive: true, force: true });
  }
});

test("IR-2: extracts role from 'Founder of X' tagline", async () => {
  const { __dir, "CLAUDE.md": cm } = await setupTmp({
    "CLAUDE.md": "# Sam Smith\n\nFounder of Cool Startup.\n",
  });
  try {
    const id = await resolveIdentity({ claudeMdPath: cm, memoryMdPath: "/nonexistent" });
    assert.equal(id.role, "Founder of Cool Startup");
  } finally {
    await rm(__dir, { recursive: true, force: true });
  }
});

test("IR-3: extracts email and prefers non-gmail address", async () => {
  const { __dir, "CLAUDE.md": cm } = await setupTmp({
    "CLAUDE.md": "# X\n\nReach me at backup@gmail.com or sam@company.com.\n",
  });
  try {
    const id = await resolveIdentity({ claudeMdPath: cm, memoryMdPath: "/nonexistent" });
    assert.equal(id.email, "sam@company.com");
  } finally {
    await rm(__dir, { recursive: true, force: true });
  }
});

test("IR-4: parses Hard Rules bullet list", async () => {
  const { __dir, "CLAUDE.md": cm } = await setupTmp({
    "CLAUDE.md": [
      "# X",
      "",
      "## Hard Rules",
      "",
      "- No em dashes",
      "- Be concise",
      "- Never invent facts",
      "",
      "## Other",
    ].join("\n"),
  });
  try {
    const id = await resolveIdentity({ claudeMdPath: cm, memoryMdPath: "/nonexistent" });
    assert.equal(id.hard_rules.length, 3);
    assert.equal(id.hard_rules[0], "No em dashes");
    assert.equal(id.hard_rules[2], "Never invent facts");
  } finally {
    await rm(__dir, { recursive: true, force: true });
  }
});

test("IR-5: records missing fields when CLAUDE.md absent", async () => {
  const id = await resolveIdentity({
    claudeMdPath: "/totally/nonexistent/file.md",
    memoryMdPath: "/also/nonexistent.md",
  });
  assert.ok(id.missing.some((m) => m.includes("CLAUDE.md")));
  assert.ok(id.missing.includes("name"));
  // Email may or may not resolve via git fallback; just check it's a string.
  assert.equal(typeof id.email, "string");
});

test("IR-6: filters out placeholder emails (example.com / yourname)", async () => {
  const { __dir, "CLAUDE.md": cm } = await setupTmp({
    "CLAUDE.md": "# X\n\nemail: yourname@example.com or real@company.com\n",
  });
  try {
    const id = await resolveIdentity({ claudeMdPath: cm, memoryMdPath: "/nonexistent" });
    assert.equal(id.email, "real@company.com");
  } finally {
    await rm(__dir, { recursive: true, force: true });
  }
});

test("IR-7: writes identity.local.json to disk via writeIdentity()", async () => {
  const { __dir, "CLAUDE.md": cm } = await setupTmp({
    "CLAUDE.md": "# Tester\n\nFounder of Test Inc.\n",
  });
  try {
    const id = await resolveIdentity({ claudeMdPath: cm, memoryMdPath: "/nonexistent" });
    const outPath = join(__dir, "identity.local.json");
    const written = await writeIdentity(id, { path: outPath });
    assert.equal(written, outPath);
    const reloaded = JSON.parse(await (await import("node:fs/promises")).readFile(outPath, "utf8"));
    assert.equal(reloaded.name, "Tester");
  } finally {
    await rm(__dir, { recursive: true, force: true });
  }
});

test("IR-8: loadResolvedIdentity returns {} when no file present", async () => {
  // We can't easily fake the skill-root path the function reads from, but we
  // can assert it never throws and returns an object.
  const got = await loadResolvedIdentity();
  assert.equal(typeof got, "object");
  assert.ok(got !== null);
});

test("IR-9: extracts persona hints from Working Style section", async () => {
  const { __dir, "CLAUDE.md": cm } = await setupTmp({
    "CLAUDE.md": [
      "# X",
      "",
      "## Working Style",
      "",
      "- **Quality bar**: very high",
      "- **Style**: direct",
      "",
      "## Next",
    ].join("\n"),
  });
  try {
    const id = await resolveIdentity({ claudeMdPath: cm, memoryMdPath: "/nonexistent" });
    assert.equal(id.persona_hints.length, 2);
    assert.equal(id.persona_hints[0].key, "Quality bar");
    assert.equal(id.persona_hints[0].value, "very high");
  } finally {
    await rm(__dir, { recursive: true, force: true });
  }
});

test("IR-10: handles names with apostrophes", async () => {
  const { __dir, "CLAUDE.md": cm } = await setupTmp({
    "CLAUDE.md": "# Robby D'Angelo\n\nFounder of Undeniable Men.\n",
  });
  try {
    const id = await resolveIdentity({ claudeMdPath: cm, memoryMdPath: "/nonexistent" });
    assert.equal(id.name, "Robby D'Angelo");
    assert.equal(id.first_name, "Robby");
  } finally {
    await rm(__dir, { recursive: true, force: true });
  }
});
