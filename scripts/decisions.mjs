// Classify each waiting item as a "decision" (Robby must choose) or a "response"
// (Robby must reply with info). Decisions deserve a different kind of attention
// (focused thinking time) than responses (quick typing). Splitting them in the
// brief lets Robby allocate the right kind of attention to each.
//
// Heuristic signal set. Conservative: if uncertain, classify as response. A
// false "decision" classification is more annoying than a false "response."

const DECISION_PATTERNS = [
  // Explicit decision language
  /\b(?:should\s+(?:we|i)|do\s+(?:we|i)\s+want)\b/i,
  /\bdecision\s+(?:needed|required)\b/i,
  /\bapproval\s+(?:needed|required)\b/i,
  /\bplease\s+(?:approve|decide|choose|confirm)\b/i,
  /\byour\s+call\b/i,
  /\bsign\s+off\b/i,
  /\b(?:approve|reject|accept|decline)\?\b/i,
  // Options framing
  /\b(?:option\s+a|option\s+1|two options|three options)\b/i,
  /\b(?:either|or)\s+(?:we|i|you)\b.*\b(?:or|or do)\b/i,
  // Yes/no questions about commitments
  /\bare\s+you\s+(?:in|ok with|good with)\b/i,
  /\bcan\s+we\s+(?:move forward|proceed|finalize)\b/i,
  /\bshall\s+(?:we|i)\b/i,
];

const RESPONSE_HINTS = [
  // These tilt strongly toward "response" if no decision signal is present
  /\bquick\s+question\b/i,
  /\bjust\s+(?:checking|wondering|wanted to)\b/i,
  /\bcan\s+you\s+(?:send|share|forward|update)\b/i,
  /\b(?:thoughts|update|status)\?/i,
];

export function classifyDecisionOrResponse(msg) {
  const subject = (msg.subject ?? "").trim();
  const body = msg.preview ?? msg.body ?? "";
  const haystack = `${subject}\n${body}`;

  let decisionHits = 0;
  for (const re of DECISION_PATTERNS) {
    if (re.test(haystack)) decisionHits += 1;
  }
  let responseHits = 0;
  for (const re of RESPONSE_HINTS) {
    if (re.test(haystack)) responseHits += 1;
  }

  // Decisions need a real signal. A single decision-pattern hit qualifies.
  if (decisionHits >= 1) {
    // Unless the message is also flagged as quick / status-update style and
    // has more response hints, in which case it's borderline; default to
    // decision since the user asked for a fork.
    return { kind: "decision", confidence: decisionHits >= 2 ? "high" : "medium" };
  }
  if (responseHits >= 1) return { kind: "response", confidence: "high" };
  // No strong signal either way: treat as response (the safer / more frequent class).
  return { kind: "response", confidence: "low" };
}

export function tagItemsWithKind(items) {
  return items.map((item) => {
    const c = classifyDecisionOrResponse(item);
    return { ...item, decision_or_response: c.kind, classification_confidence: c.confidence };
  });
}
