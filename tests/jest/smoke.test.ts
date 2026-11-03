import { describe, expect, it } from "@jest/globals";
import request from "supertest";
import { createApp } from "../../src/app.js";
import { prisma } from "../../src/lib/db.js";

describe("jest harness", () => {
  it("talks to the seeded database through the app", async () => {
    const res = await request(createApp()).get("/api/public/menus");
    expect(res.status).toBe(200);
    expect(res.body).toHaveLength(10);
    await prisma.$disconnect();
  });
});
