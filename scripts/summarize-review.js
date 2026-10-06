import { readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { targetTypeMatches } from '../src/engine.js';
const dir = process.argv[2];
const load = async name => JSON.parse(await readFile(path.join(dir, name), 'utf8'));
const refs = await load('references.json'), targets = new Map((await load('live-targets.json')).map(v => [v.id, v]));
const summary = await load('summary.json');
const findings = [], categories = new Map(), collections = new Map();
function add(ref, code, v) {
  findings.push({ row: ref.row, code, sku: ref.sku, source: ref.source, sourceSize: ref.size, collection: ref.collection,
    target: ref.label, targetType: v.product.productType, targetId: v.id });
  if (!categories.has(code)) categories.set(code, { occurrences: 0, rows: new Set(), variants: new Set(), examples: [] });
  const c = categories.get(code); c.occurrences++; c.rows.add(ref.row); c.variants.add(ref.id);
  if (c.examples.length < 3) c.examples.push({ row: ref.row, source: ref.source, target: ref.label, type: v.product.productType });
  if (code.startsWith('non_')) {
    if (!collections.has(ref.collection)) collections.set(ref.collection, { rows: new Set(), count: 0 });
    const item = collections.get(ref.collection); item.rows.add(ref.row); item.count++;
  }
}
for (const ref of refs) {
  const v = targets.get(ref.id); if (!v) continue;
  if (ref.group === 'mattress' && !targetTypeMatches(ref.group, v.product.productType)) add(ref, 'non_mattress_in_mattress_pool', v);
  if (ref.group === 'adjustable_base' && !targetTypeMatches(ref.group, v.product.productType)) add(ref, 'non_adjustable_base_in_base_pool', v);
  if (/\bbox\s*[ab]\b/i.test(v.product.title)) add(ref, 'possible_component_box_a_b', v);
  if (/\bhalf\b/i.test(v.product.title)) add(ref, 'possible_half_size_product', v);
  if (ref.size === 'Twin' && /\btwin\s*(xl|extra long)\b/i.test(v.product.title)) add(ref, 'title_size_conflicts_with_metafield', v);
}
const counts = Object.fromEntries([...categories].map(([code, c]) => [code, { occurrences: c.occurrences, rows: c.rows.size, variants: c.variants.size, examples: c.examples }]));
const affectedRows = new Set(findings.filter(f => f.code.startsWith('non_')).map(f => f.row)).size;
const { issueCount, issueCounts, ...baseSummary } = summary;
const report = { ...baseSummary, classificationNote: 'Local Mattresses and Futon Mattress count as mattresses; title-based component/half-size flags require merchant review.',
  contentFindings: counts, wrongCategoryAffectedRows: affectedRows, collections: Object.fromEntries([...collections].map(([k, v]) => [k, { rows: v.rows.size, occurrences: v.count }])) };
await writeFile(path.join(dir, 'content-review.json'), JSON.stringify(report, null, 2));
const headers = ['row','code','sku','source','sourceSize','collection','target','targetType','targetId'];
const csv = v => `"${String(v ?? '').replaceAll('"', '""')}"`;
await writeFile(path.join(dir, 'content-findings.csv'), '\ufeff' + [headers.join(','), ...findings.map(f => headers.map(k => csv(f[k])).join(','))].join('\r\n'));
console.log(JSON.stringify({ counts, wrongCategoryAffectedRows: affectedRows, collections: report.collections }, null, 2));
