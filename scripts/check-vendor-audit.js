import { createReadStream, existsSync } from 'node:fs';
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import readline from 'node:readline';
import { readConfig } from '../src/config.js';
import { ShopifyClient } from '../src/client.js';

if (existsSync('.env')) process.loadEnvFile('.env');
const directory = process.argv[2];
if (!directory) throw new Error('Pass an audit output directory.');
const logPath = path.join(directory, 'logs', 'recommendation-details.jsonl');
const mattressTypes = new Set(['mattress', 'innerspring mattress', 'latex foam mattress', 'latex hybrid mattress', 'hybrid mattress', 'memory foam mattress']);
const normalize = value => typeof value === 'string' ? value.trim().toLowerCase() : '';
const records = [];
let excelRow = 1;
const lines = readline.createInterface({ input: createReadStream(logPath), crlfDelay: Infinity });
for await (const line of lines) {
  let entry;
  try { entry = JSON.parse(line); } catch { continue; }
  if (entry.event !== 'recommendation') continue;
  excelRow++;
  if (!mattressTypes.has(normalize(entry.sourceType))) continue;
  const selected = new Set(entry.selectedVariantIds || []);
  const vendors = new Map();
  const selectedDetails = [];
  for (const candidate of entry.eligibleCandidates || []) {
    const vendor = normalize(candidate.vendor);
    if (!vendors.has(vendor)) vendors.set(vendor, []);
    vendors.get(vendor).push(candidate.id);
    if (selected.has(candidate.id)) selectedDetails.push({ id: candidate.id, vendor: candidate.vendor || '', label: candidate.label, price: candidate.price });
  }
  records.push({ excelRow, sourceProductId: entry.sourceProductId, sourceVariantId: entry.sourceVariantId,
    sourceType: entry.sourceType, sourceSize: entry.sourceSize, sourcePrice: entry.sourcePrice,
    selectedIds: [...selected], selectedDetails, vendors, stages: entry.priceExpansionStages || [] });
}

const config = readConfig();
const client = new ShopifyClient({ ...config, writeEnabled: false });
const ids = [...new Set(records.map(record => record.sourceProductId))];
const sourceVendors = new Map();
const query = `query AuditSourceVendors($ids: [ID!]!) { nodes(ids: $ids) { ... on Product { id title vendor } } }`;
for (let offset = 0; offset < ids.length; offset += 50) {
  const data = await client.graphql(query, { ids: ids.slice(offset, offset + 50) });
  for (const product of data.nodes.filter(Boolean)) sourceVendors.set(product.id, product);
}

const failures = [], samples = { allSameVendor: [], mixedFallback: [], noSameVendor: [], blankSourceVendor: [] };
const counts = { mattressRows: records.length, allSameVendor: 0, mixedFallback: 0, noSameVendor: 0, blankSourceVendor: 0 };
for (const record of records) {
  const product = sourceVendors.get(record.sourceProductId);
  const sourceVendor = normalize(product?.vendor);
  const eligibleSame = record.vendors.get(sourceVendor) || [];
  const selectedSame = record.selectedDetails.filter(item => normalize(item.vendor) === sourceVendor).length;
  let category;
  if (!sourceVendor) category = 'blankSourceVendor';
  else if (selectedSame === 4) category = 'allSameVendor';
  else if (selectedSame > 0) category = 'mixedFallback';
  else category = 'noSameVendor';
  counts[category]++;
  const expectedSame = sourceVendor ? Math.min(4, eligibleSame.length) : 0;
  const scopeValid = sourceVendor
    ? record.stages.some(stage => stage.scope === 'same_vendor') === (eligibleSame.length > 0)
    : record.stages.every(stage => stage.scope === 'all_vendors');
  if (selectedSame !== expectedSame || !scopeValid || record.selectedIds.length !== 4 || record.selectedDetails.length !== 4) {
    failures.push({ row: record.excelRow, source: product?.title, sourceVendor: product?.vendor || '', eligibleSameVendor: eligibleSame.length,
      selectedSameVendor: selectedSame, selectedCount: record.selectedIds.length, resolvedSelectedCount: record.selectedDetails.length,
      scopes: record.stages.map(stage => stage.scope) });
  }
  if (samples[category].length < 8) samples[category].push({ row: record.excelRow, source: product?.title, sourceVendor: product?.vendor || '',
    size: record.sourceSize, price: record.sourcePrice, eligibleSameVendor: eligibleSame.length,
    recommendations: record.selectedDetails.map(item => ({ vendor: item.vendor, label: item.label, price: item.price })) });
}

const report = { auditDirectory: path.resolve(directory), checkedAt: new Date().toISOString(), ...counts,
  passedRows: records.length - failures.length, failedRows: failures.length, failures: failures.slice(0, 100), samples };
const reviewDirectory = path.join(directory, 'review');
await mkdir(reviewDirectory, { recursive: true });
await writeFile(path.join(reviewDirectory, 'vendor-check.json'), JSON.stringify(report, null, 2));
console.log(JSON.stringify({ ...counts, passedRows: report.passedRows, failedRows: report.failedRows, uniqueSourceProductsCheckedLive: ids.length,
  report: path.join(reviewDirectory, 'vendor-check.json'), samples }, null, 2));
