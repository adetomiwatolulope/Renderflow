/**
 * The app's own JSON types, deliberately mutable.
 *
 * Prisma's `InputJsonValue` cannot be used here: its object form has a
 * `readonly` index signature and its array form is a `ReadonlyArray`, so a value
 * cannot be assembled field by field, and it forbids `null` at the top level.
 *
 * A `JsonObject` is structurally assignable to `Prisma.InputJsonValue`, so
 * request data is parsed into these types and crosses over at exactly one
 * place: the Prisma write in `create-job.ts`.
 */
export type JsonValue = string | number | boolean | null | JsonObject | JsonArray;

export type JsonObject = { [key: string]: JsonValue };

export type JsonArray = JsonValue[];
