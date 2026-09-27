import "server-only";

import { PrismaClient } from "@prisma/client";

// Next.js dev re-evaluates modules on hot reload; caching the client on
// globalThis keeps one connection pool instead of leaking one per reload.
const globalForPrisma = globalThis as unknown as {
  prisma: PrismaClient | undefined;
};

export const db: PrismaClient = globalForPrisma.prisma ?? new PrismaClient();

if (process.env.NODE_ENV !== "production") {
  globalForPrisma.prisma = db;
}
