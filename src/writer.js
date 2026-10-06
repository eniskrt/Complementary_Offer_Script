import { sameReferences } from './engine.js';
import { SET, VERIFY } from './queries.js';

export function writeDecision(source, ids, emptyPolicy) {
  if (source.existing && source.existing.type !== 'list.variant_reference') throw new Error(`Incompatible metafield value type on ${source.ownerId}`);
  if (sameReferences(source.existing, ids)) return 'unchanged';
  if (!ids.length && emptyPolicy === 'preserve') return 'preserved_empty';
  return 'changed';
}
export async function writeBatch(client, changes, output, summary) {
  for (let start = 0; start < changes.length; start += 25) {
    const batch = changes.slice(start, start + 25);
    for (const { source, ids } of batch) await output.snapshot({ timestamp: new Date().toISOString(), ownerId: source.ownerId,
      namespace: 'ornate', key: source.key, previous: source.existing, next: ids });
    try {
      const metafields = batch.map(({ source, ids }) => ({ ownerId: source.ownerId, namespace: 'ornate', key: source.key,
        type: 'list.variant_reference', value: JSON.stringify(ids), compareDigest: source.existing?.compareDigest ?? null }));
      const { metafieldsSet } = await client.graphql(SET, { metafields });
      if (metafieldsSet.userErrors.length) throw new Error(metafieldsSet.userErrors.map(e => `${e.code}: ${e.message}`).join('; '));
      summary.written += batch.length;
      const { nodes } = await client.graphql(VERIFY, { ids: batch.map(c => c.source.ownerId) });
      for (const { source, ids } of batch) {
        const current = nodes.find(n => n?.id === source.ownerId)?.[source.group];
        if (!sameReferences(current, ids)) {
          summary.errors++; output.writeResult(source, 'written_verification_failed', ids, 'Value changed or could not be verified after write.');
          await output.log({ event: 'write_verification_error', ownerId: source.ownerId, errors: ['Value differs after write'] });
        } else output.writeResult(source, 'written_verified', ids);
      }
    } catch (error) {
      summary.errors += batch.length;
      for (const { source, ids } of batch) {
        output.writeResult(source, 'failed_or_unverified', ids, error.message);
        await output.log({ event: 'write_error', ownerId: source.ownerId, errors: [error.message] });
      }
      // Stop further mutations after uncertain outcomes or a rejected atomic batch.
      throw error;
    }
  }
}
