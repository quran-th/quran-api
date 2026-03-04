import { OpenAPIHono, createRoute, z } from "@hono/zod-openapi";
import { swaggerUI } from "@hono/swagger-ui";
import { drizzle } from "drizzle-orm/d1";
import { cors } from "hono/cors";
import { eq, asc } from "drizzle-orm";
import { quranTranslations, translationSources } from "./db/schema";

import { surahs } from "./data/surahs";
import auth from "./routes/auth";
import contributor from "./routes/contributor";
import admin from "./routes/admin";

// Import all word data files at build time for Cloudflare Workers compatibility
import wordData1 from "../data/quran-words/1.json";
import wordData2 from "../data/quran-words/2.json";
import wordData3 from "../data/quran-words/3.json";
import wordData4 from "../data/quran-words/4.json";
import wordData5 from "../data/quran-words/5.json";
import wordData6 from "../data/quran-words/6.json";
import wordData7 from "../data/quran-words/7.json";
import wordData8 from "../data/quran-words/8.json";
import wordData9 from "../data/quran-words/9.json";
import wordData10 from "../data/quran-words/10.json";
import wordData11 from "../data/quran-words/11.json";
import wordData12 from "../data/quran-words/12.json";
import wordData13 from "../data/quran-words/13.json";
import wordData14 from "../data/quran-words/14.json";
import wordData15 from "../data/quran-words/15.json";
import wordData16 from "../data/quran-words/16.json";
import wordData17 from "../data/quran-words/17.json";
import wordData18 from "../data/quran-words/18.json";
import wordData19 from "../data/quran-words/19.json";
import wordData20 from "../data/quran-words/20.json";
import wordData21 from "../data/quran-words/21.json";
import wordData22 from "../data/quran-words/22.json";
import wordData23 from "../data/quran-words/23.json";
import wordData24 from "../data/quran-words/24.json";
import wordData25 from "../data/quran-words/25.json";
import wordData26 from "../data/quran-words/26.json";
import wordData27 from "../data/quran-words/27.json";
import wordData28 from "../data/quran-words/28.json";
import wordData29 from "../data/quran-words/29.json";
import wordData30 from "../data/quran-words/30.json";
import wordData31 from "../data/quran-words/31.json";
import wordData32 from "../data/quran-words/32.json";
import wordData33 from "../data/quran-words/33.json";
import wordData34 from "../data/quran-words/34.json";
import wordData35 from "../data/quran-words/35.json";
import wordData36 from "../data/quran-words/36.json";
import wordData37 from "../data/quran-words/37.json";
import wordData38 from "../data/quran-words/38.json";
import wordData39 from "../data/quran-words/39.json";
import wordData40 from "../data/quran-words/40.json";
import wordData41 from "../data/quran-words/41.json";
import wordData42 from "../data/quran-words/42.json";
import wordData43 from "../data/quran-words/43.json";
import wordData44 from "../data/quran-words/44.json";
import wordData45 from "../data/quran-words/45.json";
import wordData46 from "../data/quran-words/46.json";
import wordData47 from "../data/quran-words/47.json";
import wordData48 from "../data/quran-words/48.json";
import wordData49 from "../data/quran-words/49.json";
import wordData50 from "../data/quran-words/50.json";
import wordData51 from "../data/quran-words/51.json";
import wordData52 from "../data/quran-words/52.json";
import wordData53 from "../data/quran-words/53.json";
import wordData54 from "../data/quran-words/54.json";
import wordData55 from "../data/quran-words/55.json";
import wordData56 from "../data/quran-words/56.json";
import wordData57 from "../data/quran-words/57.json";
import wordData58 from "../data/quran-words/58.json";
import wordData59 from "../data/quran-words/59.json";
import wordData60 from "../data/quran-words/60.json";
import wordData61 from "../data/quran-words/61.json";
import wordData62 from "../data/quran-words/62.json";
import wordData63 from "../data/quran-words/63.json";
import wordData64 from "../data/quran-words/64.json";
import wordData65 from "../data/quran-words/65.json";
import wordData66 from "../data/quran-words/66.json";
import wordData67 from "../data/quran-words/67.json";
import wordData68 from "../data/quran-words/68.json";
import wordData69 from "../data/quran-words/69.json";
import wordData70 from "../data/quran-words/70.json";
import wordData71 from "../data/quran-words/71.json";
import wordData72 from "../data/quran-words/72.json";
import wordData73 from "../data/quran-words/73.json";
import wordData74 from "../data/quran-words/74.json";
import wordData75 from "../data/quran-words/75.json";
import wordData76 from "../data/quran-words/76.json";
import wordData77 from "../data/quran-words/77.json";
import wordData78 from "../data/quran-words/78.json";
import wordData79 from "../data/quran-words/79.json";
import wordData80 from "../data/quran-words/80.json";
import wordData81 from "../data/quran-words/81.json";
import wordData82 from "../data/quran-words/82.json";
import wordData83 from "../data/quran-words/83.json";
import wordData84 from "../data/quran-words/84.json";
import wordData85 from "../data/quran-words/85.json";
import wordData86 from "../data/quran-words/86.json";
import wordData87 from "../data/quran-words/87.json";
import wordData88 from "../data/quran-words/88.json";
import wordData89 from "../data/quran-words/89.json";
import wordData90 from "../data/quran-words/90.json";
import wordData91 from "../data/quran-words/91.json";
import wordData92 from "../data/quran-words/92.json";
import wordData93 from "../data/quran-words/93.json";
import wordData94 from "../data/quran-words/94.json";
import wordData95 from "../data/quran-words/95.json";
import wordData96 from "../data/quran-words/96.json";
import wordData97 from "../data/quran-words/97.json";
import wordData98 from "../data/quran-words/98.json";
import wordData99 from "../data/quran-words/99.json";
import wordData100 from "../data/quran-words/100.json";
import wordData101 from "../data/quran-words/101.json";
import wordData102 from "../data/quran-words/102.json";
import wordData103 from "../data/quran-words/103.json";
import wordData104 from "../data/quran-words/104.json";
import wordData105 from "../data/quran-words/105.json";
import wordData106 from "../data/quran-words/106.json";
import wordData107 from "../data/quran-words/107.json";
import wordData108 from "../data/quran-words/108.json";
import wordData109 from "../data/quran-words/109.json";
import wordData110 from "../data/quran-words/110.json";
import wordData111 from "../data/quran-words/111.json";
import wordData112 from "../data/quran-words/112.json";
import wordData113 from "../data/quran-words/113.json";
import wordData114 from "../data/quran-words/114.json";

// Map of all word data for O(1) lookup
const wordDataMap: Record<number, unknown> = {
  1: wordData1, 2: wordData2, 3: wordData3, 4: wordData4, 5: wordData5,
  6: wordData6, 7: wordData7, 8: wordData8, 9: wordData9, 10: wordData10,
  11: wordData11, 12: wordData12, 13: wordData13, 14: wordData14, 15: wordData15,
  16: wordData16, 17: wordData17, 18: wordData18, 19: wordData19, 20: wordData20,
  21: wordData21, 22: wordData22, 23: wordData23, 24: wordData24, 25: wordData25,
  26: wordData26, 27: wordData27, 28: wordData28, 29: wordData29, 30: wordData30,
  31: wordData31, 32: wordData32, 33: wordData33, 34: wordData34, 35: wordData35,
  36: wordData36, 37: wordData37, 38: wordData38, 39: wordData39, 40: wordData40,
  41: wordData41, 42: wordData42, 43: wordData43, 44: wordData44, 45: wordData45,
  46: wordData46, 47: wordData47, 48: wordData48, 49: wordData49, 50: wordData50,
  51: wordData51, 52: wordData52, 53: wordData53, 54: wordData54, 55: wordData55,
  56: wordData56, 57: wordData57, 58: wordData58, 59: wordData59, 60: wordData60,
  61: wordData61, 62: wordData62, 63: wordData63, 64: wordData64, 65: wordData65,
  66: wordData66, 67: wordData67, 68: wordData68, 69: wordData69, 70: wordData70,
  71: wordData71, 72: wordData72, 73: wordData73, 74: wordData74, 75: wordData75,
  76: wordData76, 77: wordData77, 78: wordData78, 79: wordData79, 80: wordData80,
  81: wordData81, 82: wordData82, 83: wordData83, 84: wordData84, 85: wordData85,
  86: wordData86, 87: wordData87, 88: wordData88, 89: wordData89, 90: wordData90,
  91: wordData91, 92: wordData92, 93: wordData93, 94: wordData94, 95: wordData95,
  96: wordData96, 97: wordData97, 98: wordData98, 99: wordData99, 100: wordData100,
  101: wordData101, 102: wordData102, 103: wordData103, 104: wordData104, 105: wordData105,
  106: wordData106, 107: wordData107, 108: wordData108, 109: wordData109, 110: wordData110,
  111: wordData111, 112: wordData112, 113: wordData113, 114: wordData114,
};

import {
  ErrorSchema,
  TranslationSourceSchema,
  SurahSchema,
  SurahWithPaginatedVersesSchema,
  SurahIdParamSchema,
  SurahVerseQuerySchema,
} from "./openapi/schemas";

type Bindings = {
  DB: D1Database;
  CACHE: KVNamespace;
  JWT_SECRET: string;
};

// ─── App ──────────────────────────────────────────────────────────────────────
// defaultHook fires after every route's Zod validation.
// Returning a Response here short-circuits the handler; returning nothing
// lets the request proceed normally (void is the correct type for that path).

const app = new OpenAPIHono<{ Bindings: Bindings }>({
  // eslint-disable-next-line consistent-return
  defaultHook: (result, c) => {
    if (!result.success) {
      return c.json(
        {
          success: false as const,
          message: "Validation error",
          errors: result.error.issues.map((i) => ({ path: i.path.join("."), message: i.message })),
        },
        422
      );
    }
  },
});

app.use("/*", cors());

// ─── GET / ────────────────────────────────────────────────────────────────────

app.openapi(
  createRoute({
    method: "get",
    path: "/",
    tags: ["Health"],
    summary: "API health check",
    responses: {
      200: {
        content: {
          "application/json": {
            schema: z.object({
              message: z.string(),
              status: z.string(),
              timestamp: z.string(),
            }),
          },
        },
        description: "API is online",
      },
    },
  }),
  (c) =>
    c.json(
      {
        message: "Quran API",
        status: "online",
        timestamp: new Date().toISOString(),
      },
      200
    )
);

// ─── GET /surahs ──────────────────────────────────────────────────────────────
// Returns static surah metadata (name, number, verse count, etc.) for all
// 114 surahs. No database query — data is bundled at build time.

app.openapi(
  createRoute({
    method: "get",
    path: "/surahs",
    tags: ["Quran"],
    summary: "List all 114 surahs (static metadata)",
    responses: {
      200: {
        content: {
          "application/json": {
            schema: z.object({
              success: z.literal(true),
              data: z.array(SurahSchema),
              timestamp: z.string(),
            }),
          },
        },
        description: "Surah list",
      },
    },
  }),
  (c) =>
    c.json(
      {
        success: true as const,
        data: surahs as any[],
        timestamp: new Date().toISOString(),
      },
      200
    )
);

// ─── GET /surahs/:id ──────────────────────────────────────────────────────────
// Returns a single surah with its Arabic verses and Thai translations.
// Accepts an optional `sourceId` query param to select a translation source;
// falls back to the source marked `is_default = 1` in the DB.
// Footnotes are fetched in a second query and joined in-memory by verse ID.

app.openapi(
  createRoute({
    method: "get",
    path: "/surahs/{id}",
    tags: ["Quran"],
    summary: "Get a surah with verses and Thai translations",
    request: {
      params: SurahIdParamSchema,
      query: SurahVerseQuerySchema,
    },
    responses: {
      200: {
        content: {
          "application/json": {
            schema: z.object({ success: z.literal(true), data: SurahWithPaginatedVersesSchema }),
          },
        },
        description: "Surah with paginated verses",
      },
      404: {
        content: { "application/json": { schema: ErrorSchema } },
        description: "Surah not found",
      },
      500: {
        content: { "application/json": { schema: ErrorSchema } },
        description: "Server error",
      },
    },
  }),
  async (c) => {
    const { id } = c.req.valid("param");
    const { sourceId: sourceIdParam, offset, limit } = c.req.valid("query");
    const numericId = parseInt(id);
    const surah = surahs.find((s) => s.id === numericId);

    if (!surah) {
      return c.json({ success: false as const, message: "Surah not found" }, 404);
    }

    try {
      const db = drizzle(c.env.DB);

      // Resolve which translation source to use
      let sourceId: number;
      if (sourceIdParam) {
        sourceId = sourceIdParam;
      } else {
        const defaultSource = await db
          .select({ id: translationSources.id })
          .from(translationSources)
          .where(eq(translationSources.isDefault, 1))
          .limit(1);
        sourceId = defaultSource[0]?.id ?? 1;
      }

      // Fetch Arabic verse text from quran_translations with pagination
      const arabicVerses = await db
        .select({
          surahNumber: quranTranslations.surahNumber,
          verseNumber: quranTranslations.verseNumber,
          content: quranTranslations.content,
        })
        .from(quranTranslations)
        .where(eq(quranTranslations.surahNumber, numericId))
        .orderBy(asc(quranTranslations.verseNumber))
        .limit(limit)
        .offset(offset)
        .all();

      // Fetch Thai translations for the chosen source with pagination
      const vtRows = await c.env.DB.prepare(
        `
        SELECT
          vt.id,
          vt.verse_number,
          vt.translation_text,
          vt.is_verified
        FROM verse_translations vt
        WHERE vt.source_id = ? AND vt.surah_number = ?
        ORDER BY vt.verse_number ASC
        LIMIT ? OFFSET ?
      `
      )
        .bind(sourceId, numericId, limit, offset)
        .all<{
          id: number;
          verse_number: number;
          translation_text: string;
          is_verified: number;
        }>();

      // Fetch footnotes scoped to the current verse range to avoid D1's bound-parameter limit.
      const footnoteMap = new Map<number, { number: number; text: string }[]>();

      if (vtRows.results.length > 0) {
        // Calculate verse range: (offset, offset + limit]
        const verseStart = offset;
        const verseEnd = offset + limit;

        const fnRows = await c.env.DB.prepare(
          `
          SELECT tf.verse_translation_id, tf.footnote_number, tf.text
          FROM translation_footnotes tf
          WHERE tf.verse_translation_id IN (
            SELECT vt.id FROM verse_translations vt
            WHERE vt.source_id = ? AND vt.surah_number = ?
              AND vt.verse_number > ? AND vt.verse_number <= ?
          )
          ORDER BY tf.verse_translation_id, tf.footnote_number ASC
        `
        )
          .bind(sourceId, numericId, verseStart, verseEnd)
          .all<{ verse_translation_id: number; footnote_number: number; text: string }>();

        fnRows.results.forEach((fn) => {
          if (!footnoteMap.has(fn.verse_translation_id)) {
            footnoteMap.set(fn.verse_translation_id, []);
          }
          footnoteMap
            .get(fn.verse_translation_id)!
            .push({ number: fn.footnote_number, text: fn.text });
        });
      }

      // Merge Arabic content + Thai translation + footnotes per verse
      const translationByVerse = new Map(vtRows.results.map((r) => [r.verse_number, r]));

      const verses = arabicVerses.map((av) => {
        const vt = translationByVerse.get(av.verseNumber);
        return {
          verseNumber: av.verseNumber,
          content: av.content,
          translation: vt?.translation_text ?? "",
          footnotes: vt ? (footnoteMap.get(vt.id) ?? []) : [],
          isVerified: vt ? Boolean(vt.is_verified) : false,
        };
      });

      // Compute pagination metadata from static surah data
      const total = surah.verses_count;
      const hasMore = offset + limit < total;

      const pagination = {
        offset,
        limit,
        total,
        hasMore,
      };

      c.header("Cache-Control", "public, max-age=3600");
      return c.json(
        {
          success: true as const,
          data: { ...surah, sourceId, verses, pagination } as any,
        },
        200
      );
    } catch (e) {
      console.error(e);
      return c.json({ success: false as const, message: "Failed to fetch verses" }, 500);
    }
  }
);

// ─── GET /verse-words/:surahId ─────────────────────────────────────────────────
// Serves pre-fetched word-level data for QCF glyph rendering.

app.get("/verse-words/:surahId", (c) => {
  const { surahId } = c.req.param();
  const numericId = parseInt(surahId);

  if (numericId < 1 || numericId > 114) {
    return c.json({ success: false, message: "Invalid surah ID" }, 400);
  }

  const words = wordDataMap[numericId];
  if (!words) {
    return c.json({ success: false, message: "Words not found" }, 404);
  }

  return c.json({ success: true, data: words });
});

// ─── GET /surahs/:id/mushaf-pages ───────────────────────────────────────────────
// Returns Mushaf page boundaries for a surah.
// Each entry maps a Mushaf page number to the verse range it contains.
// Frontend uses this for Mushaf-aligned pagination.

app.get("/surahs/:id/mushaf-pages", async (c) => {
  const { id } = c.req.param();
  const numericId = parseInt(id);

  if (numericId < 1 || numericId > 114) {
    return c.json({ success: false, message: "Invalid surah ID" }, 400);
  }

  try {
    // Read the surah-page-mapping.json file from assets
    // In production, this will be served from the CDN
    const mappingUrl = 'https://assets.quran.in.th/quran-pages/surah-page-mapping.json';
    const response = await fetch(mappingUrl);

    if (!response.ok) {
      return c.json({ success: false, message: "Failed to fetch page mapping" }, 500);
    }

    const mapping = await response.json();
    const pages = mapping[numericId];

    if (!pages) {
      return c.json({ success: false, message: "Surah page mapping not found" }, 404);
    }

    return c.json({ success: true, data: pages });
  } catch (e) {
    console.error('Error fetching Mushaf page mapping:', e);
    return c.json({ success: false, message: "Server error" }, 500);
  }
});

// ─── GET /translation-sources ─────────────────────────────────────────────────
// Lists all available translation sources ordered by ID.
// The frontend uses this to populate the source selector dropdown.

app.openapi(
  createRoute({
    method: "get",
    path: "/translation-sources",
    tags: ["Quran"],
    summary: "List all available translation sources",
    responses: {
      200: {
        content: {
          "application/json": {
            schema: z.object({
              success: z.literal(true),
              data: z.array(TranslationSourceSchema),
            }),
          },
        },
        description: "Translation sources",
      },
      500: {
        content: { "application/json": { schema: ErrorSchema } },
        description: "Server error",
      },
    },
  }),
  async (c) => {
    try {
      const db = drizzle(c.env.DB);
      const sources = await db
        .select()
        .from(translationSources)
        .orderBy(asc(translationSources.id))
        .all();
      return c.json({ success: true as const, data: sources as any[] }, 200);
    } catch (e) {
      console.error(e);
      return c.json(
        { success: false as const, message: "Failed to fetch translation sources" },
        500
      );
    }
  }
);

// ─── Sub-routers ──────────────────────────────────────────────────────────────
// Each sub-router is defined in its own file and mounted here.
// OpenAPIHono automatically aggregates their routes into the /doc spec.

app.route("/auth", auth);
app.route("/contributor", contributor);
app.route("/admin", admin);

// ─── OpenAPI spec + Swagger UI ────────────────────────────────────────────────
// Register the bearer auth security scheme so it appears in the Swagger UI
// "Authorize" button. Individual routes opt in via security: [{ bearerAuth: [] }].

app.openAPIRegistry.registerComponent("securitySchemes", "bearerAuth", {
  type: "http",
  scheme: "bearer",
  bearerFormat: "JWT",
  description: "JWT token obtained from POST /auth/login",
});

// Serve the OpenAPI JSON spec at /doc
app.doc("/doc", {
  openapi: "3.0.0",
  info: {
    title: "Quran API",
    version: "1.0.0",
    description:
      "REST API for the Open Thai Quran Project — community-driven Quran translation correction for Thai readers.",
  },
  servers: [
    { url: "http://localhost:8787", description: "Local development" },
    { url: "https://api.quran.example.com", description: "Production" },
  ],
});

// Serve the Swagger UI at /ui
app.get("/ui", swaggerUI({ url: "/doc" }));

// Export AppType for Hono RPC client
export type AppType = typeof app;

export default app;
