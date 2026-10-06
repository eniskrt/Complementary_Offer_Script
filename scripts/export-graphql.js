import * as queries from '../src/queries.js';
import { Repository } from '../src/repository.js';
import { mkdir, writeFile } from 'node:fs/promises';

// Export fully interpolated operations for offline Shopify schema validation.
const operations = Object.values(queries).filter(q => /^(query|mutation) /.test(q));
const repo = new Repository({ async graphql(query) {
  operations.push(query);
  return { p0: { variants: { nodes: [], pageInfo: { hasNextPage: false } } } };
} });
await repo.completeVariants([{ id: 'gid://shopify/Product/1', variants: { nodes: [], pageInfo: { hasNextPage: true, endCursor: 'sample' } } }]);
await repo.completeVariants([{ id: 'gid://shopify/Product/1', variants: { nodes: [], pageInfo: { hasNextPage: true, endCursor: 'sample' } } }], true);
await mkdir('output/validation', { recursive: true });
await writeFile('output/validation/operations.graphql', operations.join('\n\n'));
console.log('Exported GraphQL operations to output/validation/operations.graphql');
