import { GROUPS, keyFor } from './config.js';
import { DEFINITIONS, CREATE_DEFINITION } from './queries.js';

export async function ensureDefinitions(client, write) {
  const report = [];
  for (const owner of ['PRODUCT', 'PRODUCTVARIANT']) for (const group of GROUPS) {
    const key = keyFor(group);
    const lookup = async () => (await client.graphql(DEFINITIONS, { owner, key })).metafieldDefinitions.nodes;
    let definitions = await lookup();
    if (!definitions.length && write) {
      const { metafieldDefinitionCreate: result } = await client.graphql(CREATE_DEFINITION, { definition: {
        name: group === 'mattress' ? 'Mattress recommendations' : 'Adjustable base recommendations',
        namespace: 'ornate', key, type: 'list.variant_reference', ownerType: owner,
        access: { storefront: 'PUBLIC_READ' }
      } });
      if (result.userErrors.length) {
        // A concurrent process may have created the same definition. Re-read before deciding.
        definitions = await lookup();
        if (!definitions.length) throw new Error(`Definition ${owner}.${key}: ${result.userErrors.map(e => e.message).join('; ')}`);
      } else definitions = await lookup();
      if (!definitions.length) throw new Error(`Definition creation could not be verified: ${owner}.${key}`);
    }
    if (definitions.some(d => d.type.name !== 'list.variant_reference')) throw new Error(`Incompatible definition: ${owner}.ornate.${key}; expected list.variant_reference.`);
    report.push({ owner, key, status: definitions.length ? 'ready' : 'missing_read_only_audit' });
  }
  return report;
}
