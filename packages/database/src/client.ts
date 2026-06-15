import "dotenv/config";
import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient } from "../generated/prisma/client";

const databaseUrl = process.env.DATABASE_URL;
if (!databaseUrl) {
    throw new Error("DATABASE_URL is not set");
}

// Prisma 6+ uses a driver adapter instead of baking the pg driver into the client.
const adapter = new PrismaPg({ connectionString: databaseUrl });

/** Shared Prisma client for the server and database package consumers. */
export const db = new PrismaClient({
    adapter,
});