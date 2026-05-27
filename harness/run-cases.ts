import { readdir, readFile } from 'node:fs/promises';
import { dirname, isAbsolute, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  buildSearchGlobalProductsArgs,
  extractBase62,
  getGlobalProductDetails,
  searchGlobalProducts,
  summarizeCatalogSearchResult,
  summarizeProductDetailsResult,
} from '../src/catalog.js';
import { diagnoseCheckoutDiscovery } from '../src/checkout.js';
import { assertHarnessCase } from './assertions.js';
import { classifyHarnessResult } from './classify.js';
import { writeReports } from './report.js';
import type {
  HarnessCase,
  HarnessCaseResult,
  HarnessRunResult,
  HarnessStatus,
} from './types.js';

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const defaultCasesDir = join(repoRoot, 'harness', 'cases');
const defaultReportDir = join(repoRoot, 'harness', 'reports');

interface CliOptions {
  casePath?: string;
  casesDir: string;
  reportDir: string;
  list: boolean;
}

function parseArgs(argv: string[]): CliOptions {
  const options: CliOptions = {
    casesDir: defaultCasesDir,
    reportDir: defaultReportDir,
    list: false,
  };

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    const value = argv[i + 1];
    if (arg === '--') {
      continue;
    } else if (arg === '--case' && value) {
      options.casePath = value;
      i += 1;
    } else if (arg === '--cases-dir' && value) {
      options.casesDir = value;
      i += 1;
    } else if (arg === '--report-dir' && value) {
      options.reportDir = value;
      i += 1;
    } else if (arg === '--list') {
      options.list = true;
    } else if (arg === '--help' || arg === '-h') {
      printHelp();
      process.exit(0);
    } else {
      throw new Error(`Unknown or incomplete argument: ${arg}`);
    }
  }

  options.casesDir = toAbsolute(options.casesDir);
  options.reportDir = toAbsolute(options.reportDir);
  if (options.casePath) options.casePath = toAbsolute(options.casePath);
  return options;
}

function toAbsolute(path: string): string {
  return isAbsolute(path) ? path : join(repoRoot, path);
}

function printHelp(): void {
  console.log(`UCP Demo Harness

Usage:
  pnpm run harness
  pnpm run harness -- --case harness/cases/us-made-denim-to-jp.json
  pnpm run harness -- --list

Options:
  --case <path>        Run one case file
  --cases-dir <path>   Run all *.json case files in a directory
  --report-dir <path>  Write JSON and Markdown reports to this directory
  --list               List discovered cases without running network calls
`);
}

async function readJsonFile<T>(path: string): Promise<T> {
  return JSON.parse(await readFile(path, 'utf8')) as T;
}

async function loadLocalEnv(path: string): Promise<void> {
  try {
    const text = await readFile(path, 'utf8');
    for (const line of text.split(/\r?\n/)) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith('#')) continue;
      const match = trimmed.match(/^([A-Za-z_][A-Za-z0-9_]*)=(.*)$/);
      if (!match) continue;
      const [, key, rawValue] = match;
      if (process.env[key] !== undefined) continue;
      process.env[key] = rawValue.replace(/^['"]|['"]$/g, '');
    }
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err;
  }
}

async function loadCases(options: CliOptions): Promise<Array<{ path: string; testCase: HarnessCase }>> {
  if (options.casePath) {
    return [{ path: options.casePath, testCase: await readJsonFile<HarnessCase>(options.casePath) }];
  }

  const names = (await readdir(options.casesDir))
    .filter((name) => name.endsWith('.json'))
    .sort();
  return Promise.all(
    names.map(async (name) => {
      const path = join(options.casesDir, name);
      return { path, testCase: await readJsonFile<HarnessCase>(path) };
    })
  );
}

function firstProductId(searchResult: unknown): string | undefined {
  const raw = searchResult as Record<string, unknown> | null;
  const offers = (Array.isArray(raw?.offers) ? raw.offers : []) as Record<string, unknown>[];
  const rawId = offers.find((offer) => typeof offer.id === 'string')?.id;
  return typeof rawId === 'string' ? extractBase62(rawId) : undefined;
}

function unique(values: string[]): string[] {
  return [...new Set(values.filter(Boolean))];
}

async function runCase(testCase: HarnessCase): Promise<HarnessCaseResult> {
  const started = Date.now();
  const startedAt = new Date(started).toISOString();
  let errorStage: 'catalog' | 'product_details' | 'discovery' | undefined;
  let error: string | undefined;
  let searchArgs: Record<string, unknown> | undefined;
  let searchResult: unknown;
  let searchSummary;
  let detailSummary;
  const discoveryDiagnostics = [];

  try {
    if (testCase.search) {
      errorStage = 'catalog';
      searchArgs = buildSearchGlobalProductsArgs(testCase.search);
      searchResult = await searchGlobalProducts(testCase.search);
      searchSummary = summarizeCatalogSearchResult(searchResult);

      if (testCase.expectations?.requireProductDetails || testCase.expectations?.minProductDetailOffers) {
        const upid = firstProductId(searchResult);
        if (!upid) {
          throw new Error('Cannot run product details check because the search returned no product id');
        }

        errorStage = 'product_details';
        const details = await getGlobalProductDetails({
          upid,
          context: testCase.search.context,
          ...(testCase.search.ships_to && { ships_to: testCase.search.ships_to }),
        });
        detailSummary = summarizeProductDetailsResult(details);
      }
    }

    const discoveryHosts = unique([
      ...(testCase.discovery?.merchantHosts ?? []),
      ...(testCase.discovery?.fromSearchResults ? searchSummary?.merchantHosts ?? [] : []),
    ]).slice(0, testCase.discovery?.maxMerchants ?? 3);

    if (discoveryHosts.length > 0) {
      errorStage = 'discovery';
      for (const host of discoveryHosts) {
        discoveryDiagnostics.push(await diagnoseCheckoutDiscovery(host));
      }
    }

    errorStage = undefined;
  } catch (err) {
    error = err instanceof Error ? err.message : String(err);
  }

  const assertions = assertHarnessCase(
    testCase,
    searchSummary,
    detailSummary,
    discoveryDiagnostics,
  );
  const failedAssertions = assertions.filter((assertion) => !assertion.ok).length;
  const issueCodes = classifyHarnessResult({
    testCase,
    searchSummary,
    detailSummary,
    discoveryDiagnostics,
    errorStage,
    failedAssertions,
  });
  const status: HarnessStatus = error ? 'error' : failedAssertions > 0 ? 'fail' : 'pass';
  const finished = Date.now();

  return {
    caseName: testCase.name,
    status,
    startedAt,
    finishedAt: new Date(finished).toISOString(),
    durationMs: finished - started,
    searchArgs,
    searchSummary,
    detailSummary,
    discoveryDiagnostics,
    assertions,
    issueCodes,
    ...(error && { error }),
  };
}

async function main(): Promise<void> {
  const options = parseArgs(process.argv.slice(2));
  await loadLocalEnv(join(repoRoot, '.env'));
  const cases = await loadCases(options);

  if (options.list) {
    for (const item of cases) {
      console.log(`${item.testCase.name}\t${item.path}`);
    }
    return;
  }

  const needsCatalogCredentials = cases.some((item) => item.testCase.search);
  if (
    needsCatalogCredentials &&
    (!process.env.SHOPIFY_CLIENT_ID || !process.env.SHOPIFY_CLIENT_SECRET)
  ) {
    throw new Error('SHOPIFY_CLIENT_ID and SHOPIFY_CLIENT_SECRET must be set to run the harness');
  }

  const started = Date.now();
  const results: HarnessCaseResult[] = [];
  for (const item of cases) {
    console.log(`[harness] running ${item.testCase.name}`);
    results.push(await runCase(item.testCase));
  }

  const run: HarnessRunResult = {
    generatedAt: new Date().toISOString(),
    durationMs: Date.now() - started,
    totals: {
      cases: results.length,
      passed: results.filter((result) => result.status === 'pass').length,
      failed: results.filter((result) => result.status === 'fail').length,
      errored: results.filter((result) => result.status === 'error').length,
    },
    results,
  };

  const paths = await writeReports(run, options.reportDir);
  console.log(`[harness] wrote ${paths.markdownPath}`);
  console.log(`[harness] wrote ${paths.jsonPath}`);

  if (run.totals.failed > 0 || run.totals.errored > 0) {
    process.exitCode = 1;
  }
}

main().catch((err) => {
  console.error(`[harness] ${err instanceof Error ? err.message : String(err)}`);
  process.exitCode = 1;
});
