import { getBearerToken } from './auth.js';
import { UCP_AGENT_PROFILE } from './ucp-config.js';

const CATALOG_MCP_URL = 'https://discover.shopifyapps.com/global/mcp';

let requestId = 0;

function nextId() {
  return ++requestId;
}

// Parse MCP response — Streamable HTTP may return either plain JSON
// or a newline-delimited SSE stream ("data: {...}\n\n").
async function parseResponse(response: Response): Promise<unknown> {
  const contentType = response.headers.get('content-type') ?? '';
  const text = await response.text();

  if (contentType.includes('text/event-stream')) {
    const dataLines = text
      .split('\n')
      .filter((l) => l.startsWith('data: '))
      .map((l) => l.slice(6).trim())
      .filter(Boolean);
    if (dataLines.length === 0) {
      throw new Error(`Empty SSE stream from Catalog MCP`);
    }
    return JSON.parse(dataLines[dataLines.length - 1]);
  }

  if (!text || !text.trimStart().startsWith('{') && !text.trimStart().startsWith('[')) {
    throw new Error(`Non-JSON response from Catalog MCP: ${text.slice(0, 200)}`);
  }

  return JSON.parse(text);
}

// The Catalog MCP endpoint accepts tools/call directly without a prior
// `initialize` handshake. Measured 2026-05-19: tools/call returns 200 in
// ~390ms with no mcp-session-id header. Skipping initialize halves the
// round-trips per user request.
async function callCatalogMcp(toolName: string, args: Record<string, unknown>) {
  const token = await getBearerToken();

  // Inject meta.ucp-agent.profile required by the UCP Catalog MCP spec.
  // The current discover.shopifyapps.com endpoint accepts the flat-args shape
  // this sample uses; passing meta alongside is forward-compatible with the
  // canonical {your_catalog_url} endpoint, which requires it.
  const argsWithMeta: Record<string, unknown> = {
    meta: { 'ucp-agent': { profile: UCP_AGENT_PROFILE } },
    ...args,
  };

  const body = {
    jsonrpc: '2.0',
    method: 'tools/call',
    params: { name: toolName, arguments: argsWithMeta },
    id: nextId(),
  };

  // Debug: log the exact args being sent to Catalog MCP
  console.error(`[catalog] ${toolName} args:`, JSON.stringify(argsWithMeta));

  const response = await fetch(CATALOG_MCP_URL, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Accept: 'application/json, text/event-stream',
      Authorization: `Bearer ${token}`,
    },
    body: JSON.stringify(body),
  });

  if (!response.ok) {
    const text = await response.text();
    throw new Error(`Catalog MCP error (${response.status}): ${text}`);
  }

  const json = (await parseResponse(response)) as {
    result?: { content?: Array<{ type: string; text: string }> };
    error?: { code: number; message: string; data?: unknown };
  };

  if (json.error) {
    const detail = json.error.data ? ` | data: ${JSON.stringify(json.error.data)}` : '';
    throw new Error(
      `Catalog MCP tool error [${json.error.code}]: ${json.error.message}${detail}`
    );
  }

  const textContent = json.result?.content?.find((c) => c.type === 'text');
  if (!textContent) {
    throw new Error(`No text content in Catalog MCP response: ${JSON.stringify(json)}`);
  }

  const parsed = JSON.parse(textContent.text);
  // Debug: log response structure
  const debugInfo = toolName === 'search_global_products'
    ? `offers.length=${Array.isArray(parsed?.offers) ? parsed.offers.length : 'N/A'}`
    : `product.products.length=${Array.isArray(parsed?.product?.products) ? parsed.product.products.length : 'N/A'}`;
  console.error(`[catalog] ${toolName} response: ${debugInfo}`);

  return parsed;
}

export interface SearchProductsParams {
  query: string;
  context: string;
  ships_to?: string;          // ISO 2-letter country code (destination)
  ships_from?: string;        // ISO 2-letter country code (origin)
  available_for_sale?: boolean;
  min_price?: number;
  max_price?: number;
  limit?: number;
}

export async function searchGlobalProducts(params: SearchProductsParams) {
  const savedCatalog = process.env.SHOPIFY_CATALOG_ID;
  const args: Record<string, unknown> = {
    query: params.query,
    context: params.context,
    ...(params.ships_to && { ships_to: params.ships_to }),
    ...(params.ships_from && { ships_from: params.ships_from }),
    ...(params.available_for_sale !== undefined && { available_for_sale: params.available_for_sale }),
    ...(params.min_price !== undefined && { min_price: params.min_price }),
    ...(params.max_price !== undefined && { max_price: params.max_price }),
    ...(params.limit !== undefined && { limit: params.limit }),
    ...(savedCatalog && { saved_catalog: savedCatalog }),
  };
  return callCatalogMcp('search_global_products', args);
}

export interface GetProductDetailsParams {
  upid: string;
  context?: string;
  product_options?: Array<{ key: string; values: string[] }>;
  ships_to?: string;
  available_for_sale?: boolean;
  limit?: number;
}

// Extract Base62 ID from full GID (e.g. "gid://shopify/p/AbC123" → "AbC123").
// Accepts a bare Base62 id and returns it unchanged.
export function extractBase62(upid: string): string {
  const match = upid.match(/\/p\/([^/?#]+)/);
  return match ? match[1] : upid;
}

export async function getGlobalProductDetails(params: GetProductDetailsParams) {
  const args: Record<string, unknown> = {
    upid: extractBase62(params.upid),
    ...(params.context && { context: params.context }),
    ...(params.product_options && { product_options: params.product_options }),
    ...(params.ships_to && { ships_to: params.ships_to }),
    ...(params.available_for_sale !== undefined && { available_for_sale: params.available_for_sale }),
    ...(params.limit !== undefined && { limit: params.limit }),
  };
  return callCatalogMcp('get_global_product_details', args);
}
