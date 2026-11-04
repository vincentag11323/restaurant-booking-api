import { Router } from "express";
import swaggerUi from "swagger-ui-express";
import { z } from "zod";
import { buildApiDocument, registry } from "../lib/openApi.js";

/** GET /api/public/docs (Swagger UI) and /api/public/docs/openapi.json. Mounted only when config.apiDocs. */
export const docsRouter = Router();

registry.registerPath({
  method: "get",
  path: "/api/public/docs",
  tags: ["Public"],
  summary: "Swagger UI: try every endpoint from the browser",
  description:
    "Anyone may open it (off in production unless `API_DOCS=true`). `/api/public/docs` redirects to `/api/public/docs/` so the page's files load. To try changes (POST, PATCH, DELETE), open the page through the web app's address, because changes from other sites are refused.",
  responses: {
    200: { description: "The Swagger UI page.", content: { "text/html": { schema: z.string(), example: "<!DOCTYPE html><html>…swagger-ui…</html>" } } },
    301: { description: "Redirect from `/api/public/docs` to `/api/public/docs/`." },
  },
});

registry.registerPath({
  method: "get",
  path: "/api/public/docs/openapi.json",
  tags: ["Public"],
  summary: "This OpenAPI 3.1 document",
  description: "Anyone may call it (off in production unless `API_DOCS=true`). Built from the same Zod schemas that check every request.",
  responses: {
    200: { description: "The OpenAPI document.", content: { "application/json": { schema: z.record(z.string(), z.unknown()), example: { openapi: "3.1.0", info: { title: "ResortOS booking API" } } } } },
  },
});

// Built on first use, after every route file has registered its paths.
let document: ReturnType<typeof buildApiDocument> | undefined;

docsRouter.get("/openapi.json", (_req, res) => {
  document ??= buildApiDocument();
  res.json(document);
});

// The page loads its files with relative URLs ("./swagger-ui.css"), which only resolve under the trailing slash.
docsRouter.get("/", (req, res, next) => {
  const [path, query] = req.originalUrl.split("?");
  if (!path.endsWith("/")) {
    res.redirect(301, `${path}/${query === undefined ? "" : `?${query}`}`);
    return;
  }
  next();
}, swaggerUi.setup(undefined, { swaggerUrl: "openapi.json", customSiteTitle: "ResortOS booking API" }));
docsRouter.use(swaggerUi.serve);
