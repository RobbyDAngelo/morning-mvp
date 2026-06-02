#!/usr/bin/env node
// Renders the morning-brief markdown to a print-friendly HTML file and opens
// it in the default browser. Inlines all CSS so the file is portable.
//
// Usage: render-print.mjs path/to/brief.md
//
// Why inline CSS: the file should print correctly even if shared by airdrop or
// emailed to a phone. No external font, no CDN.

import { readFile, writeFile } from "node:fs/promises";
import { resolve, basename } from "node:path";
import { openExternal } from "./lib/cli.mjs";

const input = process.argv[2];
if (!input) {
  process.stderr.write("usage: render-print.mjs path/to/brief.md\n");
  process.exit(2);
}

const md = await readFile(input, "utf8");

// Hand-rolled, tiny markdown to HTML. Avoids a dep just to render six common
// constructs (headings, bullets, bold, italic, code, blank lines).
function mdToHtml(src) {
  const lines = src.split("\n");
  const out = [];
  let inList = false;

  const inline = (s) =>
    s
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/`([^`]+)`/g, "<code>$1</code>")
      .replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>")
      .replace(/(?<!\*)\*(?!\*)([^*]+)\*(?!\*)/g, "<em>$1</em>");

  const closeList = () => {
    if (inList) {
      out.push("</ul>");
      inList = false;
    }
  };

  for (const raw of lines) {
    const line = raw.replace(/\s+$/, "");
    if (line === "") {
      closeList();
      out.push("");
      continue;
    }
    if (/^#{1,6}\s/.test(line)) {
      closeList();
      const m = line.match(/^(#{1,6})\s+(.*)$/);
      const level = m[1].length;
      out.push(`<h${level}>${inline(m[2])}</h${level}>`);
      continue;
    }
    if (/^---\s*$/.test(line)) {
      closeList();
      out.push("<hr/>");
      continue;
    }
    if (/^(\s*[-*]\s|\s*\d+\.\s)/.test(line)) {
      if (!inList) {
        out.push("<ul>");
        inList = true;
      }
      const body = line.replace(/^(\s*[-*]\s|\s*\d+\.\s)/, "");
      out.push(`<li>${inline(body)}</li>`);
      continue;
    }
    closeList();
    out.push(`<p>${inline(line)}</p>`);
  }
  closeList();
  return out.join("\n");
}

const body = mdToHtml(md);
const title = basename(input).replace(/\.md$/, "");

const html = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8" />
<title>${title}</title>
<style>
  :root {
    --ink: #111;
    --rule: #ccc;
    --muted: #555;
    --accent: #b91c1c;
  }
  * { box-sizing: border-box; }
  html, body {
    margin: 0;
    padding: 0;
    background: #fff;
    color: var(--ink);
    font-family: -apple-system, BlinkMacSystemFont, "Helvetica Neue", Helvetica, Arial, sans-serif;
    font-size: 11pt;
    line-height: 1.35;
  }
  main {
    max-width: 7.5in;
    margin: 0 auto;
    padding: 0.4in 0.5in;
  }
  h1 {
    font-size: 18pt;
    margin: 0 0 0.15rem 0;
    letter-spacing: -0.01em;
    color: var(--ink);
  }
  h1 + p { margin: 0 0 0.5rem 0; color: var(--muted); font-size: 9.5pt; }
  h2 {
    font-size: 12pt;
    margin: 0.7rem 0 0.25rem 0;
    padding-bottom: 2px;
    border-bottom: 1px solid var(--rule);
    text-transform: uppercase;
    letter-spacing: 0.08em;
    color: var(--accent);
  }
  h3 { font-size: 10.5pt; margin: 0.4rem 0 0.2rem 0; }
  p { margin: 0 0 0.3rem 0; }
  ul { margin: 0 0 0.4rem 1.1rem; padding: 0; }
  li { margin: 0 0 0.2rem 0; }
  code {
    background: #f3f3f3;
    padding: 0 3px;
    border-radius: 2px;
    font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
    font-size: 9.5pt;
  }
  strong { color: #000; }
  hr {
    border: 0;
    border-top: 1px solid var(--rule);
    margin: 0.5rem 0;
  }
  @media print {
    @page { size: letter; margin: 0.45in; }
    main { max-width: none; padding: 0; }
    body { font-size: 10.5pt; }
    h1 { font-size: 16pt; }
    h2 { font-size: 11pt; }
  }
</style>
</head>
<body>
<main>
${body}
</main>
</body>
</html>
`;

const outPath = input.replace(/\.md$/, ".html");
await writeFile(outPath, html);

// Open in the default browser (cross-platform via lib/cli.mjs, never crashes
// if no launcher exists). The HTML is already written; on failure we tell the
// user the path so they can open it manually.
openExternal(outPath, {
  onError: (err) =>
    process.stderr.write(
      `[render-print] could not auto-open the browser (${err.message}). ` +
        `Open this file manually: ${outPath}\n`,
    ),
});
process.stdout.write(`${outPath}\n`);
