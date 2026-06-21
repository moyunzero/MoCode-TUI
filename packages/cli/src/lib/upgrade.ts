/**
 * CLI billing helpers (Phase 10).
 *
 * Calls authenticated API routes and opens the returned Polar URL in the system browser.
 * Used by slash commands `/upgrade` (checkout) and `/usage` (customer portal).
 */
import open from "open";
import { apiClient } from "./api-client";
import { getErrorMessage } from "./http-errors";

/** POST /billing/checkout → open Polar credits purchase page. */
export async function openUpgradeCheckout() {
  const response = await apiClient.billing.checkout.$post();

  if (response.ok) {
    const data = await response.json();
    await open(data.url);
    return;
  }

  throw new Error(await getErrorMessage(response));
};

/** POST /billing/portal → open Polar customer portal (invoices, usage, payment method). */
export async function openBillingPortal() {
  const response = await apiClient.billing.portal.$post();

  if (response.ok) {
    const data = await response.json();
    await open(data.url);
    return;
  }

  throw new Error(await getErrorMessage(response));
};
