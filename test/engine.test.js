import test from 'node:test';
import assert from 'node:assert/strict';
import { SIZES, GROUPS, envKey, readConfig, writeGuard } from '../src/config.js';
import { typeGroup, targetTypeMatches, normalizeSize, sizeOf, money, resolveSources, candidatesFor, selectTiers, sameReferences, recommend } from '../src/engine.js';
import { writeDecision } from '../src/writer.js';

export const config = { sizeOptions: ['size'], empty: 'preserve', collections: { 'mattress:Queen': 'queen-mattresses' } };
export const variant = (id = 'v1', price = '1000', size = 'Queen') => ({ id, title: size, sku: id, price, availableForSale: true, sellableOnlineQuantity: 10, selectedOptions: [{ name: 'Size', value: size }] });
export const product = (id = 'p1', variants = [variant()]) => ({ id, title: 'Example', vendor: 'Source Vendor', status: 'ACTIVE', onlineStoreUrl: 'https://example.com/products/example', productType: 'Bed', size: { jsonValue: 'Queen' }, variants: { nodes: variants, pageInfo: { hasNextPage: false } } });

const targetProduct = (...args) => ({ ...product(...args), productType: 'Mattress' });

test('exact source type matching trims and ignores case', () => {
  assert.equal(typeGroup('  PANEL BEDROOM SET '), 'mattress');
  assert.equal(typeGroup('Latex Hybrid Mattress'), 'adjustable_base');
  assert.equal(typeGroup('Local Mattresses'), 'adjustable_base');
  assert.equal(typeGroup('Bedside Table'), undefined);
});
test('target allowlists accept actual mattress/base types and reject accessories or missing types', () => {
  for (const type of ['Mattress', 'Innerspring Mattress', 'Latex Foam Mattress', 'Latex Hybrid Mattress', 'Hybrid Mattress', 'Memory Foam Mattress', 'Local Mattresses', 'Futon Mattress']) {
    assert.equal(targetTypeMatches('mattress', ` ${type.toUpperCase()} `), true);
    assert.equal(targetTypeMatches('adjustable_base', type), false);
  }
  for (const type of ['Adjustable Bed Base', 'Adjustable Base', 'Adjustable Bed']) {
    assert.equal(targetTypeMatches('adjustable_base', ` ${type.toUpperCase()} `), true);
    assert.equal(targetTypeMatches('mattress', type), false);
  }
  for (const type of ['Mattress Protector', 'Mattress Topper', 'Foundation', 'Box Spring', 'Sheet', 'Bed', '', undefined]) {
    assert.equal(targetTypeMatches('mattress', type), false);
    assert.equal(targetTypeMatches('adjustable_base', type), false);
  }
});
test('both directions skip wrong-type bargains and fill four from correct types at wider prices', () => {
  for (const [sourceType, allowedType, rejectedType] of [['Bed', 'Local Mattresses', 'Mattress Protector'], ['Mattress', 'Adjustable Bed Base', 'Mattress']]) {
    const source = resolveSources({ ...product(), productType: sourceType }, config).sources[0];
    const rejectedProduct = { ...product('wrong', [variant('wrong', '500')]), productType: rejectedType };
    const good = { ...product('good', ['600','900','1100','2000','4000'].map((price, i) => variant(`good${i}`, price))), productType: allowedType };
    const result = recommend(source, [rejectedProduct, good], config);
    assert.equal(result.selected.length, 4);
    assert.ok(result.selected.every(c => c.productType === allowedType));
    assert.ok(result.tolerance > 80);
    assert.equal(result.rejected[0].reason, 'target_type_mismatch');
    assert.equal(result.rejected[0].productType, rejectedType);
  }
});
test('all supported sizes and Eastern King normalize', () => {
  for (const size of SIZES) assert.equal(normalizeSize(` ${size.toLowerCase()} `), size);
  assert.equal(normalizeSize('Eastern King'), 'King');
  assert.equal(normalizeSize('Super King'), null);
});
test('variant size wins, missing option falls back, unsupported explicit size does not', () => {
  const p = product();
  assert.equal(sizeOf(p, variant('x', '1', 'King'), config.sizeOptions), 'King');
  assert.equal(sizeOf(p, { selectedOptions: [] }, config.sizeOptions), 'Queen');
  assert.equal(sizeOf(p, variant('x', '1', 'Unknown'), config.sizeOptions), null);
});
test('size aliases apply to variant options and both metafield representations', () => {
  for (const [alias, expected] of [['Full/Double', 'Full'], ['Full /Double', 'Full'], [' Full / Double ', 'Full'],
    ['Cal King', 'California King'], ['Cal. King', 'California King'],
    ['Split Cal King', 'Split California King'], ['Split Cal. King', 'Split California King']]) {
    assert.equal(normalizeSize(alias), expected);
    assert.equal(sizeOf(product(), variant('v', '100', alias), config.sizeOptions), expected);
    for (const size of [{ jsonValue: alias }, { value: alias }]) {
      assert.equal(sizeOf({ ...product(), size }, { selectedOptions: [] }, config.sizeOptions), expected);
    }
  }
});
test('single-size Shopify list metafields resolve for sources and targets', () => {
  for (const size of [{ jsonValue: ['Cal. King'] }, { value: '["California King"]' }]) {
    const p = { ...product('source', [{ ...variant('s', '589'), selectedOptions: [] }]), size };
    const source = resolveSources(p, config).sources[0];
    assert.equal(source.size, 'California King');
    const target = { ...targetProduct('target', [{ ...variant('t', '689'), selectedOptions: [] }]), size };
    assert.deepEqual(recommend(source, [target], config).selected.map(c => c.id), ['t']);
  }
});
test('ambiguous or invalid size lists remain unresolved and variant option takes priority', () => {
  for (const raw of [[], ['Twin', 'Queen'], ['Queen', 'Unknown'], '[broken']) {
    const p = { ...product(), size: { jsonValue: raw } };
    assert.equal(sizeOf(p, { selectedOptions: [] }, config.sizeOptions), null);
    assert.equal(sizeOf(p, variant('v', '100', 'King'), config.sizeOptions), 'King');
  }
});
test('Split California King sources match aliases but never California King or Split King targets', () => {
  const source = resolveSources(product('p', [variant('s', '1000', 'Split Cal. King')]), config).sources[0];
  assert.equal(source.size, 'Split California King');
  const target = targetProduct('t', [variant('match', '1000', 'Split Cal King'), variant('cal', '1000', 'Cal King'), variant('split', '1000', 'Split King')]);
  assert.deepEqual(candidatesFor(source, [target], config).eligible.map(v => v.id), ['match']);
});
test('size variants produce variant owners with their own prices', () => {
  const result = resolveSources(product('p', [variant('q', '100', 'Queen'), variant('k', '200', 'King')]), config);
  assert.deepEqual(result.sources.map(s => [s.ownerId, s.size, s.price]), [['q', 'Queen', money('100')], ['k', 'King', money('200')]]);
});
test('product-level source uses shared price and joins nonblank unique SKUs', () => {
  const vs = ['A', '', 'B', 'A'].map((sku, i) => ({ ...variant(`v${i}`), sku, selectedOptions: [] }));
  const result = resolveSources(product('p', vs), config);
  assert.equal(result.sources[0].ownerId, 'p'); assert.equal(result.sources[0].sku, 'A, B');
});
test('different prices without size options use product size and each variant price', () => {
  const p = product('p', [variant('a', '100'), variant('b', '200')]);
  p.variants.nodes.forEach((v, i) => { v.selectedOptions = [{ name: 'Color', value: i ? 'Walnut' : 'White' }]; });
  const result = resolveSources(p, config);
  assert.deepEqual(result.rejected, []);
  assert.deepEqual(result.sources.map(s => [s.ownerId, s.variantId, s.size, s.price, s.sku]),
    [['a', 'a', 'Queen', money('100'), 'a'], ['b', 'b', 'Queen', money('200'), 'b']]);
  const targets = targetProduct('target', [variant('low', '60'), variant('high', '250')]);
  assert.deepEqual(result.sources.map(s => selectTiers(s.price, candidatesFor(s, [targets], config).eligible).map(c => c.id)),
    [['low'], ['high']]);
});
test('inactive sources and missing size are skipped', () => {
  assert.equal(resolveSources({ ...product(), status: 'DRAFT' }, config).sources.length, 0);
  assert.equal(resolveSources(product('p', [variant('v', '100', 'Unknown')]), config).rejected[0].reason, 'missing_size');
});
test('price range includes exactly 50 and 150 percent', () => {
  const source = resolveSources(product(), config).sources[0];
  const p = targetProduct('target', ['499.9999', '500', '1500', '1500.0001'].map((price, i) => variant(`t${i}`, price)));
  assert.deepEqual(candidatesFor(source, [p], config).eligible.map(c => c.price), [money('500'), money('1500')]);
});
test('price expansion preserves earlier choices and fills missing slots through 80 percent', () => {
  const source = resolveSources(product(), config).sources[0];
  const targets = targetProduct('t', [variant('initial', '1000'), variant('sixty', '1600'), variant('seventy', '1700'), variant('eighty', '1800'), variant('low', '200'), variant('too-low', '199.9999'), variant('too-high', '1800.0001')]);
  const result = recommend(source, [targets], config);
  assert.deepEqual(result.selected.map(c => c.id), ['initial', 'sixty', 'seventy', 'eighty']);
  assert.deepEqual(result.stages.map(s => s.selectedCount), [1, 2, 3, 4]);
  assert.equal(result.tolerance, 80);
  assert.deepEqual(result.rejected.map(r => r.variantId), ['too-low', 'too-high']);
});
test('expansion stops at first sufficient band and never relaxes size or status', () => {
  const source = resolveSources(product(), config).sources[0];
  const base = ['500', '750', '1000', '1250', '1500'].map((price, i) => variant(`v${i}`, price));
  assert.equal(recommend(source, [targetProduct('t', base)], config).tolerance, 50);
  base[4] = variant('expanded', '1600');
  assert.equal(recommend(source, [targetProduct('t', base)], config).tolerance, 50);
  const result = recommend(source, [targetProduct('t', [variant('low', '200'), variant('wrong-size', '1000', 'King')]), { ...product('inactive'), status: 'DRAFT' }], config);
  assert.deepEqual(result.selected.map(c => c.id), ['low']);
  assert.equal(result.tolerance, 80);
});
test('price range expands beyond 80 percent to fill four Twin recommendations', () => {
  const source = resolveSources(product('s', [variant('s1', '329', 'Twin')]), config).sources[0];
  const targets = targetProduct('t', ['89', '439', '359', '1319', '1219'].map((price, i) => variant(`v${i}`, price, 'Twin')));
  const result = recommend(source, [targets, { ...product('archived', [variant('arch', '599', 'Twin')]), status: 'ARCHIVED' }], config);
  assert.deepEqual(result.selected.map(c => c.price), ['89', '359', '439', '1219'].map(money));
  assert.equal(result.tolerance, 280);
  assert.ok(result.rejected.some(c => c.reason === 'inactive_target'));
});
test('unlimited expansion terminates with fewer than four candidates or no candidates', () => {
  const source = resolveSources(product(), config).sources[0];
  const result = recommend(source, [targetProduct('t', [variant('expensive', '100000000')])], config);
  assert.equal(result.selected.length, 1); assert.equal(result.stages.length, 2);
  assert.equal(recommend(source, [], config).selected.length, 0);
});
test('mattress sources prioritize same-vendor adjustable bases, then fill from other vendors', () => {
  const source = resolveSources({ ...product(), productType: 'Mattress', vendor: ' Ashley ' }, config).sources[0];
  const sameVendor = { ...targetProduct('same', [variant('same-near', '900'), variant('same-far', '3000')]), productType: 'Adjustable Base', vendor: 'ashley' };
  const otherVendor = { ...targetProduct('other', [variant('other1', '500'), variant('other2', '750'), variant('other3', '1000'), variant('other4', '1250')]), productType: 'Adjustable Bed Base', vendor: 'Other' };
  const result = recommend(source, [otherVendor, sameVendor], config);
  assert.equal(result.selected.length, 4);
  assert.ok(result.selected.some(c => c.id === 'same-near'));
  assert.ok(result.selected.some(c => c.id === 'same-far'));
  assert.equal(result.selected.filter(c => c.vendor.toLowerCase() === 'ashley').length, 2);
  assert.deepEqual(result.stages.map(s => s.scope), ['same_vendor', 'same_vendor', 'other_vendors']);
});
test('vendor preference applies only to mattress-to-adjustable-base recommendations', () => {
  const source = resolveSources({ ...product(), productType: 'Bed', vendor: 'Ashley' }, config).sources[0];
  const farSameVendor = { ...targetProduct('same', [variant('same', '3000')]), vendor: 'Ashley' };
  const nearbyOthers = { ...targetProduct('other', ['500', '750', '1000', '1250'].map((price, i) => variant(`other${i}`, price))), vendor: 'Other' };
  const result = recommend(source, [farSameVendor, nearbyOthers], config);
  assert.ok(result.selected.every(c => c.vendor === 'Other'));
  assert.ok(result.stages.every(s => s.scope === 'all_vendors'));
});
test('blank source vendor keeps the original price-first behavior', () => {
  const source = resolveSources({ ...product(), productType: 'Mattress', vendor: ' ' }, config).sources[0];
  const targets = { ...targetProduct('targets', ['500', '750', '1000', '1250', '3000'].map((price, i) => variant(`v${i}`, price))), productType: 'Adjustable Base', vendor: 'Other' };
  const result = recommend(source, [targets], config);
  assert.deepEqual(result.selected.map(c => c.id), ['v0', 'v1', 'v2', 'v3']);
  assert.ok(result.stages.every(s => s.scope === 'all_vendors'));
});
test('four target slots choose nearest distinct candidates', () => {
  const prices = ['1500', '500', '1000', '750', '1250'];
  const result = selectTiers(money('1000'), prices.map((p, i) => ({ id: String(i), price: money(p) })));
  assert.deepEqual(result.map(c => c.price), ['500', '750', '1250', '1500'].map(money));
});
test('nearest selection uses deterministic price/ID ties and exact variant dedupe', () => {
  const result = selectTiers(money('1000'), [{ id: 'z', price: money('600') }, { id: 'a', price: money('600') }, { id: 'a', price: money('600') }, { id: 'b', price: money('800') }]);
  assert.deepEqual(result.map(c => c.id), ['a', 'b', 'z']);
});
test('linear selector matches previous sorting for ties, duplicates and varying prices', () => {
  let seed = 17;
  const random = () => { seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0; return seed; };
  for (let run = 0; run < 100; run++) {
    const price = 10000 + random() % 100000;
    const candidates = Array.from({ length: random() % 80 }, () => ({ id: `v${random() % 40}`, price: 1000 + random() % 100000 }));
    const remaining = new Map(candidates.map(c => [c.id, c])), expected = [];
    for (const multiplier of [3, 5, 7, 9]) {
      const ranked = [...remaining.values()].sort((a, b) => Math.abs(a.price * 6 - price * multiplier) - Math.abs(b.price * 6 - price * multiplier)
        || a.price - b.price || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
      if (!ranked.length) break;
      expected.push(ranked[0]); remaining.delete(ranked[0].id);
    }
    assert.deepEqual(selectTiers(price, candidates), expected);
  }
});
test('ACTIVE matching variants are included regardless of stock or sale availability', () => {
  const source = resolveSources(product(), config).sources[0];
  const p = targetProduct('target', [variant('a'), variant('b'), variant('c', '1000', 'King'), { ...variant('d'), sellableOnlineQuantity: 0 }, { ...variant('e'), availableForSale: false }]);
  const result = candidatesFor(source, [p, p], config);
  assert.deepEqual(result.eligible.map(c => c.id), ['a', 'b', 'd', 'e']);
  assert.equal(result.rejected.length, 1);
});
test('publication is irrelevant; incorrect types, inactive products and unknown sizes excluded', () => {
  const source = resolveSources(product(), config).sources[0];
  const target = targetProduct('target');
  assert.equal(candidatesFor(source, [{ ...target, productType: 'Anything' }], config).rejected[0].reason, 'target_type_mismatch');
  assert.equal(candidatesFor(source, [target], config).eligible.length, 1);
  assert.equal(candidatesFor(source, [{ ...target, onlineStoreUrl: null }], config).eligible.length, 1);
  for (const status of ['DRAFT', 'ARCHIVED']) {
    const result = candidatesFor(source, [{ ...target, status }], config);
    assert.equal(result.eligible.length, 0);
    assert.equal(result.rejected[0].reason, 'inactive_target');
  }
  const untracked = { ...variant('untracked'), availableForSale: false, sellableOnlineQuantity: null };
  assert.equal(candidatesFor(source, [targetProduct('untracked-product', [untracked])], config).eligible.length, 1);
  target.variants.nodes[0].selectedOptions = []; target.size = null;
  assert.equal(candidatesFor(source, [target], config).eligible.length, 0);
});
test('Box A/B component products are excluded regardless of case or spacing', () => {
  const source = resolveSources(product(), config).sources[0];
  for (const title of ['Adjustable Base (Box A) - Queen', 'Adjustable Base (box b) - Queen', 'Adjustable Base Box  A - Queen']) {
    const result = candidatesFor(source, [{ ...targetProduct('target'), title }], config);
    assert.equal(result.eligible.length, 0);
    assert.equal(result.rejected[0].reason, 'component_box_a_b');
  }
  assert.equal(candidatesFor(source, [{ ...targetProduct('target'), title: 'Adjustable Base Boxer - Queen' }], config).eligible.length, 1);
});
test('half-size adjustable bases are excluded regardless of case', () => {
  const source = resolveSources(product(), config).sources[0];
  for (const title of ['Somnerside Half Cal.King Adjustable Bed Base - Queen', 'HALF Base - Queen']) {
    const result = candidatesFor(source, [{ ...targetProduct('target'), title }], config);
    assert.equal(result.eligible.length, 0);
    assert.equal(result.rejected[0].reason, 'half_size_product');
  }
  assert.equal(candidatesFor(source, [{ ...targetProduct('target'), title: 'Halfmoon Base - Queen' }], config).eligible.length, 1);
});
test('Twin XL-titled bases mismatching a Twin-tagged size are excluded only for Twin sources', () => {
  const twinSource = resolveSources(product('p1', [variant('v1', '1000', 'Twin')]), config).sources[0];
  for (const title of ['Boyd Sleep Twin Extra Long EZ Flex 330ML Adjustable Base', 'Twin XL Adjustable Base']) {
    const twinTarget = { ...targetProduct('target', [variant('t1', '1000', 'Twin')]), title };
    const result = candidatesFor(twinSource, [twinTarget], config);
    assert.equal(result.eligible.length, 0);
    assert.equal(result.rejected[0].reason, 'title_size_conflicts_with_metafield');
  }
  const kingSource = resolveSources(product('p2', [variant('v2', '1000', 'King')]), config).sources[0];
  const kingTarget = { ...targetProduct('target', [variant('t2', '1000', 'King')]), title: 'Twin XL Adjustable Base' };
  assert.equal(candidatesFor(kingSource, [kingTarget], config).eligible.length, 1);
});
test('unchanged reference order skipped; empty policy explicit', () => {
  const source = { existing: { type: 'list.variant_reference', jsonValue: ['a', 'b'] } };
  assert.equal(writeDecision(source, ['a', 'b'], 'preserve'), 'unchanged');
  assert.equal(writeDecision(source, ['b', 'a'], 'preserve'), 'changed');
  assert.equal(writeDecision(source, [], 'preserve'), 'preserved_empty');
  assert.equal(writeDecision(source, [], 'clear'), 'changed');
  assert.equal(sameReferences({ value: 'invalid' }, []), false);
});
test('blank and omitted collection handles disable mappings; invalid nonempty handles fail', () => {
  const env = { SHOPIFY_STORE_DOMAIN: 'test.myshopify.com', SHOPIFY_CLIENT_ID: 'id', SHOPIFY_CLIENT_SECRET: 'secret', SHOPIFY_API_VERSION: '2026-07' };
  assert.deepEqual(readConfig(env).collections, {});
  env.SPLIT_KING_MATTRESS_COLLECTION = '   ';
  env.QUEEN_MATTRESS_COLLECTION = 'queen-mattresses';
  assert.deepEqual(readConfig(env).collections, { 'mattress:Queen': 'queen-mattresses' });
  for (const group of GROUPS) for (const size of SIZES) env[envKey(size, group)] = 'collection';
  assert.equal(Object.keys(readConfig(env).collections).length, 16);
  assert.equal(readConfig(env).collections['mattress:Split California King'], 'collection');
  assert.equal(readConfig(env).collections['adjustable_base:Split California King'], 'collection');
  env.QUEEN_MATTRESS_COLLECTION = 'https://bad'; assert.throws(() => readConfig(env), /Invalid collection/);
});
test('write requires both independent guards', () => {
  assert.throws(() => writeGuard('write', [], {}), /Write aborted/);
  assert.throws(() => writeGuard('write', ['--confirm-write'], {}), /Write aborted/);
  assert.throws(() => writeGuard('write', [], { ALLOW_SHOPIFY_WRITE: 'true' }), /Write aborted/);
  assert.doesNotThrow(() => writeGuard('write', ['--confirm-write'], { ALLOW_SHOPIFY_WRITE: 'true' }));
  assert.doesNotThrow(() => writeGuard('audit', [], {}));
});
test('invalid money never reaches selection', () => {
  for (const price of ['0', '-10', 'NaN', '1e4', '1.00001']) assert.equal(money(price), null);
  assert.equal(money('0.01'), 100);
});
