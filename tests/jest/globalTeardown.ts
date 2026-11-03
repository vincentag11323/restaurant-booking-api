import type { PGlite } from "@electric-sql/pglite";
import type { PGLiteSocketServer } from "@electric-sql/pglite-socket";

export default async function globalTeardown() {
  const { db, server } = (globalThis as unknown as { __PGLITE__: { db: PGlite | null; server: PGLiteSocketServer | null } }).__PGLITE__;
  await server?.stop();
  await db?.close();
}
