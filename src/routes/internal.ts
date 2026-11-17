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

export default internal;
