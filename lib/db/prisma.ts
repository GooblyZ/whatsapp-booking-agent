import { PrismaClient } from "@/app/generated/prisma/client";
import { PrismaPg } from "@prisma/adapter-pg";

// Strip any sslmode= param from the URL so pg-connection-string does not emit
// the ambiguity warning. SSL is configured explicitly via the ssl option below,
// which sets verify-full semantics (the safest and most explicit mode).
function buildConnectionString(): string {
  const raw = process.env.DATABASE_URL ?? "";
  try {
    const url = new URL(raw);
    url.searchParams.delete("sslmode");
    return url.toString();
  } catch {
    return raw;
  }
}

function createClient() {
  const adapter = new PrismaPg({
    connectionString: buildConnectionString(),
    ssl: { rejectUnauthorized: true },
  });
  return new PrismaClient({ adapter });
}

const globalForPrisma = globalThis as unknown as { prisma: PrismaClient | undefined };

export const prisma = globalForPrisma.prisma ?? createClient();

if (process.env.NODE_ENV !== "production") {
  globalForPrisma.prisma = prisma;
}
