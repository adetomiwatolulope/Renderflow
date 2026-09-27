/**
 * Reading a numeric setting from the environment, kept separate from the settings
 * themselves so the parsing rules are testable without mutating process.env at
 * import time.
 */

export function readPositiveInteger(
  name: string,
  fallback: number,
  env: Readonly<Record<string, string | undefined>>,
): number {
  const raw = env[name];
  if (raw === undefined || raw.trim().length === 0) {
    return fallback;
  }

  const parsed = Number(raw);
  if (!Number.isInteger(parsed) || parsed <= 0) {
    throw new Error(`${name} must be a positive integer, received "${raw}"`);
  }

  return parsed;
}
