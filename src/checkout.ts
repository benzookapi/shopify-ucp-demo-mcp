import { getBearerToken } from './auth.js';

// Checkout MCP endpoint is per-shop: https://{shop-domain}/api/ucp/mcp
function checkoutMcpUrl(shopDomain: string): string {
  const host = shopDomain.includes('.')
    ? shopDomain
    : `${shopDomain}.myshopify.com`;
  return `https://${host}/api/ucp/mcp`;
}

let requestId = 0;

const UCP_AGENT_PROFILE =
  process.env.UCP_AGENT_PROFILE ?? 'https://shopify-ucp-demo-mcp.onrender.com';

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

export interface LineItem {
  variant_id: string;
  quantity: number;
}

export interface BuyerInfo {
  email?: string;
  first_name?: string;
  last_name?: string;
  phone?: string;
}

export interface Address {
  first_name?: string;
  last_name?: string;
  address1: string;
  address2?: string;
  city: string;
  province?: string;
  zip: string;
  country_code: string;
  phone?: string;
}

export interface FulfillmentInfo {
  destination?: Address;
  shipping_method_handle?: string;
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
      line_items: params.line_items,
      ...(params.buyer && { buyer: params.buyer }),
      ...(params.fulfillment && { fulfillment: params.fulfillment }),
    },
  };

  return callCheckoutMcp(shopDomain, 'create_checkout', args);
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
  const args: Record<string, unknown> = {
    id: checkoutId,
    meta: { 'ucp-agent': { profile: UCP_AGENT_PROFILE } },
    checkout: updates,
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

export async function cancelCheckout(shopDomain: string, checkoutId: string) {
  const args: Record<string, unknown> = {
    id: checkoutId,
    meta: { 'ucp-agent': { profile: UCP_AGENT_PROFILE } },
  };

  return callCheckoutMcp(shopDomain, 'cancel_checkout', args);
}
