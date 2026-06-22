import { getBearerToken } from './auth.js';
import { UCP_AGENT_PROFILE } from './ucp-config.js';

const CATALOG_MCP_URL = 'https://discover.shopifyapps.com/global/mcp';

let requestId = 0;

function nextId() {
  return ++requestId;
}

function redactCatalogLogValue(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map(redactCatalogLogValue);
  }
  if (!value || typeof value !== 'object') return value;

  const record = value as Record<string, unknown>;
  const out: Record<string, unknown> = {};
  for (const [key, child] of Object.entries(record)) {
    if (key === 'data' && typeof child === 'string' && record.content_type) {
      out[key] = `<base64:${child.length} chars>`;
    } else {
      out[key] = redactCatalogLogValue(child);
    }
  }
  return out;
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
  console.error(`[catalog] ${toolName} args:`, JSON.stringify(redactCatalogLogValue(argsWithMeta)));

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
  query?: string;
  context: string;
  ships_to?: string;          // ISO 2-letter country code (destination)
  ships_from?: string;        // ISO 2-letter country code (origin)
  available_for_sale?: boolean;
  min_price?: number;
  max_price?: number;
  limit?: number;
  similar_image?: {
    content_type: string;
    data: string;
  };
}

export interface CatalogSearchSummary {
  totalOffers: number;
  offersWithProducts: number;
  offersWithVariants: number;
  offersWithCheckoutUrl: number;
  offersWithProductPageUrl: number;
  currencies: string[];
  merchantHosts: string[];
  productTitles: string[];
  responseShape: 'offers' | 'unknown';
}

export interface CatalogProductDetailsSummary {
  offerCount: number;
  usesProductsSchema: boolean;
  usesVariantsSchema: boolean;
  offersWithCheckoutUrl: number;
  currencies: string[];
  merchantHosts: string[];
  productTitle?: string;
}

function hostFromUrl(value: unknown): string | undefined {
  if (typeof value !== 'string' || value.length === 0) return undefined;
  try {
    return new URL(value).host;
  } catch {
    return undefined;
  }
}

function currencyFromPrice(value: unknown): string | undefined {
  if (!value || typeof value !== 'object') return undefined;
  const price = value as Record<string, unknown>;
  const currency = price.currencyCode ?? price.currency;
  return typeof currency === 'string' && currency.length > 0 ? currency : undefined;
}

function uniqueSorted(values: Array<string | undefined>): string[] {
  return [...new Set(values.filter((v): v is string => Boolean(v)))].sort();
}

export function buildSearchGlobalProductsArgs(params: SearchProductsParams): Record<string, unknown> {
  const savedCatalog = process.env.SHOPIFY_CATALOG_ID;
  return {
    ...(params.query && { query: params.query }),
    context: params.context,
    ...(params.similar_image && {
      like: [
        {
          image: {
            content_type: params.similar_image.content_type,
            data: params.similar_image.data,
          },
        },
      ],
    }),
    ...(params.ships_to && { ships_to: params.ships_to }),
    ...(params.ships_from && { ships_from: params.ships_from }),
    ...(params.available_for_sale !== undefined && { available_for_sale: params.available_for_sale }),
    ...(params.min_price !== undefined && { min_price: params.min_price }),
    ...(params.max_price !== undefined && { max_price: params.max_price }),
    ...(params.limit !== undefined && { limit: params.limit }),
    ...(savedCatalog && { saved_catalog: savedCatalog }),
  };
}

export function summarizeCatalogSearchResult(result: unknown): CatalogSearchSummary {
  const raw = result as Record<string, unknown> | null;
  const offers = (Array.isArray(raw?.offers) ? raw.offers : []) as Record<string, unknown>[];
  const currencies: Array<string | undefined> = [];
  const merchantHosts: Array<string | undefined> = [];
  let offersWithProducts = 0;
  let offersWithVariants = 0;
  let offersWithCheckoutUrl = 0;
  let offersWithProductPageUrl = 0;

  for (const offer of offers) {
    const products = (offer.products as Record<string, unknown>[] | undefined) ?? [];
    const variants = (offer.variants as Record<string, unknown>[] | undefined) ?? [];
    if (products.length > 0) offersWithProducts += 1;
    if (variants.length > 0) offersWithVariants += 1;
    if (typeof offer.url === 'string') offersWithProductPageUrl += 1;

    const childOffers = products.length > 0 ? products : variants;
    if (childOffers.some((child) => typeof child.checkoutUrl === 'string')) {
      offersWithCheckoutUrl += 1;
    }

    for (const child of childOffers) {
      currencies.push(currencyFromPrice(child.price));
      const shop = child.shop as Record<string, unknown> | undefined;
      merchantHosts.push(
        hostFromUrl(shop?.onlineStoreUrl) ??
          hostFromUrl(child.variantUrl) ??
          hostFromUrl(child.checkoutUrl)
      );
    }

    const priceRange = offer.priceRange as Record<string, Record<string, unknown>> | undefined;
    currencies.push(currencyFromPrice(priceRange?.min));
  }

  return {
    totalOffers: offers.length,
    offersWithProducts,
    offersWithVariants,
    offersWithCheckoutUrl,
    offersWithProductPageUrl,
    currencies: uniqueSorted(currencies),
    merchantHosts: uniqueSorted(merchantHosts),
    productTitles: offers
      .map((offer) => offer.title)
      .filter((title): title is string => typeof title === 'string'),
    responseShape: Array.isArray(raw?.offers) ? 'offers' : 'unknown',
  };
}

export function summarizeProductDetailsResult(result: unknown): CatalogProductDetailsSummary {
  const raw = result as Record<string, unknown> | null;
  const product = ((raw?.product as Record<string, unknown> | undefined) ?? raw ?? {}) as Record<string, unknown>;
  const products = (product.products as Record<string, unknown>[] | undefined) ?? [];
  const variants = (product.variants as Record<string, unknown>[] | undefined) ?? [];
  const offers = products.length > 0 ? products : variants;
  const currencies: Array<string | undefined> = [];
  const merchantHosts: Array<string | undefined> = [];

  for (const offer of offers) {
    currencies.push(currencyFromPrice(offer.price));
    const shop = offer.shop as Record<string, unknown> | undefined;
    merchantHosts.push(
      hostFromUrl(shop?.onlineStoreUrl) ??
        hostFromUrl(offer.variantUrl) ??
        hostFromUrl(offer.checkoutUrl)
    );
  }

  return {
    offerCount: offers.length,
    usesProductsSchema: products.length > 0,
    usesVariantsSchema: products.length === 0 && variants.length > 0,
    offersWithCheckoutUrl: offers.filter((offer) => typeof offer.checkoutUrl === 'string').length,
    currencies: uniqueSorted(currencies),
    merchantHosts: uniqueSorted(merchantHosts),
    productTitle: typeof product.title === 'string' ? product.title : undefined,
  };
}

export async function searchGlobalProducts(params: SearchProductsParams) {
  const args = buildSearchGlobalProductsArgs(params);
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
