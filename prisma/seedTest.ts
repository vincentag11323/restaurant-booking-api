// TEST DATA ONLY (E2E_SPEC.md §2). Loaded by `npm run db-test` on top of the normal seed.
// Every guest here is fake (*@guests.test); passwords are public test values.
import bcrypt from "bcryptjs";
import { bookReservation, generateReservationCode } from "../src/domain/reservations.js";
import { computeSlot, todayLocal } from "../src/domain/slots.js";
import { prisma } from "../src/lib/db.js";

export const TEST_PASSWORD = "Password123";
const OFFSET = "+07:00";

function addLocalDays(date: string, days: number): string {
  const [y, m, d] = date.split("-").map(Number);
  return new Date(Date.UTC(y, m - 1, d + days)).toISOString().slice(0, 10);
}

const guests = [
  { email: "ayu@guests.test", name: "Ayu Lestari (test)", phone: "+62 811 0000 001", allergies: ["fish"], signedUp: true },
  { email: "budi@guests.test", name: "Budi Santoso (test)", phone: "+62 811 0000 002", allergies: [], signedUp: true },
  { email: "citra@guests.test", name: "citra", phone: null, allergies: [], signedUp: false },
];

async function main() {
  const hash = await bcrypt.hash(TEST_PASSWORD, 10);
  const ids: Record<string, string> = {};
  for (const g of guests) {
    const user = await prisma.user.upsert({
      where: { email: g.email },
      update: {},
      create: { email: g.email, name: g.name, phone: g.phone, allergies: g.allergies, passwordHash: g.signedUp ? hash : null },
    });
    ids[g.email] = user.id;
  }
  const agent = await prisma.user.findFirst({ where: { role: "AGENT" } });

  // Upcoming bookings through the real booking path (they hold real tables).
  const today = todayLocal(OFFSET);
  await bookReservation(
    { branch: "BRANCH_1", sector: "MAIN_HALL", date: addLocalDays(today, 3), startTime: "19:30", partySize: 4, specialRequests: "Anniversary (test)" },
    { userId: ids["ayu@guests.test"], createdById: ids["ayu@guests.test"], source: "APP" },
  );
  await bookReservation(
    { branch: "BRANCH_2", sector: "VIP_WING", date: addLocalDays(today, 5), startTime: "17:00", partySize: 9 },
    { userId: ids["citra@guests.test"], createdById: agent?.id ?? ids["citra@guests.test"], source: "AGENT" },
  );

  // Past bookings in the statuses only staff would set, so admin filters have data.
  const past = [
    { email: "budi@guests.test", days: -2, status: "COMPLETED" as const },
    { email: "budi@guests.test", days: -1, status: "NO_SHOW" as const },
    { email: "ayu@guests.test", days: -1, status: "SEATED" as const },
    { email: "ayu@guests.test", days: -3, status: "CANCELLED" as const },
  ];
  for (const p of past) {
    const { slotStart, slotEnd } = computeSlot(addLocalDays(today, p.days), "11:00", OFFSET);
    await prisma.reservation.create({
      data: {
        code: generateReservationCode(), userId: ids[p.email], createdById: ids[p.email], branch: "BRANCH_1", sector: "MAIN_HALL",
        slotStart, slotEnd, partySize: 2, tableIds: ["B1-MH-50"], status: p.status, cancelledAt: p.status === "CANCELLED" ? new Date() : null,
      },
    });
  }
}

main()
  .then(() => prisma.$disconnect())
  .catch(async (err) => {
    console.error(err);
    await prisma.$disconnect();
    process.exit(1);
  });
