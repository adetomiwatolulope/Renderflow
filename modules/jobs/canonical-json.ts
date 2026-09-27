function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * Rebuilds a parsed JSON value with every object's keys in sorted order, so two
 * semantically identical payloads serialize to the same string regardless of the
 * key order the caller happened to send.
 *
 * PR-IDEM-002 requires an exact deep-equality check on the payload. Comparing
 * raw `JSON.stringify` output would reject a legitimate reuse whose keys were
 * merely ordered differently, which is a false 409.
 *
 * Takes `unknown` on purpose: it compares a payload read back out of Postgres
 * against one parsed from a request, and those are different Prisma types.
 */
function canonicalize(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map(canonicalize);
  }

  if (isPlainObject(value)) {
    const sortedEntries = Object.entries(value).sort(([left], [right]) =>
      left < right ? -1 : left > right ? 1 : 0,
    );

    const canonical: Record<string, unknown> = {};
    for (const [key, nested] of sortedEntries) {
      canonical[key] = canonicalize(nested);
    }
    return canonical;
  }

  return value;
}

export function canonicalJsonString(value: unknown): string {
  return JSON.stringify(canonicalize(value));
}

export function payloadsAreDeepEqual(left: unknown, right: unknown): boolean {
  return canonicalJsonString(left) === canonicalJsonString(right);
}
