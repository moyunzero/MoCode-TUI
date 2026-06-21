/**
 * Polar.sh integration for credits billing (Phase 10).
 *
 * Clerk `userId` is the Polar `externalCustomerId` — no separate customer sync.
 *
 * - Checkout / portal URLs for CLI `/upgrade` and `/usage`
 * - Balance reads via credits meter before billable routes
 * - Usage ingest after each completed or interrupted assistant message
 *
 * Required env: POLAR_ACCESS_TOKEN, POLAR_PRODUCT_ID, POLAR_CREDITS_METER_ID.
 * Optional: POLAR_SERVER (`sandbox` default | `production`).
 */
import { Polar } from "@polar-sh/sdk";

type PolarServer = "sandbox" | "production";

function getRequiredEnv(name: string) {
  const value = process.env[name];
  if (!value) {
    throw new Error(`${name} environment variable is required`);
  }
  return value;
}

export function getPolarAccessToken() {
  return getRequiredEnv("POLAR_ACCESS_TOKEN");
}

/** Credits pack product shown on Polar checkout (configured in Polar dashboard). */
export function getPolarProductId() {
  return getRequiredEnv("POLAR_PRODUCT_ID");
}

/** Meter whose balance we gate on and decrement via `mocode_usage` events. */
export function getPolarCreditsMeterId() {
  return getRequiredEnv("POLAR_CREDITS_METER_ID");
}

export function getPolarServer(): PolarServer {
  const server = process.env.POLAR_SERVER;
  if (!server) {
    return "sandbox";
  }

  if (server !== "sandbox" && server !== "production") {
    throw new Error("POLAR_SERVER must be either 'sandbox' or 'production'");
  }

  return server;
}

/** Singleton SDK client; token and server are read once at module load. */
const polar = new Polar({
  accessToken: getPolarAccessToken(),
  server: getPolarServer(),
});

function hasStatusCode(error: unknown): error is { statusCode: number } {
  return (
    typeof error === "object" &&
    error !== null &&
    "statusCode" in error &&
    typeof error.statusCode === "number"
  );
}

type CreateCheckoutUrlParams = {
  customerExternalId: string;
  requestUrl: string;
};

/** Creates a one-time checkout link; success redirects to GET /billing/success. */
export async function createCheckoutUrl({
  customerExternalId,
  requestUrl,
}: CreateCheckoutUrlParams) {
  const result = await polar.checkouts.create({
    products: [getPolarProductId()],
    successUrl: new URL("/billing/success", requestUrl).toString(),
    externalCustomerId: customerExternalId,
    metadata: { source: "mocode-cli" },
  });

  return result.url;
};

/** Customer portal for invoices, payment method, and usage history. */
export async function createCustomerPortalUrl({
  customerExternalId,
  requestUrl,
}: CreateCheckoutUrlParams) {
  const result = await polar.customerSessions.create({
    externalCustomerId: customerExternalId,
    returnUrl: new URL("/billing/success", requestUrl).toString(),
  });

  return result.customerPortalUrl;
};

/**
 * Reads remaining credits from the configured Polar meter.
 * Returns 0 when the customer does not exist yet (404) — treated as no balance.
 */
export async function getAvailableCreditsBalance(customerExternalId: string) {
  try {
    const customerState = await polar.customers.getStateExternal({
      externalId: customerExternalId,
    });

    const matchingMeters = customerState.activeMeters.filter(
      (meter) => meter.meterId === getPolarCreditsMeterId(),
    );

    if (matchingMeters.length > 1) {
      throw new Error("Expected exactly one matching Polar credits meter");
    }

    const creditsMeter = matchingMeters[0];
    return creditsMeter?.balance ?? 0;
  } catch (error) {
    if (hasStatusCode(error) && error.statusCode === 404) {
      return 0;
    }

    throw error;
  }
};

type IngestAiUsageParams = {
  externalCustomerId: string;
  /** Idempotency key — one event per assistant message (`chat-message:{id}`). */
  eventId: string;
  credits: number;
};

/**
 * Reports billable usage to Polar. Meter rules map `metadata.credits` to balance.
 * No-op when credits <= 0 (e.g. free-tier models with zero estimated cost).
 */
export async function ingestAiUsage({ 
  externalCustomerId, 
  eventId, 
  credits
}: IngestAiUsageParams) {
  if (credits <= 0) {
    return;
  }

  await polar.events.ingest({
    events: [
      {
        name: "mocode_usage",
        externalId: eventId,
        externalCustomerId,
        metadata: { credits },
      },
    ],
  });
};
