import bcrypt from "bcryptjs";
import { prisma } from "../src/lib/db.js";
import type { Branch, MenuType, Sector } from "../src/generated/prisma/enums.js";
import { MAIN_HALL_TABLE_SEATS, VIP_ROOM_SEATS } from "../src/domain/allocation.js";

const MAIN_HALL_TABLES = 50;
const VIP_ROOMS = 4;

const BRANCHES: { branch: Branch; prefix: string }[] = [
  { branch: "BRANCH_1", prefix: "B1" },
  { branch: "BRANCH_2", prefix: "B2" },
];

function diningTables() {
  return BRANCHES.flatMap(({ branch, prefix }) => [
    ...Array.from({ length: MAIN_HALL_TABLES }, (_, i) => ({
      id: `${prefix}-MH-${String(i + 1).padStart(2, "0")}`,
      branch,
      sector: "MAIN_HALL" as Sector,
      seats: MAIN_HALL_TABLE_SEATS,
    })),
    ...Array.from({ length: VIP_ROOMS }, (_, i) => ({
      id: `${prefix}-VIP-${i + 1}`,
      branch,
      sector: "VIP_WING" as Sector,
      seats: VIP_ROOM_SEATS,
    })),
  ]);
}

const MENU: { name: string; description: string; type: MenuType; priceCents: number; allergens: string[]; chefPick?: boolean }[] = [
  { name: "Chicken Steak", description: "Grilled free-range thigh, mushroom jus, charred corn.", type: "A_LA_CARTE", priceCents: 12_500_000, allergens: ["dairy"] },
  { name: "Beef Steak", description: "Grain-fed sirloin, peppercorn sauce, hand-cut fries.", type: "A_LA_CARTE", priceCents: 28_500_000, allergens: ["dairy"], chefPick: true },
  { name: "Barramundi", description: "Pan-roasted fillet, lemon butter, sambal matah.", type: "A_LA_CARTE", priceCents: 19_500_000, allergens: ["fish", "dairy"] },
  { name: "Fish & Chips", description: "Beer-battered snapper, tartare sauce, mushy peas.", type: "A_LA_CARTE", priceCents: 14_500_000, allergens: ["fish", "gluten", "egg"] },
  { name: "Classic Burger", description: "Beef patty, aged cheddar, pickles, brioche bun.", type: "A_LA_CARTE", priceCents: 13_500_000, allergens: ["gluten", "dairy", "egg"] },
  { name: "Garden Salad", description: "Local greens, roasted pumpkin, citrus dressing.", type: "A_LA_CARTE", priceCents: 8_500_000, allergens: [] },
  { name: "Seared Scallops", description: "Cauliflower purée, brown butter, crisp shallot.", type: "SEASONAL_FINE_DINING", priceCents: 32_000_000, allergens: ["shellfish", "dairy"], chefPick: true },
  { name: "Wagyu Tenderloin", description: "Smoked eggplant, red wine reduction, bone marrow.", type: "SEASONAL_FINE_DINING", priceCents: 65_000_000, allergens: ["dairy"] },
  { name: "Mango Sticky Rice", description: "Coconut cream, toasted sesame, pandan.", type: "SEASONAL_FINE_DINING", priceCents: 9_500_000, allergens: ["sesame"], chefPick: true },
  { name: "Dark Chocolate Tart", description: "Hazelnut praline, sea salt, vanilla cream.", type: "SEASONAL_FINE_DINING", priceCents: 11_000_000, allergens: ["gluten", "dairy", "egg", "nuts"] },
];

async function main() {
  await prisma.diningTable.createMany({ data: diningTables(), skipDuplicates: true });

  for (const item of MENU) {
    await prisma.menuItem.upsert({ where: { name: item.name }, update: item, create: item });
  }

  const email = process.env.ADMIN_EMAIL?.toLowerCase();
  const password = process.env.ADMIN_PASSWORD;
  if (email && password) {
    await prisma.user.upsert({
      where: { email },
      update: {},
      create: { email, name: "Restaurant Admin", role: "ADMIN", passwordHash: await bcrypt.hash(password, 12) },
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
