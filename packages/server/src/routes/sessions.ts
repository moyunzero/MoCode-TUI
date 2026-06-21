import { Hono } from "hono";
import { zValidator } from "@hono/zod-validator";
import { z } from "zod";
// Runtime client lives in a separate export so browser/CLI bundles can import types without pulling in Prisma.
import { db } from "@mocode/database/client";
import { Role, Mode, MessageStatus } from "@mocode/database/enums";
import * as Sentry from "@sentry/hono/bun";
import type { AuthenticatedEnv } from "../middleware/require-auth.ts";
import { requireCreditsBalance } from "../middleware/require-credits-balance.ts";
import { isSupportedChatModel } from "../lib/model.ts"; 


/** POST /sessions body: session metadata plus the first user turn. */
const createSessionSchema = z.object({
    title: z.string(),
    cwd: z.string().optional(),
    initialMessage: z.object({
        role: z.enum(Role),
        content: z.string(),
        mode: z.enum(Mode),
        model: z.string().refine(isSupportedChatModel, "Invalid model"),
    }),
});

const createSessionValidator = zValidator("json", createSessionSchema,(result,c)=>{
    if(!result.success){
        // Log validation failures for observability without exposing field details to the client.
        Sentry.logger.warn("Session creation validation failed", {
            path: c.req.path,
            issues: result.error.issues.length,
        });

       return c.json({ error: result.error.message }, 400);
    }
});

/** Session CRUD scoped to the authenticated Clerk user (phase 9). */
const app = new Hono<AuthenticatedEnv>()
    .get("/", async (c)=>{
        const userId = c.get("userId");
        const sessions = await db.session.findMany({
            where: {
                userId,
            },
            orderBy: {
                createdAt: "desc",
            },
            select: {
                id: true,
                title: true,
                createdAt: true,
            },
        });

        // Structured log for session list traffic and result size.
        Sentry.logger.info("Listed sessions", {
            count: sessions.length,
        });

        return c.json(sessions);
    })
    .get("/:id", async (c) => {
        const id = c.req.param("id");
        const userId = c.get("userId");
        // Composite key prevents cross-user session access by id guessing.
        const session = await db.session.findUnique({
            where: {
                id,
                userId,
            },
            include: {
                messages: {
                    orderBy: {
                        createdAt: "asc",
                    },
                },
            },
        });

        if(!session){
            // 404 is expected during stale IDs; warn-level keeps it visible without treating it as a server fault.
            Sentry.logger.warn("Session not found", {
                sessionId: id,
                userId: "mock-user",
            });
            return c.json({ error: "Session not found" }, 404);
        }


        // Include message count to spot unusually large payloads early.
        Sentry.logger.info("Loaded session", {
            sessionId: session.id,
            messageCount: session.messages.length,
        });

        return c.json(session);
    })
    /** Phase 10: require positive Polar credits before creating a session (initial message is billable). */
    .post("/", requireCreditsBalance, createSessionValidator, async (c) => {
        const { initialMessage, ...data } = c.req.valid("json");
        const userId = c.get("userId");
        const session = await db.session.create({
            data: {
                ...data,
                userId,
                messages: {
                    create: {
                        ...initialMessage,
                        status: MessageStatus.COMPLETE,
                    },
                },
            },
            include: {
                messages: true,
            },
        });

        // Audit trail for new sessions created via the API.
        Sentry.logger.info("Created session", {
            sessionId: session.id,
            title: session.title,
            cwd: session.cwd,
        });

        return c.json(session,201);
    })

export default app;