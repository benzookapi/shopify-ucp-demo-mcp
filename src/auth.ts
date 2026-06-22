const TOKEN_ENDPOINT = 'https://api.shopify.com/auth/access_token';
// Use the token lifetime when Shopify returns it, and fall back to the
// documented 60-minute lifetime for older responses that omit expires_in.
const TOKEN_TTL_MS = 60 * 60 * 1000;
const EXPIRY_BUFFER_MS = 5 * 60 * 1000;

let cachedToken: string | null = null;
let tokenExpiresAt = 0;
// Shared in-flight refresh — without this, concurrent callers seeing an
// expired token would each fire their own /auth/access_token request.
let inflight: Promise<string> | null = null;

async function fetchToken(): Promise<string> {
  const clientId = process.env.SHOPIFY_CLIENT_ID;
  const clientSecret = process.env.SHOPIFY_CLIENT_SECRET;

  if (!clientId || !clientSecret) {
    throw new Error('SHOPIFY_CLIENT_ID and SHOPIFY_CLIENT_SECRET must be set');
  }

  const response = await fetch(TOKEN_ENDPOINT, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      client_id: clientId,
      client_secret: clientSecret,
      grant_type: 'client_credentials',
    }),
  });

  if (!response.ok) {
    const text = await response.text();
    throw new Error(`Token request failed (${response.status}): ${text}`);
  }

  const data = (await response.json()) as {
    access_token: string;
    token_type: string;
    expires_in?: number;
  };

  cachedToken = data.access_token;
  tokenExpiresAt = Date.now() + (typeof data.expires_in === 'number' ? data.expires_in * 1000 : TOKEN_TTL_MS);
  return cachedToken;
}

export async function getBearerToken(): Promise<string> {
  if (cachedToken && Date.now() < tokenExpiresAt - EXPIRY_BUFFER_MS) {
    return cachedToken;
  }
  if (inflight) {
    return inflight;
  }
  inflight = fetchToken().finally(() => {
    inflight = null;
  });
  return inflight;
}
