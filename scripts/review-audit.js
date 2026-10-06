import ExcelJS from 'exceljs';
import { createReadStream, existsSync } from 'node:fs';
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { createInterface } from 'node:readline';
import path from 'node:path';
import { typeGroup, targetTypeMatches, normalizeSize, money, sizeOf } from '../src/engine.js';
import { readConfig } from '../src/config.js';
import { ShopifyClient } from '../src/client.js';

const directory = process.argv[2];
if (!directory) throw new Error('Pass an audit output directory.');
const reviewDir = path.join(directory, 'review');
await mkdir(reviewDir, { recursive: true });
if (existsSync('.env')) process.loadEnvFile('.env');
const config = readConfig();
const issues = [], histogram = {}, sources = new Set(), owners = new Set(), targets = new Set(), references = [];
const shortRows = [];
const add = (row, severity, code, detail) => issues.push({ row, severity, code, detail });
const wb = new ExcelJS.Workbook();
await wb.xlsx.readFile(path.join(directory, 'recommendations-audit.xlsx'));
const sheet = wb.worksheets[0];
const summary = JSON.parse(await readFile(path.join(directory, 'run-summary.json'), 'utf8'));
let count = 0, expanded = 0, candidateCount = 0;
const skips = {};
for await (const line of createInterface({ input: createReadStream(path.join(directory, 'logs/recommendation-details.jsonl')), crlfDelay: Infinity })) {
  const r = JSON.parse(line);
  if (r.event === 'source_skipped') skips[r.reason] = (skips[r.reason] || 0) + 1;
  if (r.event !== 'recommendation') continue;
  const rowNo = ++count + 1, row = sheet.getRow(rowNo);
  if (count % 3000 === 0) console.log(`Checked ${count} rows`);
  sources.add(r.sourceProductId);
  if (owners.has(r.ownerId)) add(rowNo, 'error', 'duplicate_source_owner', r.ownerId);
  owners.add(r.ownerId);
  const group = typeGroup(r.sourceType);
  if (!group) add(rowNo, 'error', 'unsupported_source_type', r.sourceType);
  if (r.collectionUsed !== config.collections[`${group}:${r.sourceSize}`]) add(rowNo, 'review', 'collection_differs_from_current_config', r.collectionUsed);
  if (normalizeSize(r.sourceSize) !== r.sourceSize) add(rowNo, 'error', 'invalid_source_size', r.sourceSize);
  if (row.getCell(3).value !== r.sourceSize || money(String(row.getCell(4).value)) !== money(String(r.sourcePrice))) add(rowNo, 'error', 'source_excel_log_mismatch', r.ownerId);
  const n = r.selectedVariantIds.length;
  histogram[n] = (histogram[n] || 0) + 1;
  if (n < 4) {
    const reasons = {}; for (const rejected of r.rejectedReasons) reasons[rejected.reason] = (reasons[rejected.reason] || 0) + 1;
    shortRows.push({ row: rowNo, sku: row.getCell(1).value, source: row.getCell(2).value, size: r.sourceSize,
      collection: r.collectionUsed, selected: n, eligible: r.eligibleCandidates.length, tolerance: r.priceTolerancePercent, reasons });
  }
  if (n > 4 || new Set(r.selectedVariantIds).size !== n) add(rowNo, 'error', 'duplicate_or_excess_recommendations', r.selectedVariantIds.join(','));
  if (n < 4 && r.eligibleCandidates.length >= 4) add(rowNo, 'error', 'unfilled_slots', String(r.eligibleCandidates.length));
  const eligible = new Map(r.eligibleCandidates.map(c => [c.id, c]));
  for (const candidate of r.eligibleCandidates) {
    if (candidate.productType !== undefined && !targetTypeMatches(group, candidate.productType)) add(rowNo, 'error', 'logged_target_type_mismatch', `${candidate.id}: ${candidate.productType}`);
  }
  candidateCount += r.eligibleCandidates.length;
  if (r.priceTolerancePercent > 50) expanded++;
  // Independent replay: preserve prior picks, widen in occupied 10-point bands, rank each remaining slot.
  const sourcePrice = money(String(r.sourcePrice));
  const requiredBand = c => Math.max(50, Math.ceil(Math.abs(money(String(c.price)) - sourcePrice) * 10 / sourcePrice) * 10);
  const bands = [...new Set([50, ...r.eligibleCandidates.map(requiredBand)])].sort((a, b) => a - b);
  const expected = [];
  for (const band of bands) {
    while (expected.length < 4) {
      const multiplier = [3, 5, 7, 9][expected.length];
      const options = r.eligibleCandidates.filter(c => !expected.includes(c.id) && requiredBand(c) <= band).sort((a, b) => {
        const ap = money(String(a.price)), bp = money(String(b.price));
        return Math.abs(ap * 6 - sourcePrice * multiplier) - Math.abs(bp * 6 - sourcePrice * multiplier)
          || ap - bp || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0);
      });
      if (!options.length) break;
      expected.push(options[0].id);
    }
    if (expected.length === 4) break;
  }
  if (JSON.stringify(expected) !== JSON.stringify(r.selectedVariantIds)) add(rowNo, 'error', 'selection_replay_mismatch', r.ownerId);
  for (let i = 0; i < 4; i++) {
    const id = r.selectedVariantIds[i], candidate = eligible.get(id);
    const label = row.getCell(5 + 2 * i).value, price = row.getCell(6 + 2 * i).value;
    if (!id) { if (label || price) add(rowNo, 'error', 'extra_excel_recommendation', String(i + 1)); continue; }
    if (!candidate) { add(rowNo, 'error', 'selected_not_eligible', id); continue; }
    if (candidate.productId === r.sourceProductId) add(rowNo, 'error', 'self_recommendation', id);
    if (label !== candidate.label || money(String(price)) !== money(String(candidate.price)) || money(String(price)) !== money(String(r.selectedPrices[i]))) add(rowNo, 'error', 'recommendation_excel_log_mismatch', id);
    if (requiredBand(candidate) > r.priceTolerancePercent) add(rowNo, 'error', 'outside_logged_price_band', id);
    targets.add(id);
    references.push({ row: rowNo, source: row.getCell(2).value, sku: row.getCell(1).value, group, size: r.sourceSize,
      id, label: candidate.label, price: candidate.price, collection: r.collectionUsed });
  }
}
if (sheet.rowCount - 1 !== count || summary.sourceRecords !== count) add(0, 'error', 'row_count_mismatch', JSON.stringify({ excel: sheet.rowCount - 1, logs: count, summary: summary.sourceRecords }));
if (summary.candidateCount !== candidateCount || summary.sourcesWithExpandedPriceRange !== expanded || summary.eligibleSourceProducts !== sources.size) add(0, 'error', 'summary_mismatch', JSON.stringify({ candidateCount, expanded, uniqueProducts: sources.size }));
const report = { checkedAt: new Date().toISOString(), directory, rows: count, uniqueSourceProducts: sources.size, recommendationReferences: references.length,
  uniqueTargetVariants: targets.size, histogram, expandedRows: expanded, skipped: skips, liveChecked: false };
await writeFile(path.join(reviewDir, 'references.json'), JSON.stringify(references));
await writeFile(path.join(reviewDir, 'offline-issues.json'), JSON.stringify(issues));
await writeFile(path.join(reviewDir, 'short-rows.json'), JSON.stringify(shortRows, null, 2));
await writeFile(path.join(reviewDir, 'summary.json'), JSON.stringify({ ...report, issueCount: issues.length }, null, 2));
console.log(JSON.stringify({ ...report, issueCount: issues.length, examples: issues.slice(0, 5) }, null, 2));

if (process.argv.includes('--live')) {
  const client = new ShopifyClient({ ...config, writeEnabled: false });
  const query = `query ReviewTargets($ids: [ID!]!) { nodes(ids: $ids) { ... on ProductVariant {
    id title price selectedOptions { name value } product { id title productType status size: metafield(namespace: "ornate", key: "size") { value jsonValue } }
  } } }`;
  const ids = [...targets], current = new Map();
  for (let offset = 0; offset < ids.length; offset += 50) {
    const { nodes } = await client.graphql(query, { ids: ids.slice(offset, offset + 50) });
    for (const v of nodes.filter(Boolean)) current.set(v.id, v);
    console.log(`Live target check ${Math.min(offset + 50, ids.length)}/${ids.length}`);
  }
  await writeFile(path.join(reviewDir, 'live-targets.json'), JSON.stringify([...current.values()]));
  for (const ref of references) {
    const v = current.get(ref.id);
    if (!v) { add(ref.row, 'review', 'target_missing_now', ref.label); continue; }
    if (v.product.status !== 'ACTIVE') add(ref.row, 'review', 'target_inactive_now', `${ref.label}: ${v.product.status}`);
    if (sizeOf(v.product, v, config.sizeOptions) !== ref.size) add(ref.row, 'review', 'target_size_mismatch_now', `${ref.label}: ${sizeOf(v.product, v, config.sizeOptions)}`);
    if (money(v.price) !== money(String(ref.price))) add(ref.row, 'review', 'target_price_changed', `${ref.label}: ${ref.price} -> ${v.price}`);
    if (!targetTypeMatches(ref.group, v.product.productType)) add(ref.row, 'review', 'target_type_mismatch_now', `${ref.label}; type=${v.product.productType}`);
    if (/\b(box\s*[ab]|half|split)\b/i.test(v.product.title)) add(ref.row, 'review', 'possible_partial_or_split_product', `${ref.label}; declaredSize=${ref.size}`);
  }
  report.liveChecked = true;
  const counts = {}; for (const issue of issues) counts[issue.code] = (counts[issue.code] || 0) + 1;
  await writeFile(path.join(reviewDir, 'summary.json'), JSON.stringify({ ...report, issueCount: issues.length, issueCounts: counts }, null, 2));
  await writeFile(path.join(reviewDir, 'issues.json'), JSON.stringify(issues));
  const csv = value => `"${String(value ?? '').replaceAll('"', '""')}"`;
  await writeFile(path.join(reviewDir, 'issues.csv'), '\ufeff' + ['Excel Row,Severity,Code,Detail', ...issues.map(x => [x.row, x.severity, x.code, x.detail].map(csv).join(','))].join('\r\n'));
  console.log(JSON.stringify({ ...report, issueCounts: counts, examples: issues.slice(0, 8) }, null, 2));
}
