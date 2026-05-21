import { AsyncLocalStorage } from 'node:async_hooks';

// Per-request context plumbed from the Express /mcp handler down into the
// outgoing Shopify Checkout MCP calls. Shopify's Checkout MCP requires a
// Shopify-Buyer-IP HTTP header with a valid IPv4 or IPv6 address when
// mutating cart state — omitting it returns HTTP 422 with
// `Missing required buyer IP header.` (observed empirically). UCP's spec
// also defines `checkout.signals["dev.ucp.buyer_ip"]` and
// `dev.ucp.user_agent` in the JSON body; we populate both for spec
// compliance and forward compatibility, but the HTTP header is what
// Shopify currently enforces on.
//
// Honest caveat: in this Remote MCP topology the IP we capture is the
// AI provider's IP (Anthropic/OpenAI/etc), not the buyer's true client
// IP — agentic commerce shifts buyer-IP collection to the AI host. For
// this demo, the provider IP is sufficient to satisfy Shopify's
// validation, which only checks that the header parses as an IP address.
// Production deployments serving real buyer traffic should pass the
// buyer's true IP.
export interface RequestContext {
  buyerIp?: string;
  userAgent?: string;
}

export const requestContext = new AsyncLocalStorage<RequestContext>();

export function getBuyerIp(): string | undefined {
  return requestContext.getStore()?.buyerIp;
}

export function getUserAgent(): string | undefined {
  return requestContext.getStore()?.userAgent;
}

// Extract the first IP from X-Forwarded-For (Render, Cloudflare, etc.
// prepend in chain order: client, proxy1, proxy2). Falls back to
// req.socket.remoteAddress when no proxy header is present.
export function extractBuyerIp(headers: Record<string, unknown>, remoteAddr?: string): string | undefined {
  const xff = headers['x-forwarded-for'];
  if (typeof xff === 'string' && xff.length > 0) {
    const first = xff.split(',')[0]?.trim();
    if (first) return first;
  }
  if (Array.isArray(xff) && xff.length > 0 && typeof xff[0] === 'string') {
    const first = xff[0].split(',')[0]?.trim();
    if (first) return first;
  }
  return remoteAddr;
}
