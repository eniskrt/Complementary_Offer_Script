import { readConfig } from '../src/config.js';
import { ShopifyClient } from '../src/client.js';
import { Repository } from '../src/repository.js';
import { sizeOf, money, withinRange, recommend } from '../src/engine.js';
process.loadEnvFile('.env');
const config = readConfig();
const repository = new Repository(new ShopifyClient({ ...config, writeEnabled: false }));
for (const [size, price] of [['Twin', 329], ['Full', 409], ['Queen', 439], ['King', 589], ['California King', 589]]) {
  const handle = config.collections[`adjustable_base:${size}`];
  const ids = await repository.validateCollections({ size: handle });
  const products = await repository.pool(ids.get(handle));
  const inRange = [];
  for (const p of products) for (const v of p.variants.nodes) {
    if (p.status !== 'ACTIVE' || !money(v.price) || !withinRange(money(String(price)), money(v.price), 80)) continue;
    inRange.push({ product: p.title, variant: v.title, price: v.price, options: v.selectedOptions, metafield: p.size,
      resolved: sizeOf(p, v, config.sizeOptions) });
  }
  const result = recommend({ productId: 'gid://shopify/Product/7515715109111', group: 'adjustable_base', size, price: money(String(price)) }, products, config);
  console.log(JSON.stringify({ size, handle, productCount: products.length, selected: result.selected.map(c => ({ label: c.label, price: c.price / 10000 })),
    tolerance: result.tolerance, matchingInRange: inRange.filter(v => v.resolved === size).length }, null, 2));
}
