import { prisma } from "@/lib/db/prisma";

export async function getServices() {
  return prisma.service.findMany({
    where: { isActive: true },
    orderBy: { name: "asc" },
  });
}

export async function getStaff() {
  return prisma.staff.findMany({
    where: { isActive: true },
    orderBy: { name: "asc" },
  });
}
