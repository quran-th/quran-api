import { OpenAPIHono, createRoute, z } from "@hono/zod-openapi";
import { drizzle } from "drizzle-orm/d1";
import { and, eq } from "drizzle-orm";
import { contributors } from "../db/schema";
import { hashPassword } from "../utils/crypto";
import { signToken } from "../utils/jwt";
import { ErrorSchema, LoginResponseSchema } from "../openapi/schemas";

type Bindings = {
  DB: D1Database;
  JWT_SECRET: string;
  INTERNAL_KEY?: string;
};

const internal = new OpenAPIHono<{ Bindings: Bindings }>();

const sha256 = async (value: string) =>
  crypto.subtle.digest("SHA-256", new TextEncoder().encode(value));

// No CORS is served for /internal (see index.ts); the key is the guard.
// Responses are never cacheable. Fails closed when INTERNAL_KEY is unset or empty. Digests give equal-length inputs
// for the constant-time comparison.
internal.use("/*", async (c, next) => {
  c.header("Cache-Control", "no-store");
  const expected = c.env.INTERNAL_KEY;
  const provided = c.req.header("X-Internal-Key");
  if (!expected || !provided) {
    return c.json({ success: false as const, message: "Unauthorized" }, 401);
  }
  const [a, b] = await Promise.all([sha256(provided), sha256(expected)]);
  if (!crypto.subtle.timingSafeEqual(a, b)) {
    return c.json({ success: false as const, message: "Unauthorized" }, 401);
  }
  await next();
});

const InternalContributorBodySchema = z
  .object({
    email: z.string().email(),
    password: z.string().min(8),
    displayName: z.string().trim().min(1),
  })
  .openapi("InternalContributorBody");

internal.openapi(
  createRoute({
    method: "post",
    path: "/contributors",
    tags: ["Internal"],
    hide: true,
    summary: "Create a contributor (service-to-service, X-Internal-Key)",
    request: {
      body: {
        content: {
          "application/json": { schema: InternalContributorBodySchema },
        },
        required: true,
      },
    },
    responses: {
      201: {
        content: { "application/json": { schema: LoginResponseSchema } },
        description: "Contributor created",
      },
      401: {
        content: { "application/json": { schema: ErrorSchema } },
        description: "Missing or invalid internal key",
      },
      409: {
        content: { "application/json": { schema: ErrorSchema } },
        description: "Email already exists",
      },
    },
  }),
  async (c) => {
    const body = c.req.valid("json");
    const db = drizzle(c.env.DB);
    const email = body.email.trim().toLowerCase();

    const [existing] = await db
      .select({ id: contributors.id })
      .from(contributors)
      .where(eq(contributors.email, email))
      .limit(1);

    const duplicate = {
      success: false as const,
      message: "Email already exists",
    };
    if (existing) return c.json(duplicate, 409);

    const passwordHash = await hashPassword(body.password);

    let created;
    try {
      [created] = await db
        .insert(contributors)
        .values({
          email,
          displayName: body.displayName,
          role: "contributor",
          passwordHash,
          isActive: true,
        })
        .returning();
    } catch {
      // Lost a race on the unique email index.
      return c.json(duplicate, 409);
    }

    const token = await signToken(
      { sub: created.id, email: created.email, role: "contributor" },
      c.env.JWT_SECRET,
    );

    return c.json(
      {
        success: true as const,
        token,
        contributor: {
          id: created.id,
          email: created.email,
          displayName: created.displayName,
          role: "contributor" as const,
        },
      },
      201,
    );
  },
);

const InternalPasswordBodySchema = z
  .object({ password: z.string().min(8).max(200) })
  .openapi("InternalPasswordBody");

const InternalPasswordParamsSchema = z.object({
  id: z.coerce.number().int().positive(),
});

internal.openapi(
  createRoute({
    method: "put",
    path: "/contributors/{id}/password",
    tags: ["Internal"],
    hide: true,
    summary:
      "Set a contributor's password (service-to-service, X-Internal-Key)",
    request: {
      params: InternalPasswordParamsSchema,
      body: {
        content: {
          "application/json": { schema: InternalPasswordBodySchema },
        },
        required: true,
      },
    },
    responses: {
      200: {
        content: { "application/json": { schema: LoginResponseSchema } },
        description: "Password set",
      },
      401: {
        content: { "application/json": { schema: ErrorSchema } },
        description: "Missing or invalid internal key",
      },
      404: {
        content: { "application/json": { schema: ErrorSchema } },
        description: "Contributor not found or inactive",
      },
    },
  }),
  async (c) => {
    const { id } = c.req.valid("param");
    const body = c.req.valid("json");
    const db = drizzle(c.env.DB);

    const [updated] = await db
      .update(contributors)
      .set({ passwordHash: await hashPassword(body.password) })
      // Same rule as login: an inactive account must not get a token back.
      .where(and(eq(contributors.id, id), eq(contributors.isActive, true)))
      .returning();
    if (!updated) {
      return c.json(
        {
          success: false as const,
          message: "Contributor not found or inactive",
        },
        404,
      );
    }

    // Sign with the stored role so an admin who resets keeps admin rights.
    const role: "admin" | "contributor" =
      updated.role === "admin" ? "admin" : "contributor";
    const token = await signToken(
      { sub: updated.id, email: updated.email, role },
      c.env.JWT_SECRET,
    );

    return c.json(
      {
        success: true as const,
        token,
        contributor: {
          id: updated.id,
          email: updated.email,
          displayName: updated.displayName,
          role,
        },
      },
      200,
    );
  },
);

const ChangelogSummarySchema = z
  .object({
    success: z.literal(true),
    maxId: z.number().int(),
    count: z.number().int(),
  })
  .openapi("InternalChangelogSummary");

internal.openapi(
  createRoute({
    method: "get",
    path: "/changelog/summary",
    tags: ["Internal"],
    hide: true,
    summary:
      "Changelog max id and row count (service-to-service, X-Internal-Key)",
    responses: {
      200: {
        content: { "application/json": { schema: ChangelogSummarySchema } },
        description: "Changelog summary",
      },
      401: {
        content: { "application/json": { schema: ErrorSchema } },
        description: "Missing or invalid internal key",
      },
    },
  }),
  async (c) => {
    const row = await c.env.DB.prepare(
      "SELECT COALESCE(MAX(id), 0) AS maxId, COUNT(*) AS count FROM changelog",
    ).first<{ maxId: number; count: number }>();

    return c.json(
      {
        success: true as const,
        maxId: row?.maxId ?? 0,
        count: row?.count ?? 0,
      },
      200,
    );
  },
);

const ReportStatusSchema = z.enum(["open", "resolved", "dismissed"]);

const InternalReportsQuerySchema = z.object({
  status: ReportStatusSchema.default("open"),
  limit: z.coerce.number().int().min(1).max(100).default(50),
});

const InternalReportsResponseSchema = z
  .object({
    success: z.literal(true),
    data: z.array(
      z.object({
        id: z.number().int(),
        surahNumber: z.number().int().nullable(),
        verseNumber: z.number().int().nullable(),
        sourceId: z.number().int().nullable(),
        verseTranslationId: z.number().int().nullable(),
        suggestedText: z.string(),
        contactName: z.string().nullable(),
        createdAt: z.number().int().nullable(),
        currentText: z.string().nullable(),
      }),
    ),
  })
  .openapi("InternalReportsResponse");

internal.openapi(
  createRoute({
    method: "get",
    path: "/reports",
    tags: ["Internal"],
    hide: true,
    summary:
      "Detailed issue reports with a suggested text (service-to-service, X-Internal-Key)",
    request: { query: InternalReportsQuerySchema },
    responses: {
      200: {
        content: {
          "application/json": { schema: InternalReportsResponseSchema },
        },
        description: "Reports, oldest first",
      },
      401: {
        content: { "application/json": { schema: ErrorSchema } },
        description: "Missing or invalid internal key",
      },
    },
  }),
  async (c) => {
    const { status, limit } = c.req.valid("query");

    const { results } = await c.env.DB.prepare(
      `SELECT r.id AS id,
              COALESCE(r.surah_number, vt.surah_number) AS surahNumber,
              COALESCE(r.verse_number, vt.verse_number) AS verseNumber,
              COALESCE(r.source_id, vt.source_id,
                (SELECT id FROM translation_sources WHERE is_default = 1 ORDER BY id LIMIT 1)) AS sourceId,
              r.verse_translation_id AS verseTranslationId,
              r.suggested_text AS suggestedText,
              r.contact_name AS contactName,
              r.created_at AS createdAt,
              CASE WHEN r.verse_translation_id IS NOT NULL
                THEN vt.translation_text
                ELSE (SELECT t.translation_text FROM verse_translations t
                      WHERE t.source_id = COALESCE(r.source_id,
                              (SELECT id FROM translation_sources WHERE is_default = 1 ORDER BY id LIMIT 1))
                        AND t.surah_number = r.surah_number
                        AND t.verse_number = r.verse_number
                      LIMIT 1)
              END AS currentText
       FROM issue_reports r
       LEFT JOIN verse_translations vt ON vt.id = r.verse_translation_id
       WHERE r.report_type = 'detailed'
         AND TRIM(COALESCE(r.suggested_text, ''), ' ' || char(9, 10, 13)) <> ''
         AND r.status = ?
       ORDER BY r.created_at ASC, r.id ASC
       LIMIT ?`,
    )
      .bind(status, limit)
      .all<{
        id: number;
        surahNumber: number | null;
        verseNumber: number | null;
        sourceId: number | null;
        verseTranslationId: number | null;
        suggestedText: string;
        contactName: string | null;
        createdAt: number | null;
        currentText: string | null;
      }>();

    return c.json({ success: true as const, data: results }, 200);
  },
);

const InternalReportStatusBodySchema = z
  .object({ status: z.enum(["resolved", "dismissed"]) })
  .openapi("InternalReportStatusBody");

const InternalReportStatusParamsSchema = z.object({
  id: z.coerce.number().int().positive(),
});

const InternalReportStatusResponseSchema = z
  .object({
    success: z.literal(true),
    id: z.number().int(),
    status: ReportStatusSchema,
  })
  .openapi("InternalReportStatusResponse");

internal.openapi(
  createRoute({
    method: "put",
    path: "/reports/{id}/status",
    tags: ["Internal"],
    hide: true,
    summary:
      "Resolve or dismiss an open issue report (service-to-service, X-Internal-Key)",
    request: {
      params: InternalReportStatusParamsSchema,
      body: {
        content: {
          "application/json": { schema: InternalReportStatusBodySchema },
        },
        required: true,
      },
    },
    responses: {
      200: {
        content: {
          "application/json": { schema: InternalReportStatusResponseSchema },
        },
        description: "Status set (or already at the requested status)",
      },
      401: {
        content: { "application/json": { schema: ErrorSchema } },
        description: "Missing or invalid internal key",
      },
      404: {
        content: { "application/json": { schema: ErrorSchema } },
        description: "Report not found",
      },
      409: {
        content: { "application/json": { schema: ErrorSchema } },
        description: "Report is no longer open",
      },
    },
  }),
  async (c) => {
    const { id } = c.req.valid("param");
    const { status } = c.req.valid("json");

    const row = await c.env.DB.prepare(
      "SELECT status FROM issue_reports WHERE id = ?",
    )
      .bind(id)
      .first<{ status: string }>();
    if (!row) {
      return c.json(
        { success: false as const, message: "Report not found" },
        404,
      );
    }
    // Retrying the same transition is harmless.
    if (row.status === status) {
      return c.json({ success: true as const, id, status }, 200);
    }
    if (row.status !== "open") {
      return c.json(
        { success: false as const, message: "Report is no longer open" },
        409,
      );
    }

    await c.env.DB.prepare(
      "UPDATE issue_reports SET status = ? WHERE id = ? AND status = 'open'",
    )
      .bind(status, id)
      .run();

    return c.json({ success: true as const, id, status }, 200);
  },
);

export default internal;
