// lib/ai/json-parse.ts
// Server-side only. PURE — no DB, no logging, no Gemini.
//
// Robust, OBSERVABLE parsing of Gemini's JSON output. Gemini (especially in
// Hebrew) intermittently emits JSON that is structurally almost-right but invalid:
//   - the shekel abbreviation ש"ח and quoted words put UNESCAPED double-quotes
//     INSIDE string values → JSON.parse aborts mid-string (the live BUG-001:
//     "reply": "...תספורת (80 ש"ח)...");
//   - ```json code fences, or stray prose before/after the object;
//   - raw newlines/tabs inside string values.
//
// We recover where the data is genuinely present, NEVER fabricate, and on a real
// failure return a typed reason for diagnostics. There are NO hardcoded per-message
// fixes — recovery is driven by JSON STRUCTURE (a `"` is content unless it sits in
// a delimiter position), so it generalizes to any unescaped quote, not just ש"ח.

export type RecoveryMethod = "clean" | "fence-stripped" | "sliced" | "quote-repaired";
export type ParseFailureReason =
  | "empty"
  | "no_json_object"
  | "truncated_json"
  | "invalid_escape_or_quote"
  | "unknown_parse_failure";

export type AiJsonParseResult =
  | { ok: true; data: unknown; normalizedRaw: string; recovered: RecoveryMethod }
  | { ok: false; reason: ParseFailureReason; error: string; rawPreview: string };

const PREVIEW = 4000;

export function parseAiJsonResponse(raw: string): AiJsonParseResult {
  const original = raw ?? "";
  if (!original.trim()) return { ok: false, reason: "empty", error: "empty response", rawPreview: "" };

  const { text: deFenced, hadFence } = stripCodeFence(original);

  // 1) Clean parse — the common, healthy case.
  const direct = tryParse(deFenced.trim());
  if (direct.ok) {
    return { ok: true, data: direct.value, normalizedRaw: deFenced.trim(), recovered: hadFence ? "fence-stripped" : "clean" };
  }

  // 2) Slice the first top-level object (drops any prose before/after it).
  const start = deFenced.indexOf("{");
  const end = deFenced.lastIndexOf("}");
  if (start === -1 || end === -1 || end < start) {
    return { ok: false, reason: "no_json_object", error: direct.error, rawPreview: preview(original) };
  }
  const sliced = deFenced.slice(start, end + 1);
  const wasSliced = sliced.trim() !== deFenced.trim();

  const slicedParse = tryParse(sliced);
  if (slicedParse.ok) {
    return {
      ok: true, data: slicedParse.value, normalizedRaw: sliced,
      recovered: wasSliced ? "sliced" : hadFence ? "fence-stripped" : "clean",
    };
  }

  // 3) Repair unescaped inner quotes / raw control chars, then re-parse.
  const repaired = repairJsonStrings(sliced);
  if (repaired !== sliced) {
    const repairedParse = tryParse(repaired);
    if (repairedParse.ok) {
      return { ok: true, data: repairedParse.value, normalizedRaw: repaired, recovered: "quote-repaired" };
    }
  }

  // 4) Genuinely unrecoverable — classify for diagnostics (never fabricate).
  return { ok: false, reason: classify(sliced, repaired), error: slicedParse.error, rawPreview: preview(original) };
}

function tryParse(s: string): { ok: true; value: unknown } | { ok: false; error: string } {
  try {
    return { ok: true, value: JSON.parse(s) };
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : String(e) };
  }
}

function stripCodeFence(s: string): { text: string; hadFence: boolean } {
  const t = s.trim();
  const fenced = t.match(/^```(?:json)?\s*([\s\S]*?)\s*```$/i);
  if (fenced) return { text: fenced[1], hadFence: true };
  // Opening fence with no closing one (e.g. truncated output).
  const open = t.match(/^```(?:json)?\s*([\s\S]*)$/i);
  if (open) return { text: open[1], hadFence: true };
  return { text: s, hadFence: false };
}

/**
 * Escapes double-quotes that appear as STRING CONTENT (not delimiters) plus raw
 * control chars inside strings. A `"` is treated as a closing delimiter only when
 * the next non-space char is structural (`:` `,` `}` `]`) or end-of-input;
 * otherwise it is content and is escaped. Standard structure-aware repair — general,
 * not tied to any specific word. Idempotent on already-valid JSON.
 */
export function repairJsonStrings(s: string): string {
  let out = "";
  let inStr = false;
  for (let i = 0; i < s.length; i++) {
    const ch = s[i];
    if (!inStr) {
      out += ch;
      if (ch === '"') inStr = true;
      continue;
    }
    // Inside a string value/key:
    if (ch === "\\") {
      out += ch + (s[i + 1] ?? ""); // keep an existing escape sequence verbatim
      i++;
      continue;
    }
    if (ch === '"') {
      const next = nextNonSpace(s, i + 1);
      if (next === "" || next === ":" || next === "," || next === "}" || next === "]") {
        inStr = false;
        out += ch; // genuine closing delimiter
      } else {
        out += '\\"'; // content quote (e.g. ש"ח) → escape it
      }
      continue;
    }
    if (ch === "\n") { out += "\\n"; continue; }
    if (ch === "\r") { out += "\\r"; continue; }
    if (ch === "\t") { out += "\\t"; continue; }
    out += ch;
  }
  return out;
}

function nextNonSpace(s: string, from: number): string {
  for (let i = from; i < s.length; i++) {
    if (!/\s/.test(s[i])) return s[i];
  }
  return "";
}

function classify(candidate: string, repaired: string): ParseFailureReason {
  const opens = (candidate.match(/{/g) ?? []).length;
  const closes = (candidate.match(/}/g) ?? []).length;
  if (opens > closes) return "truncated_json";
  if (repaired !== candidate) return "invalid_escape_or_quote"; // repair touched it but still failed
  return "unknown_parse_failure";
}

function preview(s: string): string {
  return s.length > PREVIEW ? `${s.slice(0, PREVIEW)}…(+${s.length - PREVIEW} more)` : s;
}
