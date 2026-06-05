// Run: npx prisma db seed
import { PrismaClient } from "../app/generated/prisma/client";
import { PrismaPg } from "@prisma/adapter-pg";

const adapter = new PrismaPg({
  connectionString: process.env.DATABASE_URL ?? "",
});
const prisma = new PrismaClient({ adapter });

async function main() {
  // Delete in foreign-key-safe order
  await prisma.appointment.deleteMany();
  await prisma.blockedTime.deleteMany();
  await prisma.workingHour.deleteMany();
  await prisma.staff.deleteMany();
  await prisma.service.deleteMany();
  await prisma.customer.deleteMany();

  const staff = await prisma.staff.create({
    data: { name: "Default Barber" },
  });

  await prisma.service.createMany({
    data: [
      { name: "Haircut", description: "Classic haircut", durationMinutes: 30, price: 80 },
      { name: "Beard", description: "Beard trim and shaping", durationMinutes: 20, price: 50 },
      { name: "Haircut + Beard", description: "Full haircut and beard combo", durationMinutes: 45, price: 120 },
      { name: "Kids Haircut", description: "Haircut for children", durationMinutes: 25, price: 60 },
    ],
  });

  // 0=Sunday … 5=Friday, Saturday (6) is closed — no row inserted
  await prisma.workingHour.createMany({
    data: [
      { staffId: staff.id, dayOfWeek: 0, startTime: "09:00", endTime: "18:00" }, // Sunday
      { staffId: staff.id, dayOfWeek: 1, startTime: "09:00", endTime: "18:00" }, // Monday
      { staffId: staff.id, dayOfWeek: 2, startTime: "09:00", endTime: "18:00" }, // Tuesday
      { staffId: staff.id, dayOfWeek: 3, startTime: "09:00", endTime: "18:00" }, // Wednesday
      { staffId: staff.id, dayOfWeek: 4, startTime: "09:00", endTime: "18:00" }, // Thursday
      { staffId: staff.id, dayOfWeek: 5, startTime: "09:00", endTime: "14:00" }, // Friday
    ],
  });

  console.log("✓ Seed complete: 1 staff, 4 services, 6 working-day schedules");
}

main()
  .catch((e) => {
    console.error(e);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());
