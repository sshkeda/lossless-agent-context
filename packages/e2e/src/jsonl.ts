export function parseJsonlLines(text: string): unknown[] {
  return text
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => JSON.parse(line));
}

export function parseJsonlObjectLines(text: string): Array<Record<string, unknown>> {
  return parseJsonlLines(text).map((line, index) => {
    if (!line || typeof line !== "object" || Array.isArray(line)) {
      throw new Error(`Expected JSON object at JSONL line ${index + 1}`);
    }
    return line as Record<string, unknown>;
  });
}
