# Tips & Best Practices — Shopify UCP Demo MCP

This document covers implementation tips for getting better results from the Shopify Catalog and Checkout MCPs. All of these are implemented in this sample repository and can be used as a reference for your own UCP agent.

## 1. Combine `ships_to` and `ships_from` for origin-specific queries

`ships_to` alone filters to stores that ship to the buyer's country. For queries that mention a product origin (e.g. "American-made jeans", "Japanese skincare"), also pass `ships_from` to narrow results to stores that ship *from* that origin country.

| Query | `ships_to` | `ships_from` |
|---|---|---|
| American-made jeans available in Tokyo | `JP` | `US` |
| Japanese traditional goods in the US | `US` | `JP` |
| Italian leather bags shipping to France | `FR` | `IT` |

```json
{
  "name": "search_global_products",
  "arguments": {
    "query": "American-made denim jeans",
    "context": "buyer in Tokyo looking for authentic US denim brands",
    "ships_to": "JP",
    "ships_from": "US"
  }
}
```

Using only `ships_to: "JP"` would return any store worldwide that ships to Japan. Adding `ships_from: "US"` restricts results to US-based stores shipping to Japan — far more relevant for origin-specific queries.

## 2. Write rich `context` — it is marked "critical" in the Catalog MCP spec

The `context` parameter has a significant impact on result quality. Shopify's Catalog MCP documentation marks it as **Required (critical)**. A detailed context helps the AI and the Catalog engine surface more relevant products.

**Poor context:**
```
"buyer in Japan"
```

**Rich context:**
```
"buyer in Tokyo, Japan looking for authentic American-made premium denim jeans,
prefers well-known US brands, quality over price, ships from US to JP"
```

Always include:
- Buyer's location (city and country)
- Product origin if mentioned in the query
- Style or quality preferences
- Brand expectations (premium, budget, specific brands)
- Any other details from the conversation

## 3. Show product ratings to help buyers choose

The `search_global_products` response includes `rating: { value, count }` at both the universal product level and the per-shop offer level (`products[].rating`). Surface this in your UI so buyers can prioritize highly rated products.

```json
// In the search response:
{
  "offers": [{
    "title": "Levi's 501 Original Jeans",
    "rating": { "value": 4.8, "count": 312 },
    "products": [{
      "rating": { "value": 4.9, "count": 87 },
      ...
    }]
  }]
}
```

This sample server displays ratings inline in search results:
```
1. **Levi's 501 Original Jeans** — 89.00 USD  ⭐ 4.8 (312)
```

## 4. `products_limit` is capped at 10

The `products_limit` parameter controls how many per-shop offers are returned per universal product. The API maximum is **10** (default: 10). There is no way to retrieve more than 10 per-shop offers per product in a single call.

If you need to compare more shops for a single product, consider calling `get_global_product_details` with different `ships_to` / `ships_from` combinations.

## 5. Handle UCP Checkout fallback gracefully

Not all Shopify stores support the UCP Checkout MCP (`https://{shop}/api/ucp/mcp`). Stores that have not enabled UCP return HTTP 503 with `AuthenticationFailed`. Your agent should catch this and fall back to the `checkoutUrl` (cart permalink) returned by the Catalog MCP.

```
Checkout MCP available  →  create_checkout → update_checkout → continue_url
Checkout MCP unavailable (503)  →  show checkoutUrl from search/detail results
```

The `checkoutUrl` is a standard Shopify cart permalink that works for all stores, regardless of UCP support:
```
https://store.myshopify.com/cart/VARIANT_ID:QUANTITY?_gsid=...
```

## 6. Token caching

The bearer token from `api.shopify.com/auth/access_token` expires in 60 minutes. Cache it with a 5-minute buffer (refresh at 55 minutes) to avoid unnecessary re-authentication on every request.

The same token is used for both the Catalog MCP and the Checkout MCP — no separate credentials are needed.

## References

- [Catalog MCP Reference](https://shopify.dev/docs/agents/catalog/mcp)
- [Checkout MCP Reference](https://shopify.dev/docs/agents/checkout/mcp)
- [About Shopify Catalog](https://shopify.dev/docs/agents/catalog)
- [Universal Commerce Protocol](https://ucp.dev)
