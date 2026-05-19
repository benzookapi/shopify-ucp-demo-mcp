import { getBearerToken } from './auth.js';
import { UCP_AGENT_PROFILE } from './ucp-config.js';

// Checkout MCP endpoint is per-shop: https://{shop-domain}/api/ucp/mcp
function checkoutMcpUrl(shopDomain: string): string {
  const host = shopDomain.includes('.')
    ? shopDomain
    : `${shopDomain}.myshopify.com`;
  return `https://${host}/api/ucp/mcp`;
}

let requestId = 0;

async function callCheckoutMcp(
  shopDomain: string,
  toolName: string,
  args: Record<string, unknown>
) {
  const token = await getBearerToken();
  const url = checkoutMcpUrl(shopDomain);

  const body = {
    jsonrpc: '2.0',
    method: 'tools/call',
    params: { name: toolName, arguments: args },
    id: ++requestId,
  };

  const response = await fetch(url, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${token}`,
    },
    body: JSON.stringify(body),
  });

  if (!response.ok) {
    const text = await response.text();
    throw new Error(`Checkout MCP error (${response.status}): ${text}`);
  }

  const json = (await response.json()) as {
    result?: {
      content?: Array<{ type: string; text: string }>;
      structuredContent?: unknown;
    };
    error?: { code: number; message: string };
  };

  if (json.error) {
    throw new Error(`Checkout MCP tool error: ${json.error.message}`);
  }

  // Prefer structuredContent as per Shopify docs, fall back to text content
  if (json.result?.structuredContent) {
    return json.result.structuredContent;
  }

  const textContent = json.result?.content?.find((c) => c.type === 'text');
  if (textContent) {
    return JSON.parse(textContent.text);
  }

  throw new Error('No content in Checkout MCP response');
}

// UCP spec: line_items use item.id (not variant_id at top level)
export interface LineItem {
  variant_id: string;   // kept for caller convenience; mapped to item.id in request
  quantity: number;
}

export interface BuyerInfo {
  email?: string;
  first_name?: string;
  last_name?: string;
  phone?: string;
}

// UCP spec uses schema.org-style address fields
export interface Address {
  first_name?: string;
  last_name?: string;
  street_address: string;       // maps to street_address (not address1)
  address2?: string;
  address_locality: string;     // city
  address_region?: string;      // state/province
  postal_code: string;          // zip
  address_country: string;      // 2-letter ISO country code
  phone?: string;
}

export interface FulfillmentInfo {
  destinations?: Address[];
  shipping_method_handle?: string;
}

// Convert LineItem[] to UCP spec format: [{ quantity, item: { id } }]
function toUcpLineItems(items: LineItem[]): unknown[] {
  return items.map((li) => ({
    quantity: li.quantity,
    item: { id: li.variant_id },
  }));
}

// Build fulfillment object per UCP spec
function toUcpFulfillment(info: FulfillmentInfo): unknown {
  const result: Record<string, unknown> = {};
  if (info.destinations && info.destinations.length > 0) {
    result.methods = [{ type: 'shipping', destinations: info.destinations }];
  }
  if (info.shipping_method_handle) {
    result.shipping_method_handle = info.shipping_method_handle;
  }
  return result;
}

export async function createCheckout(
  shopDomain: string,
  params: {
    currency: string;
    line_items: LineItem[];
    buyer?: BuyerInfo;
    fulfillment?: FulfillmentInfo;
  }
) {
  const args: Record<string, unknown> = {
    meta: { 'ucp-agent': { profile: UCP_AGENT_PROFILE } },
    checkout: {
      currency: params.currency,
      line_items: toUcpLineItems(params.line_items),
      ...(params.buyer && { buyer: params.buyer }),
      ...(params.fulfillment && { fulfillment: toUcpFulfillment(params.fulfillment) }),
    },
  };

  return callCheckoutMcp(shopDomain, 'create_checkout', args);
}

// UCP update_checkout uses PUT semantics: the request body fully replaces
// the checkout state. Any field omitted from the payload is dropped.
// To preserve fields not being changed, we fetch current state with
// get_checkout and merge the diff before submitting.
export async function getCheckout(shopDomain: string, checkoutId: string) {
  const args: Record<string, unknown> = {
    id: checkoutId,
    meta: { 'ucp-agent': { profile: UCP_AGENT_PROFILE } },
  };

  return callCheckoutMcp(shopDomain, 'get_checkout', args);
}

// Merge incoming changes into the existing checkout payload from get_checkout.
// Returns the merged checkout object to send to update_checkout.
function mergeCheckout(
  existing: Record<string, unknown> | undefined,
  updates: {
    buyer?: BuyerInfo;
    fulfillment?: FulfillmentInfo;
    line_items?: LineItem[];
  }
): Record<string, unknown> {
  const base = existing ?? {};
  const merged: Record<string, unknown> = { ...base };

  // line_items: full replacement when supplied (caller already builds the full list)
  if (updates.line_items) {
    merged.line_items = toUcpLineItems(updates.line_items);
  }

  // buyer: shallow merge over existing buyer
  if (updates.buyer) {
    const existingBuyer = (base.buyer as Record<string, unknown> | undefined) ?? {};
    merged.buyer = { ...existingBuyer, ...updates.buyer };
  }

  // fulfillment: replace methods/handle when supplied
  if (updates.fulfillment) {
    const incoming = toUcpFulfillment(updates.fulfillment) as Record<string, unknown>;
    const existingFulfillment = (base.fulfillment as Record<string, unknown> | undefined) ?? {};
    merged.fulfillment = { ...existingFulfillment, ...incoming };
  }

  return merged;
}

export async function updateCheckout(
  shopDomain: string,
  checkoutId: string,
  updates: {
    buyer?: BuyerInfo;
    fulfillment?: FulfillmentInfo;
    line_items?: LineItem[];
  }
) {
  // Fetch current checkout state so we can PUT a full payload (UCP spec).
  // If get_checkout fails we still attempt the update with just the supplied
  // fields — degraded but better than failing the whole call.
  let existingCheckout: Record<string, unknown> | undefined;
  try {
    const current = (await getCheckout(shopDomain, checkoutId)) as Record<string, unknown>;
    existingCheckout = (current?.checkout as Record<string, unknown> | undefined) ?? current;
  } catch (err) {
    console.error('[checkout] get_checkout failed, proceeding with partial update:', err);
  }

  const checkout = mergeCheckout(existingCheckout, updates);

  const args: Record<string, unknown> = {
    id: checkoutId,
    meta: { 'ucp-agent': { profile: UCP_AGENT_PROFILE } },
    checkout,
  };

  return callCheckoutMcp(shopDomain, 'update_checkout', args);
}

export async function completeCheckout(
  shopDomain: string,
  checkoutId: string,
  idempotencyKey: string,
  payment?: Record<string, unknown>
) {
  const args: Record<string, unknown> = {
    id: checkoutId,
    meta: {
      'ucp-agent': { profile: UCP_AGENT_PROFILE },
      'idempotency-key': idempotencyKey,
    },
    ...(payment && { checkout: { payment } }),
  };

  return callCheckoutMcp(shopDomain, 'complete_checkout', args);
}

// UCP spec: cancel_checkout requires meta.idempotency-key so retries are safe.
export async function cancelCheckout(
  shopDomain: string,
  checkoutId: string,
  idempotencyKey: string,
) {
  const args: Record<string, unknown> = {
    id: checkoutId,
    meta: {
      'ucp-agent': { profile: UCP_AGENT_PROFILE },
      'idempotency-key': idempotencyKey,
    },
  };

  return callCheckoutMcp(shopDomain, 'cancel_checkout', args);
}
