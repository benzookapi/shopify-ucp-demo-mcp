# Shopify UCP Demo — Remote MCP Server

A Remote MCP server that lets any AI agent (Claude, ChatGPT, etc.) search Shopify's global product catalog and complete purchases using the [Universal Commerce Protocol (UCP)](https://ucp.dev).

## What it does

| Tool | Description |
|---|---|
| `search_products` | Search hundreds of millions of products across all Shopify merchants |
| `get_product_details` | Get full variant details and checkout URLs for a specific product |
| `create_checkout` | Start a checkout session on a merchant's store |
| `update_checkout` | Add buyer info, shipping address, select shipping method |
| `complete_checkout` | Place the order when checkout status is `ready_for_complete` |
| `cancel_checkout` | Cancel an active checkout session |

## Architecture

```
User's AI (Claude / ChatGPT / etc.)
    ↓  Remote MCP  (Streamable HTTP POST /mcp)
This Server  (Node.js on Render)
    ├──→  Shopify Catalog MCP  (https://discover.shopifyapps.com/global/mcp)
    └──→  Shopify Checkout MCP (https://{shop}/api/ucp/mcp)
```

## Setup

### 1. Get Shopify API credentials

1. Go to [Shopify Dev Dashboard](https://dev.shopify.com/dashboard)
2. Navigate to **Catalogs** → **Get an API key**
3. Create a key and copy your **client ID** and **client secret**

### 2. Configure environment variables

```bash
cp .env.example .env
# Edit .env with your credentials
```

### 3. Run locally

```bash
npm install
npm run dev
```

The MCP endpoint is available at `http://localhost:3000/mcp`.

### 4. Deploy to Render

1. Push to GitHub (triggers auto-deploy via Render)
2. Set environment variables in Render dashboard:
   - `SHOPIFY_CLIENT_ID`
   - `SHOPIFY_CLIENT_SECRET`
   - `UCP_AGENT_PROFILE` (your Render URL)

## Connect your AI to this MCP server

Add the following to your AI's MCP configuration:

```json
{
  "mcpServers": {
    "shopify-ucp": {
      "url": "https://your-app-name.onrender.com/mcp",
      "transport": "streamable-http"
    }
  }
}
```

For Claude Desktop (`claude_desktop_config.json`):

```json
{
  "mcpServers": {
    "shopify-ucp": {
      "url": "https://your-app-name.onrender.com/mcp"
    }
  }
}
```

## Example conversation

> **User:** Find me a good mechanical keyboard under $150.
>
> **AI:** *(calls `search_products` with query="mechanical keyboard", price_max=150)*
> Here are some options I found across Shopify stores...
>
> **User:** I'll take the third one in size US 10.
>
> **AI:** *(calls `get_product_details` to get variant ID, then `create_checkout`)*
> I've started checkout on [storename]. What's your shipping address?
>
> **User:** Ship to 123 Main St, New York, NY 10001
>
> **AI:** *(calls `update_checkout` with address)*
> Checkout is ready. Please complete payment at: [continue_url]

## Checkout flow

The checkout follows a status-driven workflow as defined by UCP:

```
create_checkout
    ↓
status: incomplete → update_checkout (add missing info)
    ↓
status: requires_escalation → show continue_url to buyer (payment UI)
    ↓
status: ready_for_complete → complete_checkout
    ↓
status: completed ✓
```

## References

- [Shopify Agentic Commerce Docs](https://shopify.dev/docs/agents)
- [Universal Commerce Protocol](https://ucp.dev)
- [Catalog MCP Reference](https://shopify.dev/docs/agents/catalog/mcp)
- [Checkout MCP Reference](https://shopify.dev/docs/agents/checkout/mcp)
- [MCP Specification](https://modelcontextprotocol.io)
