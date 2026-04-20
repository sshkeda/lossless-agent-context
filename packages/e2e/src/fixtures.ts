import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const SRC_DIR = dirname(fileURLToPath(import.meta.url));
const FIXTURES_DIR = join(SRC_DIR, "..", "fixtures");

export function readFixture(name: string): string {
  return readFileSync(join(FIXTURES_DIR, name), "utf8");
}

export function readFixtureJson<T>(name: string): T {
  return JSON.parse(readFixture(name)) as T;
}

export function readExpectedJson<T>(name: string): T {
  return JSON.parse(readFileSync(join(FIXTURES_DIR, "expected", name), "utf8")) as T;
}
