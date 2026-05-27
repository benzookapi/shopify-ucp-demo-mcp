import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { HarnessRunResult } from './types.js';

function sanitizeFilePart(value: string): string {
  return value.replace(/[^a-z0-9._-]+/gi, '-').replace(/^-|-$/g, '').toLowerCase();
}

function formatList(values: string[]): string {
  return values.length > 0 ? values.join(', ') : 'none';
}

export function renderMarkdownReport(run: HarnessRunResult): string {
  const lines: string[] = [];
  lines.push('# UCP Demo Harness Report');
  lines.push('');
  lines.push(`Generated: ${run.generatedAt}`);
  lines.push(`Duration: ${run.durationMs}ms`);
  lines.push('');
  lines.push('| Cases | Passed | Failed | Errored |');
  lines.push('|---:|---:|---:|---:|');
  lines.push(
    `| ${run.totals.cases} | ${run.totals.passed} | ${run.totals.failed} | ${run.totals.errored} |`
  );
  lines.push('');

  for (const result of run.results) {
    lines.push(`## ${result.caseName}`);
    lines.push('');
    lines.push(`Status: **${result.status}**`);
    lines.push(`Duration: ${result.durationMs}ms`);
    lines.push(`Issue codes: ${formatList(result.issueCodes)}`);
    if (result.error) lines.push(`Error: \`${result.error}\``);
    lines.push('');

    if (result.searchSummary) {
      const s = result.searchSummary;
      lines.push('### Catalog Search');
      lines.push('');
      lines.push(`- Offers: ${s.totalOffers}`);
      lines.push(`- Offers with products[]: ${s.offersWithProducts}`);
      lines.push(`- Offers with variants[]: ${s.offersWithVariants}`);
      lines.push(`- Offers with checkoutUrl: ${s.offersWithCheckoutUrl}`);
      lines.push(`- Merchant hosts: ${formatList(s.merchantHosts)}`);
      lines.push(`- Currencies: ${formatList(s.currencies)}`);
      lines.push('');
    }

    if (result.detailSummary) {
      const d = result.detailSummary;
      lines.push('### Product Details');
      lines.push('');
      lines.push(`- Product title: ${d.productTitle ?? 'unknown'}`);
      lines.push(`- Shop offers: ${d.offerCount}`);
      lines.push(`- Uses products[] schema: ${d.usesProductsSchema}`);
      lines.push(`- Uses variants[] schema: ${d.usesVariantsSchema}`);
      lines.push(`- Offers with checkoutUrl: ${d.offersWithCheckoutUrl}`);
      lines.push('');
    }

    if (result.discoveryDiagnostics.length > 0) {
      lines.push('### Merchant Discovery');
      lines.push('');
      lines.push('| Merchant | Status | Endpoint / reason |');
      lines.push('|---|---|---|');
      for (const diagnostic of result.discoveryDiagnostics) {
        lines.push(
          `| ${diagnostic.shopDomain} | ${diagnostic.status} | ${
            diagnostic.endpoint ?? diagnostic.reason ?? ''
          } |`
        );
      }
      lines.push('');
    }

    if (result.assertions.length > 0) {
      lines.push('### Assertions');
      lines.push('');
      for (const assertion of result.assertions) {
        lines.push(`- ${assertion.ok ? 'PASS' : 'FAIL'}: ${assertion.message}`);
      }
      lines.push('');
    }
  }

  return `${lines.join('\n')}\n`;
}

export async function writeReports(
  run: HarnessRunResult,
  reportDir: string,
): Promise<{ jsonPath: string; markdownPath: string }> {
  await mkdir(reportDir, { recursive: true });
  const stamp = sanitizeFilePart(run.generatedAt.replace(/[:.]/g, '-'));
  const jsonPath = join(reportDir, `ucp-demo-harness-${stamp}.json`);
  const markdownPath = join(reportDir, `ucp-demo-harness-${stamp}.md`);

  await writeFile(jsonPath, `${JSON.stringify(run, null, 2)}\n`, 'utf8');
  await writeFile(markdownPath, renderMarkdownReport(run), 'utf8');

  return { jsonPath, markdownPath };
}
