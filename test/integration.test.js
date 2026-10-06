import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import ExcelJS from 'exceljs';
import { ShopifyClient } from '../src/client.js';
import { Repository } from '../src/repository.js';
import { ensureDefinitions } from '../src/definitions.js';
import { writeBatch } from '../src/writer.js';
import { createOutput } from '../src/output.js';
import { run } from '../src/run.js';
import { createProgress } from '../src/progress.js';
import { resolveSources } from '../src/engine.js';

const config = { sizeOptions: ['size'], empty: 'preserve', collections: { 'mattress:Queen': 'queen' } };
const variant = (id, price = '1000') => ({ id, title: 'Queen', sku: id, price, availableForSale: true, sellableOnlineQuantity: 5, selectedOptions: [{ name: 'Size', value: 'Queen' }] });
const product = (id = 'source', variants = [variant('source-v')]) => ({ id, title: 'Example', productType: 'Bed', status: 'ACTIVE', onlineStoreUrl: 'https://example.com', variants: { nodes: variants, pageInfo: { hasNextPage: false } } });
const memoryOutput = () => ({ logs: [], rows: [], snapshots: [], results: [], async log(x) { this.logs.push(x); }, audit(...x) { this.rows.push(x); }, async snapshot(x) { this.snapshots.push(x); }, writeResult(...x) { this.results.push(x); }, async finish(x) { this.summary = x; } });
const response = (body, status = 200, headers = {}) => new Response(JSON.stringify(body), { status, headers });

const targetProduct = (...args) => ({ ...product(...args), productType: 'Mattress' });

test('progress records stages and API waits without query variables or credentials', async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'ornate-progress-'));
  const progress = createProgress(directory);
  try {
    progress.update({ stage: 'loading_collection_page', collectionProducts: 30 });
    progress.update({ kind: 'api', operation: 'Pool', status: 'throttled', waitMs: 2000 });
    const state = JSON.parse(await readFile(path.join(directory, 'run-progress.json'), 'utf8'));
    assert.equal(state.stage, 'loading_collection_page');
    assert.equal(state.collectionProducts, 30); assert.equal(state.api.waitMs, 2000);
    progress.update({ kind: 'api', operation: 'Pool', status: 'received' });
  } finally { progress.close('completed'); }
  const state = JSON.parse(await readFile(path.join(directory, 'run-progress.json'), 'utf8'));
  assert.equal(state.stage, 'completed'); assert.equal(state.requestsCompleted, 1);
});

test('unconfigured sizes skip audit and write, even when empty policy is clear', async () => {
  for (const mode of ['audit', 'write']) {
    const split = product(); split.variants.nodes[0].selectedOptions[0].value = 'Split King';
    split.variants.nodes[0].mattress = { type: 'list.variant_reference', jsonValue: ['existing'] };
    const client = { async graphql(query) { assert.match(query, /^query Definitions/); return { metafieldDefinitions: { nodes: [{ type: { name: 'list.variant_reference' } }] } }; } };
    const repo = { async validateCollections(mapping) { assert.deepEqual(mapping, config.collections); return new Map([['queen', 'c']]); },
      async *sources() { yield [split]; }, async pool() { assert.fail('Disabled pool must not be fetched'); }, async refresh() { assert.fail('Disabled source must not be refreshed'); } };
    const out = memoryOutput();
    const summary = await run({ mode, config: { ...config, empty: 'clear' }, client, repository: repo, output: out });
    assert.equal(summary.status, 'completed'); assert.equal(summary.skippedUnconfiguredCollection, 1);
    assert.equal(summary.sourceRecords, 0); assert.equal(summary.written, 0); assert.equal(out.snapshots.length, 0);
    assert.equal(out.logs[0].reason, 'collection_not_configured');
  }
});
test('all collections disabled performs no Shopify operations', async () => {
  const out = memoryOutput();
  const summary = await run({ mode: 'write', config: { ...config, collections: {} }, client: {}, repository: {}, output: out });
  assert.equal(summary.status, 'completed'); assert.equal(summary.written, 0); assert.ok(summary.finishedAt);
});
test('source refreshed into an unconfigured size is skipped before pool lookup', async () => {
  const client = { async graphql() { return { metafieldDefinitions: { nodes: [{ type: { name: 'list.variant_reference' } }] } }; } };
  const repo = { async validateCollections() { return new Map([['queen', 'c']]); }, async *sources() { yield [product()]; },
    async refresh() { const p = product(); p.variants.nodes[0].selectedOptions[0].value = 'Split King'; return [p]; },
    async pool() { assert.fail('Disabled pool must not be fetched'); } };
  const out = memoryOutput();
  const summary = await run({ mode: 'write', config, client, repository: repo, output: out });
  assert.equal(summary.status, 'completed'); assert.equal(summary.skippedUnconfiguredCollection, 1); assert.equal(summary.written, 0);
});

test('audit excludes wrong target types with zero mutations and reports missing definitions', async () => {
  const client = { async graphql(query) { assert.match(query, /^query/); return { metafieldDefinitions: { nodes: [] } }; } };
  const repo = { async validateCollections() { return new Map([['queen', 'c']]); }, async *sources() { yield [product()]; }, async pool() { return [targetProduct('target', [variant('a', '500'), variant('b', '750')]), { ...product('wrong', [variant('wrong', '600')]), productType: 'Mattress Protector' }]; } };
  const out = memoryOutput(); const summary = await run({ mode: 'audit', config, client, repository: repo, output: out });
  assert.equal(summary.status, 'completed'); assert.equal(summary.written, 0); assert.equal(out.snapshots.length, 0);
  assert.equal(out.rows[0][1].length, 2); assert.ok(summary.definitions.every(d => d.status === 'missing_read_only_audit'));
  assert.ok(out.logs[0].rejectedReasons.some(r => r.reason === 'target_type_mismatch'));
});
test('write refreshes current price and includes ACTIVE out-of-stock targets, then verifies IDs', async () => {
  let sourceReads = 0, setInput;
  const client = { async graphql(query, vars) {
    if (query.startsWith('query Definitions')) return { metafieldDefinitions: { nodes: [{ type: { name: 'list.variant_reference' } }] } };
    if (query.startsWith('mutation SetRecommendations')) { setInput = vars.metafields; return { metafieldsSet: { userErrors: [] } }; }
    if (query.startsWith('query Verify')) return { nodes: [{ id: 'source-v', mattress: { jsonValue: ['cheap', 'backorder', 'fresh'] } }] };
    throw new Error('Unexpected operation');
  } };
  const repo = { async validateCollections() { return new Map([['queen', 'c']]); }, async *sources() { yield [product()]; },
    async refresh() { sourceReads++; return [product('source', [variant('source-v', '2000')])]; },
    async pool() { return [{ ...targetProduct('target', [{ ...variant('backorder', '1000'), availableForSale: false, sellableOnlineQuantity: 0 }, variant('fresh', '2000'), variant('cheap', '500')]), onlineStoreUrl: null }, { ...product('wrong', [variant('wrong', '1000')]), productType: 'Foundation' }]; } };
  const out = memoryOutput(); const summary = await run({ mode: 'write', config, client, repository: repo, output: out });
  assert.equal(summary.status, 'completed'); assert.equal(sourceReads, 2); assert.equal(summary.written, 1);
  assert.equal(setInput[0].value, '["cheap","backorder","fresh"]'); assert.equal(setInput[0].compareDigest, null);
  assert.equal(summary.sourcesWithExpandedPriceRange, 1);
  assert.equal(out.snapshots.length, 1); assert.equal(out.results[0][1], 'written_verified');
});
test('writer includes prior digest and does not proceed after atomic rejection', async () => {
  const source = resolveSources(product(), config).sources[0]; source.existing = { compareDigest: 'old', type: 'list.variant_reference' };
  const output = memoryOutput(), summary = { written: 0, errors: 0 };
  await assert.rejects(writeBatch({ async graphql(query, vars) {
    assert.equal(output.snapshots.length, 1); assert.equal(vars.metafields[0].compareDigest, 'old');
    return { metafieldsSet: { userErrors: [{ code: 'INVALID_COMPARE_DIGEST', message: 'Changed' }] } };
  } }, [{ source, ids: ['target'] }], output, summary), /Changed/);
  assert.equal(summary.written, 0);
});
test('definitions check before creating and reject incompatible types', async () => {
  const definitions = new Map(); let creates = 0;
  const client = { async graphql(query, vars) {
    if (query.startsWith('query')) return { metafieldDefinitions: { nodes: definitions.get(`${vars.owner}.${vars.key}`) || [] } };
    creates++; const d = vars.definition; definitions.set(`${d.ownerType}.${d.key}`, [{ type: { name: d.type } }]);
    return { metafieldDefinitionCreate: { userErrors: [] } };
  } };
  await ensureDefinitions(client, true); await ensureDefinitions(client, true); assert.equal(creates, 4);
  await assert.rejects(ensureDefinitions({ async graphql() { return { metafieldDefinitions: { nodes: [{ type: { name: 'single_line_text_field' } }] } }; } }, false), /Incompatible/);
});
test('source and overflow variant pages are fully paginated', async () => {
  const calls = [];
  const repo = new Repository({ async graphql(query, vars) {
    calls.push(query);
    if (query.startsWith('query Sources')) return { products: { nodes: [product(vars.after ? 'p2' : 'p1')], pageInfo: { hasNextPage: !vars.after, endCursor: 'next' } } };
    if (query.startsWith('query Refresh')) return { nodes: vars.ids.map(id => product(id)) };
    return { p0: { variants: { nodes: [variant('last')], pageInfo: { hasNextPage: false } } }, p1: { variants: { nodes: [variant('last2')], pageInfo: { hasNextPage: false } } } };
  } });
  const pages = []; for await (const page of repo.sources()) pages.push(page);
  assert.equal(pages.length, 2);
  const p1 = product('p1'), p2 = product('p2');
  p1.variants.pageInfo = p2.variants.pageInfo = { hasNextPage: true, endCursor: 'cursor' };
  await repo.completeVariants([p1, p2]);
  assert.equal(p1.variants.nodes.length, 2); assert.equal(p2.variants.nodes.length, 2);
  assert.equal(calls.filter(q => q.startsWith('query MoreVariants')).length, 1);
});
test('collection validation reports all missing handles', async () => {
  const repo = new Repository({ async graphql() { return { collectionByIdentifier: null }; } });
  await assert.rejects(repo.validateCollections({ a: 'missing-one', b: 'missing-two' }), /missing-one, missing-two/);
});
test('250 scanned products fetch details only for the 20 supported sources', async () => {
  let calls = 0; const detailIds = [];
  const headers = Array.from({ length: 250 }, (_, i) => ({ id: `p${i}`, title: 'Product', status: 'ACTIVE', productType: i < 20 ? ' Bed ' : 'Sofa' }));
  const repo = new Repository({ async graphql(query, vars) {
    calls++;
    if (query.startsWith('query Sources')) {
      assert.match(query, /first: 250/); assert.doesNotMatch(query, /variants\(/);
      return { products: { nodes: headers, pageInfo: { hasNextPage: false } } };
    }
    detailIds.push(...vars.ids); return { nodes: vars.ids.map(id => product(id)) };
  } });
  const scanned = []; for await (const page of repo.sources()) scanned.push(...page);
  assert.equal(scanned.length, 250); assert.equal(detailIds.length, 20); assert.equal(calls, 3);
  assert.ok(detailIds.every(id => Number(id.slice(1)) < 20));
});
test('target overflow pages remain complete without fetching recommendation metafields', async () => {
  const p = targetProduct('target'); p.variants.pageInfo = { hasNextPage: true, endCursor: 'first' };
  let calls = 0;
  const repo = new Repository({ async graphql(query) {
    calls++; assert.match(query, /MoreTargetVariants/); assert.match(query, /first: 100/);
    assert.doesNotMatch(query, /metafield|sellableOnlineQuantity|availableForSale/);
    return { p0: { variants: { nodes: [variant(`later${calls}`)], pageInfo: { hasNextPage: calls < 2, endCursor: `cursor${calls}` } } } };
  } });
  await repo.completeVariants([p], true);
  assert.equal(calls, 2); assert.equal(p.variants.nodes.length, 3);
});
test('rate-limit waits use next query cost instead of previous expensive query', async () => {
  const waits = [];
  const client = new ShopifyClient({}, { sleepFn: async ms => { waits.push(ms); }, fetchFn: async (_url, options) => {
    const { query } = JSON.parse(options.body);
    return response({ data: { ok: true }, extensions: { cost: { requestedQueryCost: query.includes('Expensive') ? 800 : 5,
      throttleStatus: { currentlyAvailable: 100, maximumAvailable: 1000, restoreRate: 100 } } } });
  } });
  client.token = 'test'; client.expires = Date.now() + 100000;
  await client.graphql('query Cheap { shop { name } }');
  await client.graphql('query Expensive { shop { name } }');
  await client.graphql('query Cheap { shop { name } }');
  assert.equal(waits.at(-1), 0);
  await client.graphql('query Expensive { shop { name } }');
  assert.ok(waits.at(-1) > 6000);
});
test('refresh batches product IDs and collection pagination includes later products', async () => {
  const lengths = [];
  const repo = new Repository({ async graphql(query, vars) {
    if (query.startsWith('query Refresh')) { lengths.push(vars.ids.length); return { nodes: vars.ids.map(id => product(id)) }; }
    return { collection: { products: { nodes: [product(vars.after ? 'second' : 'first')], pageInfo: { hasNextPage: !vars.after, endCursor: 'cursor' } } } };
  } });
  assert.equal((await repo.refresh(Array.from({ length: 25 }, (_, i) => `p${i}`))).length, 25);
  assert.deepEqual(lengths, [10, 10, 5]);
  assert.deepEqual((await repo.pool('collection')).map(p => p.id), ['first', 'second']);
});
test('write skips unchanged metafields without a mutation or snapshot', async () => {
  const p = product(); p.variants.nodes[0].mattress = { type: 'list.variant_reference', jsonValue: ['target-v'] };
  const client = { async graphql(query) { assert.match(query, /^query Definitions/); return { metafieldDefinitions: { nodes: [{ type: { name: 'list.variant_reference' } }] } }; } };
  const repo = { async validateCollections() { return new Map([['queen', 'c']]); }, async *sources() { yield [p]; },
    async refresh() { return [p]; }, async pool() { return [targetProduct('target', [variant('target-v')])]; } };
  const out = memoryOutput(); const summary = await run({ mode: 'write', config, client, repository: repo, output: out });
  assert.equal(summary.status, 'completed'); assert.equal(summary.unchangedMetafields, 1);
  assert.equal(summary.written, 0); assert.equal(out.snapshots.length, 0);
});
test('source size changed during pool refresh is skipped without writing', async () => {
  let reads = 0;
  const client = { async graphql(query) { assert.match(query, /^query Definitions/); return { metafieldDefinitions: { nodes: [{ type: { name: 'list.variant_reference' } }] } }; } };
  const repo = { async validateCollections() { return new Map([['queen', 'c']]); }, async *sources() { yield [product()]; },
    async refresh() { const p = product(); if (++reads === 2) p.variants.nodes[0].selectedOptions[0].value = 'King'; return [p]; },
    async pool() { return [targetProduct('target', [variant('target-v')])]; } };
  const out = memoryOutput(); const summary = await run({ mode: 'write', config, client, repository: repo, output: out });
  assert.equal(summary.skippedSources, 1); assert.equal(summary.written, 0);
});
test('client retries throttling and renews token after 401', async () => {
  let auth = 0, queries = 0; const waits = [];
  const client = new ShopifyClient({ domain: 'test.myshopify.com', version: '2026-07' }, {
    sleepFn: async ms => { waits.push(ms); }, fetchFn: async url => {
      if (url.includes('oauth')) { auth++; return response({ access_token: 'secret-token', expires_in: 86399 }); }
      queries++;
      if (queries === 1) return response({}, 401);
      if (queries === 2) return response({ errors: [{ extensions: { code: 'THROTTLED' } }] });
      return response({ data: { shop: { name: 'Test' } } });
    }
  });
  assert.equal((await client.graphql('query { shop { name } }')).shop.name, 'Test');
  assert.equal(auth, 2); assert.equal(queries, 3); assert.ok(waits.some(ms => ms >= 1000));
});
test('read-only client blocks mutations before auth; uncertain writes never retry', async () => {
  let calls = 0;
  const client = new ShopifyClient({}, { fetchFn: async () => { calls++; throw new Error('network'); }, sleepFn: async () => {} });
  await assert.rejects(client.graphql('mutation X { x }'), /read-only/); assert.equal(calls, 0);
  client.config.writeEnabled = true; client.token = 'token'; client.expires = Date.now() + 10000;
  await assert.rejects(client.graphql('mutation X { x }'), /outcome unknown/); assert.equal(calls, 1);
});
test('Excel and JSONL output round-trip with requested columns and snapshot', async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'ornate-recommendations-'));
  const out = await createOutput('write', directory);
  const source = resolveSources(product(), config).sources[0];
  out.audit(source, [{ label: 'Mattress - Queen', price: 5000000 }]);
  await out.log({ event: 'test' }); await out.snapshot({ previous: null }); out.writeResult(source, 'written_verified', ['v']);
  await out.finish({ status: 'completed' });
  const workbook = new ExcelJS.Workbook(); await workbook.xlsx.readFile(path.join(out.directory, 'recommendations-audit.xlsx'));
  const sheet = workbook.worksheets[0]; assert.equal(sheet.columnCount, 12); assert.equal(sheet.rowCount, 2);
  assert.equal(sheet.getCell('E2').value, 'Mattress - Queen'); assert.equal(sheet.getCell('F2').value, 500);
  assert.equal(JSON.parse(await readFile(path.join(out.directory, 'pre-write-snapshot.jsonl'), 'utf8')).previous, null);
});
