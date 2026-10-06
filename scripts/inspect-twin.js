import { readConfig } from '../src/config.js';
import { ShopifyClient } from '../src/client.js';
import { Repository } from '../src/repository.js';
import { sizeOf, recommend, money } from '../src/engine.js';
process.loadEnvFile('.env');
const config = readConfig();
const repository = new Repository(new ShopifyClient({ ...config, writeEnabled: false }));
const handle = config.collections['adjustable_base:Twin'];
const ids = await repository.validateCollections({ twin: handle });
const products = await repository.pool(ids.get(handle));
const source = { productId: 'gid://shopify/Product/7515715109111', group: 'adjustable_base', size: 'Twin', price: money('329') };
const result = recommend(source, products, config);
console.log(JSON.stringify({ handle, productCount: products.length, selectedCount: result.selected.length,
  variants: products.flatMap(p => p.variants.nodes.map(v => ({ product: p.title, status: p.status,
    variant: v.title, id: v.id, price: v.price, size: sizeOf(p, v, config.sizeOptions), rawSize: p.size?.jsonValue,
    result: result.rejected.find(r => r.variantId === v.id)?.reason || 'eligible' }))) }, null, 2));
