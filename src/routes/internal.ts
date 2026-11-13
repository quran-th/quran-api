import { OpenAPIHono, createRoute, z } from "@hono/zod-openapi";
import { drizzle } from "drizzle-orm/d1";
import { eq } from "drizzle-orm";
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

// The global wildcard cors() exposes this route to browsers, so the key is its only guard.
// Fails closed when INTERNAL_KEY is unset or empty. Digests give equal-length inputs
// for the constant-time comparison.
internal.use("/*", async (c, next) => {
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

export default internal;
