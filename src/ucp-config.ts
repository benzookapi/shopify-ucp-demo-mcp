// Shared UCP agent profile URI used by both the Catalog MCP and the Checkout MCP.
// Defaults to Shopify's published reference profile; override with UCP_AGENT_PROFILE
// only if you self-host a custom UCP profile document.
export const UCP_AGENT_PROFILE =
  process.env.UCP_AGENT_PROFILE ??
  'https://shopify.dev/ucp/agent-profiles/2026-04-08/valid-with-capabilities.json';
