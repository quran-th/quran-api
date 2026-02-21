import { OpenAPIHono, createRoute, z } from "@hono/zod-openapi";
import { drizzle } from "drizzle-orm/d1";
import { eq } from "drizzle-orm";
import {
  contributions,
  wordTranslations,
  verseTranslations,
  changelog,
  quranTranslations,
  translationSources,
} from "../db/schema";
import { requireAdmin } from "../middleware/auth";
import type { JwtPayload } from "../utils/jwt";
import {
  ErrorSchema,
  MessageSchema,
  IdParamSchema,
  TranslationSourceSchema,
  SourceCreateBodySchema,
  SourceUpdateBodySchema,
} from "../openapi/schemas";

type Bindings = {
  DB: D1Database;
  CACHE: KVNamespace;
  JWT_SECRET: string;
};

type Variables = {
  contributor: JwtPayload;
};

const admin = new OpenAPIHono<{ Bindings: Bindings; Variables: Variables }>();

admin.use("/*", requireAdmin);

// ─── GET /admin/queue ─────────────────────────────────────────────────────────

admin.openapi(
  createRoute({
    method: "get",
    path: "/queue",
    tags: ["Admin"],
    summary: "List pending translation proposals with verse context",
    security: [{ bearerAuth: [] }],
    responses: {
      200: {
        content: {
          "application/json": {
            schema: z.object({
              success: z.literal(true),
              data: z.array(z.record(z.string(), z.unknown())),
            }),
          },
        },
        description: "Pending contributions queue",
      },
      401: {
        content: { "application/json": { schema: ErrorSchema } },
        description: "Unauthorized",
      },
      403: {
        content: { "application/json": { schema: ErrorSchema } },
        description: "Admin access required",
      },
    },
  }),
  async (c) => {
    const query = `
      SELECT
        c.id,
        c.verse_translation_id,
        c.suggested_translation,
        c.contributor_name,
        c.contributor_id,
        c.status,
        c.created_at,
        vt.surah_number,
        vt.verse_number,
        vt.translation_text AS current_translation,
        qt.content AS arabic,
        ts.id AS source_id,
        ts.name AS source_name,
        ts.short_name AS source_short_name
      FROM contributions c
      JOIN verse_translations vt ON vt.id = c.verse_translation_id
      JOIN quran_translations qt ON qt.surah_number = vt.surah_number AND qt.verse_number = vt.verse_number
      JOIN translation_sources ts ON ts.id = vt.source_id
      WHERE c.status = 'pending'
      ORDER BY c.created_at ASC
      LIMIT 100
    `;
    const result = await c.env.DB.prepare(query).all();
    return c.json({ success: true as const, data: result.results as any[] }, 200);
  }
);

// ─── POST /admin/contributions/:id/approve ────────────────────────────────────

admin.openapi(
  createRoute({
    method: "post",
    path: "/contributions/{id}/approve",
    tags: ["Admin"],
    summary: "Approve a pending translation proposal",
    security: [{ bearerAuth: [] }],
    request: { params: IdParamSchema },
    responses: {
      200: {
        content: { "application/json": { schema: MessageSchema } },
        description: "Contribution approved and translation updated",
      },
      400: {
        content: { "application/json": { schema: ErrorSchema } },
        description: "Contribution is not pending or missing verse translation",
      },
      401: {
        content: { "application/json": { schema: ErrorSchema } },
        description: "Unauthorized",
      },
      403: {
        content: { "application/json": { schema: ErrorSchema } },
        description: "Admin access required",
      },
      404: {
        content: { "application/json": { schema: ErrorSchema } },
        description: "Contribution not found",
      },
    },
  }),
  async (c) => {
    const { id } = c.req.valid("param");
    const numericId = parseInt(id);
    const db = drizzle(c.env.DB);

    const [contribution] = await db
      .select()
      .from(contributions)
      .where(eq(contributions.id, numericId))
      .limit(1);

    if (!contribution) {
      return c.json({ success: false as const, message: "Contribution not found" }, 404);
    }

    if (contribution.status !== "pending") {
      return c.json({ success: false as const, message: "Contribution is not pending" }, 400);
    }

    if (!contribution.verseTranslationId) {
      return c.json(
        { success: false as const, message: "Contribution has no associated verse translation" },
        400
      );
    }

    const [verse] = await db
      .select()
      .from(verseTranslations)
      .where(eq(verseTranslations.id, contribution.verseTranslationId))
      .limit(1);

    if (!verse) {
      return c.json(
        { success: false as const, message: "Associated verse translation not found" },
        404
      );
    }

    await db
      .update(verseTranslations)
      .set({
        translationText: contribution.suggestedTranslation,
        isVerified: true,
        lastUpdated: new Date(),
      })
      .where(eq(verseTranslations.id, verse.id));

    await db
      .update(contributions)
      .set({ status: "approved" })
      .where(eq(contributions.id, numericId));

    const legacyVerse = await db
      .select({ id: quranTranslations.id })
      .from(quranTranslations)
      .where(eq(quranTranslations.surahNumber, verse.surahNumber))
      .all()
      .then((rows) => rows.find((r) => r.id));

    const versionTag = `v${new Date().toISOString().slice(0, 10)}-contrib-${numericId}`;
    await db.insert(changelog).values({
      translationId: legacyVerse?.id ?? null,
      oldText: verse.translationText,
      newText: contribution.suggestedTranslation,
      versionTag,
    });

    return c.json(
      {
        success: true as const,
        message: "Contribution approved and translation updated",
      },
      200
    );
  }
);

// ─── POST /admin/contributions/:id/reject ─────────────────────────────────────

admin.openapi(
  createRoute({
    method: "post",
    path: "/contributions/{id}/reject",
    tags: ["Admin"],
    summary: "Reject a pending translation proposal",
    security: [{ bearerAuth: [] }],
    request: { params: IdParamSchema },
    responses: {
      200: {
        content: { "application/json": { schema: MessageSchema } },
        description: "Contribution rejected",
      },
      401: {
        content: { "application/json": { schema: ErrorSchema } },
        description: "Unauthorized",
      },
      403: {
        content: { "application/json": { schema: ErrorSchema } },
        description: "Admin access required",
      },
      404: {
        content: { "application/json": { schema: ErrorSchema } },
        description: "Contribution not found",
      },
    },
  }),
  async (c) => {
    const { id } = c.req.valid("param");
    const numericId = parseInt(id);
    const db = drizzle(c.env.DB);

    const [contribution] = await db
      .select()
      .from(contributions)
      .where(eq(contributions.id, numericId))
      .limit(1);

    if (!contribution) {
      return c.json({ success: false as const, message: "Contribution not found" }, 404);
    }

    await db
      .update(contributions)
      .set({ status: "rejected" })
      .where(eq(contributions.id, numericId));

    return c.json({ success: true as const, message: "Contribution rejected" }, 200);
  }
);

// ─── GET /admin/word-queue ────────────────────────────────────────────────────

admin.openapi(
  createRoute({
    method: "get",
    path: "/word-queue",
    tags: ["Admin"],
    summary: "List pending word translations",
    security: [{ bearerAuth: [] }],
    responses: {
      200: {
        content: {
          "application/json": {
            schema: z.object({
              success: z.literal(true),
              data: z.array(z.record(z.string(), z.unknown())),
            }),
          },
        },
        description: "Pending word translations",
      },
      401: {
        content: { "application/json": { schema: ErrorSchema } },
        description: "Unauthorized",
      },
      403: {
        content: { "application/json": { schema: ErrorSchema } },
        description: "Admin access required",
      },
    },
  }),
  async (c) => {
    const query = `
      SELECT
        wt.*,
        co.email AS contributor_email,
        co.display_name AS contributor_name
      FROM word_translations wt
      LEFT JOIN contributors co ON co.id = wt.contributor_id
      WHERE wt.status = 'pending'
      ORDER BY wt.created_at ASC
      LIMIT 100
    `;
    const result = await c.env.DB.prepare(query).all();
    return c.json({ success: true as const, data: result.results as any[] }, 200);
  }
);

// ─── POST /admin/word-translations/:id/approve ────────────────────────────────

admin.openapi(
  createRoute({
    method: "post",
    path: "/word-translations/{id}/approve",
    tags: ["Admin"],
    summary: "Approve a pending word translation",
    security: [{ bearerAuth: [] }],
    request: { params: IdParamSchema },
    responses: {
      200: {
        content: { "application/json": { schema: MessageSchema } },
        description: "Word translation approved",
      },
      401: {
        content: { "application/json": { schema: ErrorSchema } },
        description: "Unauthorized",
      },
      403: {
        content: { "application/json": { schema: ErrorSchema } },
        description: "Admin access required",
      },
      404: {
        content: { "application/json": { schema: ErrorSchema } },
        description: "Word translation not found",
      },
    },
  }),
  async (c) => {
    const { id } = c.req.valid("param");
    const numericId = parseInt(id);
    const db = drizzle(c.env.DB);

    const [wt] = await db
      .select()
      .from(wordTranslations)
      .where(eq(wordTranslations.id, numericId))
      .limit(1);

    if (!wt) {
      return c.json({ success: false as const, message: "Word translation not found" }, 404);
    }

    await db
      .update(wordTranslations)
      .set({ status: "approved", updatedAt: new Date() })
      .where(eq(wordTranslations.id, numericId));

    return c.json({ success: true as const, message: "Word translation approved" }, 200);
  }
);

// ─── POST /admin/word-translations/:id/reject ─────────────────────────────────

admin.openapi(
  createRoute({
    method: "post",
    path: "/word-translations/{id}/reject",
    tags: ["Admin"],
    summary: "Reject a pending word translation",
    security: [{ bearerAuth: [] }],
    request: { params: IdParamSchema },
    responses: {
      200: {
        content: { "application/json": { schema: MessageSchema } },
        description: "Word translation rejected",
      },
      401: {
        content: { "application/json": { schema: ErrorSchema } },
        description: "Unauthorized",
      },
      403: {
        content: { "application/json": { schema: ErrorSchema } },
        description: "Admin access required",
      },
      404: {
        content: { "application/json": { schema: ErrorSchema } },
        description: "Word translation not found",
      },
    },
  }),
  async (c) => {
    const { id } = c.req.valid("param");
    const numericId = parseInt(id);
    const db = drizzle(c.env.DB);

    const [wt] = await db
      .select()
      .from(wordTranslations)
      .where(eq(wordTranslations.id, numericId))
      .limit(1);

    if (!wt) {
      return c.json({ success: false as const, message: "Word translation not found" }, 404);
    }

    await db
      .update(wordTranslations)
      .set({ status: "rejected", updatedAt: new Date() })
      .where(eq(wordTranslations.id, numericId));

    return c.json({ success: true as const, message: "Word translation rejected" }, 200);
  }
);

// ─── GET /admin/sources ───────────────────────────────────────────────────────

admin.openapi(
  createRoute({
    method: "get",
    path: "/sources",
    tags: ["Admin"],
    summary: "List all translation sources with verse counts",
    security: [{ bearerAuth: [] }],
    responses: {
      200: {
        content: {
          "application/json": {
            schema: z.object({
              success: z.literal(true),
              data: z.array(z.record(z.string(), z.unknown())),
            }),
          },
        },
        description: "Translation sources",
      },
      401: {
        content: { "application/json": { schema: ErrorSchema } },
        description: "Unauthorized",
      },
      403: {
        content: { "application/json": { schema: ErrorSchema } },
        description: "Admin access required",
      },
    },
  }),
  async (c) => {
    const result = await c.env.DB.prepare(
      `
      SELECT
        ts.*,
        COUNT(vt.id) AS verse_count
      FROM translation_sources ts
      LEFT JOIN verse_translations vt ON vt.source_id = ts.id
      GROUP BY ts.id
      ORDER BY ts.id ASC
    `
    ).all();
    return c.json({ success: true as const, data: result.results as any[] }, 200);
  }
);

// ─── POST /admin/sources ──────────────────────────────────────────────────────

admin.openapi(
  createRoute({
    method: "post",
    path: "/sources",
    tags: ["Admin"],
    summary: "Create a new translation source",
    security: [{ bearerAuth: [] }],
    request: {
      body: {
        content: { "application/json": { schema: SourceCreateBodySchema } },
        required: true,
      },
    },
    responses: {
      201: {
        content: {
          "application/json": {
            schema: z.object({ success: z.literal(true), data: TranslationSourceSchema }),
          },
        },
        description: "Source created",
      },
      400: {
        content: { "application/json": { schema: ErrorSchema } },
        description: "name is required",
      },
      401: {
        content: { "application/json": { schema: ErrorSchema } },
        description: "Unauthorized",
      },
      403: {
        content: { "application/json": { schema: ErrorSchema } },
        description: "Admin access required",
      },
    },
  }),
  async (c) => {
    const body = c.req.valid("json");
    const db = drizzle(c.env.DB);

    if (body.isDefault) {
      await db.update(translationSources).set({ isDefault: 0 });
    }

    const [created] = await db
      .insert(translationSources)
      .values({
        name: body.name.trim(),
        shortName: body.shortName?.trim() || null,
        author: body.author?.trim() || null,
        language: body.language?.trim() || "th",
        description: body.description?.trim() || null,
        isDefault: body.isDefault ? 1 : 0,
      })
      .returning();

    return c.json({ success: true as const, data: created as any }, 201);
  }
);

// ─── PUT /admin/sources/:id ───────────────────────────────────────────────────

admin.openapi(
  createRoute({
    method: "put",
    path: "/sources/{id}",
    tags: ["Admin"],
    summary: "Update a translation source",
    security: [{ bearerAuth: [] }],
    request: {
      params: IdParamSchema,
      body: {
        content: { "application/json": { schema: SourceUpdateBodySchema } },
        required: true,
      },
    },
    responses: {
      200: {
        content: {
          "application/json": {
            schema: z.object({ success: z.literal(true), data: TranslationSourceSchema }),
          },
        },
        description: "Source updated",
      },
      401: {
        content: { "application/json": { schema: ErrorSchema } },
        description: "Unauthorized",
      },
      403: {
        content: { "application/json": { schema: ErrorSchema } },
        description: "Admin access required",
      },
      404: {
        content: { "application/json": { schema: ErrorSchema } },
        description: "Source not found",
      },
    },
  }),
  async (c) => {
    const { id } = c.req.valid("param");
    const numericId = parseInt(id);
    const db = drizzle(c.env.DB);

    const [existing] = await db
      .select()
      .from(translationSources)
      .where(eq(translationSources.id, numericId))
      .limit(1);

    if (!existing) {
      return c.json({ success: false as const, message: "Source not found" }, 404);
    }

    const body = c.req.valid("json");

    if (body.isDefault) {
      await db.update(translationSources).set({ isDefault: 0 });
    }

    const [updated] = await db
      .update(translationSources)
      .set({
        ...(body.name !== undefined && { name: body.name.trim() }),
        ...(body.shortName !== undefined && { shortName: body.shortName?.trim() || null }),
        ...(body.author !== undefined && { author: body.author?.trim() || null }),
        ...(body.language !== undefined && { language: body.language.trim() }),
        ...(body.description !== undefined && { description: body.description?.trim() || null }),
        ...(body.isDefault !== undefined && { isDefault: body.isDefault ? 1 : 0 }),
      })
      .where(eq(translationSources.id, numericId))
      .returning();

    return c.json({ success: true as const, data: updated as any }, 200);
  }
);

// ─── DELETE /admin/sources/:id ────────────────────────────────────────────────

admin.openapi(
  createRoute({
    method: "delete",
    path: "/sources/{id}",
    tags: ["Admin"],
    summary: "Delete a translation source (fails if it has verse translations)",
    security: [{ bearerAuth: [] }],
    request: { params: IdParamSchema },
    responses: {
      200: {
        content: { "application/json": { schema: MessageSchema } },
        description: "Source deleted",
      },
      400: {
        content: { "application/json": { schema: ErrorSchema } },
        description: "Source has verse translations and cannot be deleted",
      },
      401: {
        content: { "application/json": { schema: ErrorSchema } },
        description: "Unauthorized",
      },
      403: {
        content: { "application/json": { schema: ErrorSchema } },
        description: "Admin access required",
      },
      404: {
        content: { "application/json": { schema: ErrorSchema } },
        description: "Source not found",
      },
    },
  }),
  async (c) => {
    const { id } = c.req.valid("param");
    const numericId = parseInt(id);
    const db = drizzle(c.env.DB);

    const [existing] = await db
      .select()
      .from(translationSources)
      .where(eq(translationSources.id, numericId))
      .limit(1);

    if (!existing) {
      return c.json({ success: false as const, message: "Source not found" }, 404);
    }

    const count = await c.env.DB.prepare(
      "SELECT COUNT(*) AS n FROM verse_translations WHERE source_id = ?"
    )
      .bind(numericId)
      .first<{ n: number }>();

    if (count && count.n > 0) {
      return c.json(
        {
          success: false as const,
          message: `Cannot delete: source has ${count.n} verse translation(s)`,
        },
        400
      );
    }

    await db.delete(translationSources).where(eq(translationSources.id, numericId));
    return c.json({ success: true as const, message: "Source deleted" }, 200);
  }
);

export default admin;
