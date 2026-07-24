// Small helpers for bounding target-controlled text before it can bloat
// artifacts, memory, or model prompts.

export function truncateWithMarker(
  text: string,
  maxChars: number,
  label = "TRUNCATED",
): string {
  if (text.length <= maxChars) {
    return text;
  }

  return `${text.slice(0, maxChars)}\n[${label}: original ${text.length} chars, kept ${maxChars}]`;
}

export function appendBoundedText(
  current: string,
  chunk: string,
  maxChars: number,
  label = "TRUNCATED",
): string {
  if (current.includes(`[${label}:`)) {
    return current;
  }

  return truncateWithMarker(`${current}${chunk}`, maxChars, label);
}
