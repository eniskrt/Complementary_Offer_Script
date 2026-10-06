import { existsSync } from 'node:fs';
import { readConfig } from '../src/config.js';
import { ShopifyClient } from '../src/client.js';
import { sizeOf } from '../src/engine.js';

if (existsSync('.env')) process.loadEnvFile('.env');
const config = readConfig();
const client = new ShopifyClient({ ...config, writeEnabled: false });
const query = `query InspectTarget($id: ID!, $after: String) {
  productVariant(id: $id) { id title price selectedOptions { name value }
    product { id title status productType
      size: metafield(namespace: "ornate", key: "size") { value jsonValue }
      collections(first: 100, after: $after) { nodes { id handle title } pageInfo { hasNextPage endCursor } }
    }
  }
}`;
const id = process.argv[2];
if (!/^gid:\/\/shopify\/ProductVariant\/\d+$/.test(id || '')) throw new Error('Pass a Shopify variant GID.');
let after = null, variant, memberships = [];
do {
  const data = await client.graphql(query, { id, after });
  if (!data.productVariant) throw new Error('Variant not found.');
  variant = data.productVariant;
  const connection = variant.product.collections;
  memberships.push(...connection.nodes);
  if (!connection.pageInfo.hasNextPage) break;
  if (!connection.pageInfo.endCursor || connection.pageInfo.endCursor === after) throw new Error('Collection cursor did not advance.');
  after = connection.pageInfo.endCursor;
} while (true);
const { collections, ...product } = variant.product;
console.log(JSON.stringify({ variant: { id: variant.id, title: variant.title, price: variant.price, selectedOptions: variant.selectedOptions },
  product, resolvedSize: sizeOf(product, variant, config.sizeOptions), memberships,
  configuredCollections: config.collections }, null, 2));
