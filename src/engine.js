import { SIZES, keyFor } from './config.js';

const beds = `Panel Bedroom Set|Platform Bedroom Set|Bedroom Set|Poster Bedroom Set|Sleigh Bedroom Set|Beds|Bed|Panel Bed|Sleigh Bed|Platform Bed|Upholstered Bed|Queen Bed|Storage Bed|Canopy Bed|Wingback Bed|Bunk Bed|Captain Bed|Car Bed|Caster Bed|Daybed|Loft Bed|Shelter Bed|Youth Bed|Trundle Bed|Poster Bed|Youth Bedroom Set|Bookcase Bedroom Set|Poster Bedroom Sets|Panel Bedroom Sets`;
const mattresses = 'Mattress|Innerspring Mattress|Latex Foam Mattress|Latex Hybrid Mattress|Hybrid Mattress|Memory Foam Mattress | Local Mattresses';
const types = new Map([...beds.split('|').map(x => [x.trim().toLowerCase(), 'mattress']), ...mattresses.split('|').map(x => [x.trim().toLowerCase(), 'adjustable_base'])]);
export const typeGroup = type => types.get((type || '').trim().toLowerCase());
const targetTypes = {
  mattress: new Set(`${mattresses}|Local Mattresses|Futon Mattress`.split('|').map(x => x.trim().toLowerCase())),
  adjustable_base: new Set(['adjustable bed base', 'adjustable base', 'adjustable bed'])
};
export const targetTypeMatches = (group, type) => targetTypes[group]?.has((type || '').trim().toLowerCase()) ?? false;
const sizeAliases = new Map([
  ['eastern king', 'King'], ['full/double', 'Full'],
  ['cal king', 'California King'], ['cal. king', 'California King'],
  ['split cal king', 'Split California King'], ['split cal. king', 'Split California King']
]);
export function normalizeSize(value) {
  if (typeof value !== 'string') return null;
  const normalized = value.trim().replace(/\s+/g, ' ').replace(/\s*\/\s*/g, '/').toLowerCase();
  return sizeAliases.get(normalized) || SIZES.find(s => s.toLowerCase() === normalized) || null;
}
export function sizeOf(product, variant, names) {
  const options = (variant?.selectedOptions || []).filter(o => names.includes(o.name.trim().toLowerCase()));
  if (options.length) {
    const sizes = options.map(o => normalizeSize(o.value));
    return sizes.every(Boolean) && new Set(sizes).size === 1 ? sizes[0] : null;
  }
  let raw = product.size?.jsonValue ?? product.size?.value;
  if (typeof raw === 'string' && raw.trim().startsWith('[')) {
    try { raw = JSON.parse(raw); } catch { return null; }
  }
  if (!Array.isArray(raw)) return normalizeSize(raw);
  // A product-level list may describe multiple sizes; never guess a variant's size from it.
  const sizes = raw.map(normalizeSize);
  return sizes.length && sizes.every(Boolean) && new Set(sizes).size === 1 ? sizes[0] : null;
}
// Four decimal fixed-point units preserve Shopify money and avoid binary float boundaries.
export function money(value) {
  if (!/^\d+(\.\d{1,4})?$/.test(String(value))) return null;
  const [whole, fraction = ''] = String(value).split('.');
  const units = Number(whole) * 10000 + Number(fraction.padEnd(4, '0'));
  return Number.isSafeInteger(units * 20) && units > 0 ? units : null;
}
export const displayMoney = units => units / 10000;
const normalizedVendor = vendor => typeof vendor === 'string' ? vendor.trim().toLowerCase() : '';
export function resolveSources(product, config) {
  if (product.status !== 'ACTIVE') return { sources: [], reason: 'inactive_source' };
  const group = typeGroup(product.productType);
  if (!group) return { sources: [], reason: 'invalid_source_type' };
  const variants = product.variants.nodes;
  const variantBased = variants.some(v => v.selectedOptions.some(o => config.sizeOptions.includes(o.name.trim().toLowerCase())))
    || new Set(variants.map(v => money(v.price))).size > 1;
  const sources = [], rejected = [];
  const add = (owner, variant, skus) => {
    const size = sizeOf(product, variant, config.sizeOptions);
    const price = money(variant.price);
    if (!size || !price) { rejected.push({ ownerId: owner.id, reason: !size ? 'missing_size' : 'invalid_source_price' }); return; }
    sources.push({ ownerId: owner.id, productId: product.id, variantId: owner === product ? null : variant.id,
      title: product.title, type: product.productType, vendor: product.vendor || '', size, price, group, key: keyFor(group),
      sku: [...new Set(skus.map(x => x?.trim()).filter(Boolean))].join(', '), existing: owner[group] || null });
  };
  if (variantBased) for (const variant of variants) add(variant, variant, [variant.sku]);
  else if (variants.length) add(product, variants[0], variants.map(v => v.sku));
  else rejected.push({ ownerId: product.id, reason: 'no_source_variants' });
  return { sources, rejected };
}

export function candidatesFor(source, products, config, tolerance = 50) {
  const eligible = [], rejected = [], seen = new Set();
  for (const product of products) for (const variant of product.variants.nodes) {
    if (seen.has(variant.id)) continue;
    seen.add(variant.id);
    const price = money(variant.price);
    let reason;
    if (product.id === source.productId) reason = 'same_source_product';
    else if (product.status !== 'ACTIVE') reason = 'inactive_target';
    else if (!targetTypeMatches(source.group, product.productType)) reason = 'target_type_mismatch';
    else if (/\bbox\s*[ab]\b/i.test(product.title)) reason = 'component_box_a_b';
    else if (/\bhalf\b/i.test(product.title)) reason = 'half_size_product';
    else if (source.size === 'Twin' && /\btwin\s*(xl|extra long)\b/i.test(product.title)) reason = 'title_size_conflicts_with_metafield';
    else if (sizeOf(product, variant, config.sizeOptions) !== source.size) reason = 'size_mismatch_or_unknown';
    else if (!price) reason = 'invalid_price';
    else if (tolerance !== null && !withinRange(source.price, price, tolerance)) reason = 'outside_price_range';
    if (reason) rejected.push({ variantId: variant.id, productId: product.id, productType: product.productType, price: variant.price, reason });
    else eligible.push({ id: variant.id, productId: product.id, productType: product.productType, vendor: product.vendor || '', price,
      label: `${product.title} - ${variant.title === 'Default Title' ? source.size : variant.title}` });
  }
  return { eligible, rejected };
}
export function withinRange(sourcePrice, candidatePrice, tolerance) {
  return candidatePrice * 10 >= sourcePrice * (10 - tolerance / 10)
    && candidatePrice * 10 <= sourcePrice * (10 + tolerance / 10);
}
export function recommend(source, products, config) {
  // Resolve size/status once; progressively admit wider price bands without replacing prior picks.
  const pool = candidatesFor(source, products, config, null);
  const requiredBand = c => Math.max(50, Math.ceil(Math.abs(c.price - source.price) * 10 / source.price) * 10);
  const selected = [], stages = [];
  let eligible = [], tolerance = 50;
  const sourceVendor = normalizedVendor(source.vendor);
  const preferVendor = source.group === 'adjustable_base' && sourceVendor;
  const pools = preferVendor
    ? [
      { scope: 'same_vendor', candidates: pool.eligible.filter(c => normalizedVendor(c.vendor) === sourceVendor) },
      { scope: 'other_vendors', candidates: pool.eligible.filter(c => normalizedVendor(c.vendor) !== sourceVendor) }
    ]
    : [{ scope: 'all_vendors', candidates: pool.eligible }];
  for (const candidatePool of pools) {
    if (!candidatePool.candidates.length) continue;
    const scopeBands = [...new Set([50, ...candidatePool.candidates.map(requiredBand)])].sort((a, b) => a - b);
    for (const step of scopeBands) {
      tolerance = Math.max(tolerance, step);
      eligible = candidatePool.candidates.filter(c => requiredBand(c) <= step);
      const used = new Set(selected.map(c => c.id));
      selected.push(...selectTiers(source.price, eligible.filter(c => !used.has(c.id)), selected.length));
      stages.push({ scope: candidatePool.scope, tolerancePercent: step, eligibleCount: eligible.length, selectedCount: selected.length });
      if (selected.length === 4 || eligible.length === candidatePool.candidates.length) break;
    }
    if (selected.length === 4) break;
  }
  const considered = new Set(selected.map(c => c.id));
  eligible = pool.eligible.filter(c => considered.has(c.id) || requiredBand(c) <= tolerance);
  const rejected = [...pool.rejected, ...pool.eligible.filter(c => !considered.has(c.id) && requiredBand(c) > tolerance)
    .map(c => ({ variantId: c.id, price: String(displayMoney(c.price)), reason: 'outside_price_range' }))];
  // Tier selection order reflects band expansion, not price; present recommendations lowest to highest.
  selected.sort((a, b) => a.price - b.price || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  return { eligible, rejected, selected, tolerance, stages };
}
export function selectTiers(sourcePrice, candidates, startSlot = 0) {
  const remaining = new Map(candidates.map(c => [c.id, c]));
  const selected = [];
  // Four evenly spaced targets across the admitted band: -50%, -16.7%, +16.7%, +50% of source price.
  for (const multiplier of [3, 5, 7, 9].slice(startSlot)) {
    let best;
    for (const candidate of remaining.values()) {
      if (!best || Math.abs(candidate.price * 6 - sourcePrice * multiplier) < Math.abs(best.price * 6 - sourcePrice * multiplier)
        || (Math.abs(candidate.price * 6 - sourcePrice * multiplier) === Math.abs(best.price * 6 - sourcePrice * multiplier)
          && (candidate.price < best.price || (candidate.price === best.price && candidate.id < best.id)))) best = candidate;
    }
    if (!best) break;
    selected.push(best); remaining.delete(best.id);
  }
  return selected;
}
export function sameReferences(existing, ids) {
  if (!existing) return false;
  let previous = existing.jsonValue;
  if (previous === undefined) { try { previous = JSON.parse(existing.value); } catch { return false; } }
  return Array.isArray(previous) && JSON.stringify(previous) === JSON.stringify(ids);
}
