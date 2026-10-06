import * as Q from './queries.js';
import { typeGroup } from './engine.js';

export class Repository {
  constructor(client, onProgress = () => {}) { this.client = client; this.onProgress = onProgress; }
  async completeVariants(products, target = false) {
    // Only overflow pages require follow-ups; batch these as aliases, never one request per product.
    let pending = products.filter(p => p.variants.pageInfo.hasNextPage);
    while (pending.length) {
      this.onProgress({ stage: 'loading_variant_pages', pendingProducts: pending.length });
      const batchSize = target ? 2 : 5;
      for (let offset = 0; offset < pending.length; offset += batchSize) {
        const batch = pending.slice(offset, offset + batchSize), variables = {}, declarations = [], fields = [];
        batch.forEach((p, i) => {
          declarations.push(`$id${i}: ID!`, `$after${i}: String!`);
          variables[`id${i}`] = p.id; variables[`after${i}`] = p.variants.pageInfo.endCursor;
          fields.push(`p${i}: product(id: $id${i}) { variants(first: ${target ? 100 : 50}, after: $after${i}) { nodes { ${target ? Q.TARGET_VARIANT : Q.VARIANT} } pageInfo { hasNextPage endCursor } } }`);
        });
        const data = await this.client.graphql(`query ${target ? 'MoreTargetVariants' : 'MoreVariants'}(${declarations.join(', ')}) { ${fields.join('\n')} }`, variables);
        batch.forEach((p, i) => {
          const next = data[`p${i}`]?.variants;
          if (!next) throw new Error(`Product disappeared while paginating: ${p.id}`);
          if (next.pageInfo.hasNextPage && next.pageInfo.endCursor === p.variants.pageInfo.endCursor) throw new Error('Variant pagination did not advance.');
          p.variants.nodes.push(...next.nodes); p.variants.pageInfo = next.pageInfo;
        });
      }
      pending = pending.filter(p => p.variants.pageInfo.hasNextPage);
    }
    for (const product of products) product.variants.nodes = [...new Map(product.variants.nodes.map(v => [v.id, v])).values()];
    return products;
  }
  async *sources() {
    let after = null, sourceProducts = 0;
    do {
      this.onProgress({ stage: 'loading_source_page', sourceProducts });
      const { products } = await this.client.graphql(Q.SOURCES, { after });
      sourceProducts += products.nodes.length;
      this.onProgress({ stage: 'resolving_source_variants', sourceProducts });
      // Count every ACTIVE product, but load expensive details only for supported source types.
      const supported = products.nodes.filter(p => typeGroup(p.productType));
      const detailed = new Map((await this.refresh(supported.map(p => p.id))).map(p => [p.id, p]));
      yield products.nodes.map(p => detailed.get(p.id) || (typeGroup(p.productType)
        ? { ...p, status: 'DELETED_DURING_SCAN' } : p));
      if (!products.pageInfo.hasNextPage) break;
      if (!products.pageInfo.endCursor || products.pageInfo.endCursor === after) throw new Error('Source pagination did not advance.');
      after = products.pageInfo.endCursor;
    } while (true);
  }
  async validateCollections(mapping) {
    const result = new Map(), missing = [];
    for (const handle of new Set(Object.values(mapping))) {
      this.onProgress({ stage: 'validating_collection', collection: handle });
      const data = await this.client.graphql(Q.COLLECTION, { handle });
      if (!data.collectionByIdentifier) missing.push(handle);
      else result.set(handle, data.collectionByIdentifier.id);
    }
    if (missing.length) throw new Error(`Collections not found: ${missing.join(', ')}`);
    return result;
  }
  async pool(id) {
    const result = new Map(); let after = null;
    do {
      this.onProgress({ stage: 'loading_collection_page', collection: id, collectionProducts: result.size });
      const { collection } = await this.client.graphql(Q.POOL, { id, after });
      if (!collection) throw new Error(`Collection disappeared: ${id}`);
      const products = collection.products;
      for (const p of await this.completeVariants(products.nodes, true)) result.set(p.id, p);
      this.onProgress({ stage: 'processing_collection', collection: id, collectionProducts: result.size });
      if (!products.pageInfo.hasNextPage) break;
      if (!products.pageInfo.endCursor || products.pageInfo.endCursor === after) throw new Error('Collection pagination did not advance.');
      after = products.pageInfo.endCursor;
    } while (true);
    return [...result.values()];
  }
  async refresh(ids) {
    const products = [];
    for (let offset = 0; offset < ids.length; offset += 10) {
      const { nodes } = await this.client.graphql(Q.REFRESH, { ids: ids.slice(offset, offset + 10) });
      products.push(...await this.completeVariants(nodes.filter(Boolean)));
    }
    return products;
  }
}
