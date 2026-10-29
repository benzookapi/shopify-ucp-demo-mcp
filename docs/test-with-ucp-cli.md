# Testing with the UCP CLI

> **Verified:** 2026-10-29 for the added Catalog verification guidance. Dated observations below are maintainer-reported; no merchant data was changed for this documentation revision.

This sample wraps two underlying Shopify MCPs — the **Catalog MCP**
(`https://catalog.shopify.com/api/ucp/mcp`) and the per-shop
**Cart / Checkout MCP** (discovered via
`/.well-known/ucp`). Shopify ships an official CLI,
[`@shopify/ucp-cli`](https://github.com/Shopify/ucp-cli), that talks to
those endpoints directly using the canonical UCP tool names — so you can
verify that the same flow this sample drives end-to-end through an AI also
works one tool call at a time from the command line.

The full quickstart lives at
[shopify.dev/docs/agents/get-started/quickstart](https://shopify.dev/docs/agents/get-started/quickstart).

For repeated demo regression checks, use this repository's UCP Demo Self-Test
instead of retyping the same commands by hand:

```bash
pnpm run self-test
```

The self-test calls this sample's wrapping code, classifies missing catalog
matches, response-shape changes, checkout URL gaps, and `/.well-known/ucp`
discovery outcomes, then writes redacted reports under `harness/reports/`.
The CLI remains the lower-level tool for verifying Shopify's canonical UCP
commands directly. Keep store-specific cases under ignored `harness/private/`
when you need local merchant debugging.

> ⚠️ The CLI calls Shopify's UCP endpoints directly — **not** this
> Render-hosted demo. The point is to verify the wire format and round-trip
> the spec tools. If a CLI command succeeds but the demo fails (or vice
> versa), the difference is in this server's wrapping logic, not in Shopify.

## 1. Install

```bash
pnpm add --global @shopify/ucp-cli
ucp --version
```

(Optional, for use inside Claude Code with the Shopify AI Toolkit plugin.)

```bash
claude plugin install shopify-ai-toolkit@claude-plugins-official
```

## 2. One-time profile setup

```bash
ucp profile init --name shopper      # writes ~/.ucp/profiles/shopper.yaml
ucp doctor                           # sanity-check setup
```

Optional: install the bundled SKILL file so your AI host knows how to drive
the CLI.

```bash
ucp skills add
```

## 3. Configure the merchant scope

Almost every command other than global catalog search takes `--business`
pointing at the merchant's public storefront URL. The CLI handles
`/.well-known/ucp` discovery itself — you don't need to substitute the
`*.myshopify.com` admin domain manually, the same way this sample's
[`resolveCheckoutMcpUrl`](../src/checkout.ts) does internally.

```bash
export UCP_BUSINESS="https://merchant.example"   # replace with one merchant, used as default
```

You can also pass `--business` on every call instead.

## 4. Catalog tests

### 4.1 `catalog search` — basic query

The UCP spec name is `search_catalog`; this server wraps it as
`search_products` (see the [README](../README.md) mapping). The CLI invokes the
spec form:

```bash
ucp catalog search \
  --set /query='American jeans' \
  --set /context/intent='buyer in Tokyo, Japan, prefers premium denim, ships from US to JP' \
  --set /context/address_country=JP \
  --set /filters/ships_to/country=JP \
  --set '/filters/ships_from/0/country=US' \
  --view :compact \
  --format md
```

Expected: a list of products. Current responses use `products[]` with
`variants[].checkout_url`; older responses may use `offers[]` with
`products[].checkoutUrl`. The demo wrapper keeps this complete response in
MCP `structuredContent` while also returning concise buyer-facing Markdown.
The self-test checks the `dev.shopify.catalog.global` capability plus product
metadata and variant extension-field coverage.

> 💡 `--input-schema` on any subcommand prints the live JSON schema — use
> it to discover the exact filter keys your version of the spec accepts.
> `ucp catalog search --input-schema`

### 4.2 `catalog search` — price-bounded

```bash
ucp catalog search \
  --set /query='organic Japanese skincare' \
  --set /context/intent='buyer in Paris seeking natural ingredients' \
  --set /context/address_country=FR \
  --set /filters/price/min=2000 \
  --set /filters/price/max=8000 \
  --view :compact
```

Expected: all returned `price_range.min.amount` values fall in `[2000, 8000]`
minor currency units.

### 4.3 `catalog search` — image similarity

This sample wraps Shopify Global Catalog image similarity by accepting
`image_base64` and `image_content_type` on `search_products`. It also accepts
`image_url` for clients that cannot pass binary attachments as base64. The
underlying Catalog payload uses `catalog.like[].image`:

```bash
IMAGE_BASE64="$(base64 -i ./reference-product.jpg | tr -d '\n')"

curl -s http://localhost:3000/mcp \
  -H 'Content-Type: application/json' \
  -d "$(cat <<JSON
{
  "jsonrpc": "2.0",
  "method": "tools/call",
  "params": {
    "name": "search_products",
    "arguments": {
      "query": "similar style under $100",
      "context": "buyer in California looking for visually similar products that ship within the US",
      "image_base64": "$IMAGE_BASE64",
      "image_content_type": "image/jpeg",
      "ships_to": "US",
      "available_for_sale": true,
      "limit": 5
    }
  },
  "id": 1
}
JSON
)"
```

Expected: results are visually similar to the reference image and still include
buyer-facing titles, prices, checkout URLs, and Markdown product images when
Catalog returns image URLs.

For a real call, pass either `image_base64` plus `image_content_type`, or
`image_url`, not both. The sample rejects placeholder-sized image payloads
before calling Catalog: decoded image bytes must be at least 512 bytes and match
the declared MIME type. If a client cannot provide the full image bytes, use
`image_url` instead.

### 4.4 `catalog get_product` — by product ID

Spec name is `get_product`; this sample wraps it as `get_product_details`. Use
the product ID from 4.1's output. This sample accepts either the full
`gid://shopify/p/...` value or the Base62 segment after `/p/`:

```bash
ucp catalog get_product AbC123XyZ \
  --set /context/address_country=JP \
  --set '/selected/0={"name":"Color","label":"Indigo"}' \
  --set '/selected/1={"name":"Size","label":"M"}' \
  --view :compact
```

Expected: Catalog returns `product.variants[]` with seller, price,
availability, options, PDP URL, and `checkout_url` data for the requested
variant. This sample's `get_product_details` wrapper keeps the buyer-facing
response concise: when generic `options` selections (or the legacy `color` /
`size` shortcuts) are supplied, it locally prioritizes matching offers and
displays at most three of them for mobile clients. Shopify option names are
merchant-defined, so the wrapper does not hardcode translated option-name
aliases. In the raw UCP CLI example above, replace `Color` and `Size` with the
exact option names returned by Catalog for the product you are testing.

### 4.5 `discover` — what does this merchant actually offer?

```bash
ucp discover --business "$UCP_BUSINESS"
```

Returns the merchant's `/.well-known/ucp` services. If the response is
empty for `dev.ucp.shopping`, the shop hasn't enabled Checkout MCP — the
Cart and Checkout commands below are unavailable for that shop. The exact CLI
error depends on the discovered profile and authentication tier.

## 5. Cart and checkout tests

Pick a shop from the catalog response above (the `shop.onlineStoreUrl`
field). If the merchant hasn't enabled Checkout MCP, the standard
`checkoutUrl` from `get_product` still works as a regular hosted checkout —
this server's `create_checkout` wrapper catches `UcpNotSupportedError` and
instructs the agent to reuse that URL from `get_product_details`.

### 5.1 `cart create` — optional basket step

Use Cart MCP when the buyer wants to add, remove, or review items before
checkout:

```bash
ucp cart create --business "$UCP_BUSINESS" \
  --input '{
    "line_items":[{"item":{"id":"gid://shopify/ProductVariant/12345"},"quantity":1}],
    "context":{"address_country":"JP"}
  }'
```

Expected: a cart response with an `id`, `line_items`, `totals`, and possibly a
`continue_url`. Save the ID when testing checkout conversion:

```bash
CART_ID="..."   # from cart create
```

### 5.2 `cart update` — full replacement

Cart update is full-replace. Carry forward every line item that should remain:

```bash
ucp cart update "$CART_ID" --business "$UCP_BUSINESS" \
  --input '{
    "line_items":[{"item":{"id":"gid://shopify/ProductVariant/12345"},"quantity":2}],
    "context":{"address_country":"JP"}
  }'
```

This sample's `update_cart` wrapper follows the same rule and asks the agent to
include the complete `line_items` list.

### 5.3 `checkout create` — from cart_id or direct line_items

> ℹ️ **The `Shopify-Buyer-IP` header is required.** Shopify's Checkout MCP
> requires a `Shopify-Buyer-IP` HTTP header with a valid IPv4 or IPv6
> address when calling tools that mutate cart state with a trusted
> authentication method. Omitting it returns HTTP 422 with
> `Missing required buyer IP header.` This requirement is observed
> empirically; the CLI sets the header from your local connection
> automatically, and this sample plumbs the IP from the incoming `/mcp`
> request via [`request-context.ts`](../src/request-context.ts). UCP's
> spec also defines `signals["dev.ucp.buyer_ip"]` in writable cart and checkout
> bodies. The sample always forwards the header and adds the body signal when
> that operation has such a body. In a Remote
> MCP topology the captured IP is the AI provider's, not the buyer's
> true client IP — agentic commerce shifts buyer-IP collection to the
> AI host. Production deployments serving real buyer traffic should pass
> the buyer's true IP; for high-volume production usage, contact Shopify
> to discuss partner-program options.

```bash
ucp checkout create --business "$UCP_BUSINESS" \
  --set-string /cart_id="$CART_ID"
```

For a direct buy-now flow, skip cart and pass line items directly:

```bash
ucp checkout create --business "$UCP_BUSINESS" \
  --input '{
    "currency":"USD",
    "line_items":[{"item":{"id":"gid://shopify/ProductVariant/12345"},"quantity":1}]
  }'
```

The initial status depends on the inherited cart and merchant requirements; it
is commonly `incomplete` or `requires_escalation`. The response contains a
checkout `id` — save it for the next call.

```bash
CHECKOUT_ID="..."   # from the create response
```

### 5.4 `checkout update` — PUT semantics, full payload

UCP's `update_checkout` is **PUT-style** — the body replaces the checkout
state. Inspect the live schema first so you know what's writable on this
checkout, then send the full payload:

```bash
ucp checkout update "$CHECKOUT_ID" --input-schema --business "$UCP_BUSINESS"

ucp checkout update "$CHECKOUT_ID" --business "$UCP_BUSINESS" \
  --input '{
    "line_items":[{"item":{"id":"gid://shopify/ProductVariant/12345"},"quantity":1}],
    "buyer":{"email":"alice@example.com","first_name":"Alice","last_name":"Doe","phone":"+81-90-1234-5678"},
    "fulfillment":{"methods":[{"type":"shipping","destinations":[{
      "first_name":"Alice","last_name":"Doe","phone":"+81-90-1234-5678",
      "street_address":"1-1-1 Chiyoda","address_locality":"Chiyoda-ku",
      "address_region":"Tokyo","postal_code":"100-0001","address_country":"JP"
    }]}]}
  }'
```

> 💡 Only send the **writable** fields shown by `--input-schema`. This
> demo's [`mergeCheckout`](../src/checkout.ts) does the same — it fetches
> the current state with `get_checkout` but strips computed/read-only
> fields (the `ucp` capabilities block, `messages`, `totals`,
> `methods[].groups`, `methods[].id`, `destinations[].id`, etc.) before
> re-sending. Echoing those back triggers `Invalid params`.

Expected status: usually `requires_escalation`. The response will include a
`checkout.continue_url` for the buyer to finish payment in their browser
and one or more `messages[]` with `severity` starting with
`requires_buyer_*`. See [escalation.md](./escalation.md) for what each
state means.

### 5.5 Handle escalation automatically

Once you've seen the `continue_url` once, wire up the escalation hook so
the CLI launches it for you on subsequent runs:

```bash
export UCP_ON_ESCALATION='jq -r .url | xargs open'   # macOS
# Linux: replace `open` with `xdg-open`
# Persist by editing `escalation.command` in ~/.ucp/config.yaml
```

### 5.6 `checkout get` — round-trip the state

```bash
ucp checkout get "$CHECKOUT_ID" --business "$UCP_BUSINESS"
```

Expected: the full checkout payload from 5.4, including any
`shipping_method_handle` options the merchant offers. Use this to pick a
shipping method for a follow-up `checkout update`.

### 5.7 `checkout complete` — only when status is `ready_for_complete`

After the buyer finishes the merchant-hosted step, run `checkout get` first.
The hosted checkout might already have completed the order. Call
`checkout complete` only when the latest status is `ready_for_complete` and a
payment credential has been authorized. The CLI generates an idempotency key
by default:

```bash
ucp checkout complete "$CHECKOUT_ID" --business "$UCP_BUSINESS"
```

Expected status: `completed`, with an `order.id` and a `permalink_url`
receipt. This sample's
[`complete_checkout`](../src/server.ts) wrapper requires an explicit
`idempotency_key`, but its public tool schema does not expose a payment
credential. It is therefore not a replacement for the CLI's payment-handler
flow; use it only when the upstream checkout already reports
`ready_for_complete` with usable payment state.

### 5.8 `checkout cancel` — idempotency required

```bash
ucp checkout cancel "$CHECKOUT_ID" --business "$UCP_BUSINESS"
```

Expected status: `canceled`. The CLI creates the idempotency key for its
request. This sample's [`cancel_checkout`](../src/server.ts) wrapper instead
requires the caller to provide the key explicitly so the same value can be
reused for a retry.

## 6. Cross-check against this server

If you have this demo running locally on port 3000, you can compare the
wire format the AI sees against what the CLI sends:

```bash
# Catalog: this server (spec name wrapped)
curl -s -X POST http://localhost:3000/mcp \
  -H "Content-Type: application/json" \
  -d '{"jsonrpc":"2.0","method":"tools/call","params":{"name":"search_products","arguments":{"query":"American jeans","context":"buyer in JP","ships_to":"JP","ships_from":"US","limit":3}},"id":1}'

# Catalog: CLI hitting Shopify directly, raw JSON
ucp catalog search \
  --set /query='American jeans' \
  --set /context/intent='buyer in JP [ships_to: JP] [ships_from: US]' \
  --set /context/address_country=JP \
  --set /filters/ships_to/country=JP \
  --set '/filters/ships_from/0/country=US' \
  --set /filters/available=true \
  --set /pagination/limit=3 \
  --format json
```

Compare the requests semantically, not byte-for-byte. This wrapper enriches
`context.intent`, defaults `available` to `true`, caps pagination, adds the
configured saved Catalog through the deprecated `saved_catalog_slug` alias,
and injects its agent profile. New direct integrations should use
`catalog.catalog_id`; this documentation update does not change the wrapper.
The wrapper does not expose `filters.attributes` or `filters.shops`, so use
the direct upstream request in the [field guide](catalog-field-mapping.md#attribute-filters-and-shop-scope)
to isolate those filters. The CLI adds
its own profile metadata and renders a different response envelope.

`--dry-run` on any UCP command prints the payload the CLI would send
without actually sending it — useful for diffing against the
`[catalog] ... args:` or `[checkout] ... body:` lines this server logs.

## 7. What this sample doesn't exercise

The UCP CLI also covers tools this sample does not wrap. Listed here so you
know they exist and can test them against Shopify directly:

| UCP CLI command | Purpose | Why this sample skips it |
|---|---|---|
| `order get` | Fetch an order after `checkout complete` returns | Out of scope for the demo flow; receipts are surfaced via `permalink_url`. |
| Order webhooks | Push notifications when an order's state changes | The demo finishes at `checkout complete`; no listener is wired. |

## 8. Verify category metafield matching without inferring it from responses

Use an owned test product and save its original state before making changes.
This is a manual experiment, not an automated production-store mutation.

1. Select the appropriate product category and use its existing standard
   category metafield definition, such as `shopify.color-pattern`. Do not create
   an app-owned lookalike. Choose a test color that occurs nowhere else in the
   product's options, title, description, or images. Accept the intended value
   and save it; a proposed Admin suggestion is not evidence of a saved value.
2. Confirm the saved reference through an authorized Admin GraphQL client.
   The following read-only query inspects the referenced standard entries:

   ```graphql
   query CatalogCategoryColor($productId: ID!) {
     product(id: $productId) {
       categoryColor: metafield(namespace: "shopify", key: "color-pattern") {
         references(first: 20) {
           nodes {
             ... on Metaobject {
               displayName
             }
           }
         }
       }
     }
   }
   ```

   Use your own product GID for `$productId` and an authorized client with
   `read_products` and `read_metaobjects`; follow pagination if there are more
   than 20 references. See [Admin product query](https://shopify.dev/docs/api/admin-graphql/latest/queries/product)
   and [standard category definitions](https://shopify.dev/docs/apps/build/metafields/conditional-metafield-definitions).
3. Temporarily add a distinctive marker such as `zqtest` to the title. Repeat a
   direct `search_catalog` query for the marker, keeping the same shop GID,
   country, availability, saved scope, and profile capabilities. Record ranking
   and results over time, not just the displayed title. In the maintainer's
   **2026-10-27 (UTC)** test, the fresh title was returned while the item still
   ranked 16 of 30; about three hours later it ranked first.
4. After the title-search positive control changes, test the color saved only
   in a category metafield using `filters.attributes`, plus an option color as
   a comparison.
   Record exact inputs, times, returned products, and `messages`. Also compare
   `lookup_catalog` / `get_product` responses to distinguish returned data from
   matching behaviour. Use the [direct request example](catalog-field-mapping.md#attribute-filters-and-shop-scope)
   and a profile declaring the base Catalog capabilities plus
   `dev.shopify.catalog.global`.
5. Restore the original title and test values. Do not leave test data on a
   live listing or publish store/product identifiers in shared reports.

The reported Yellow value saved only in a category metafield still did not match on 2026-10-27,
more than 24 hours after being saved; option Black matched and `messages` was
empty. This does not prove a universal exclusion or an indexing schedule.
The title control confirms only the tested title-search signal, not every
filter/enrichment pipeline. [Shopify Catalog mapping Help](https://help.shopify.com/en/manual/shopify-catalog/mapping)
documents delayed processing, not a fixed indexing SLA.

Before testing, also check [Catalog eligibility, including account standing and history](https://help.shopify.com/en/manual/shopify-catalog/requirements#eligibility-requirements-related-to-account-standing-and-history),
the resolved shipping destination (default US in the reported tests), and any
saved Catalog boundaries. Otherwise zero results do not isolate the attribute.
For the full dated observations, see [§5a of the field guide](catalog-field-mapping.md#5a-category-metafields).

## References

- [Shopify UCP CLI quickstart](https://shopify.dev/docs/agents/get-started/quickstart)
- [`@shopify/ucp-cli` on GitHub](https://github.com/Shopify/ucp-cli)
- [Shopify Global Catalog MCP](https://shopify.dev/docs/agents/catalog/global-catalog)
- [Shopify Cart MCP](https://shopify.dev/docs/agents/carts-and-checkout/cart-mcp)
- [Shopify Checkout MCP](https://shopify.dev/docs/agents/carts-and-checkout/checkout-mcp)
- [UCP specification (ucp.dev)](https://ucp.dev/)
- This sample's [escalation walkthrough](./escalation.md) — what statuses
  the CLI tests above will surface and what the buyer experience looks
  like at each step.
