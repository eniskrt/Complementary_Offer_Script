import { resolveSources, recommend, displayMoney } from './engine.js';
import { ensureDefinitions } from './definitions.js';
import { writeDecision, writeBatch } from './writer.js';

export async function run({ mode, config, client, repository, output }) {
  const summary = { mode, startedAt: new Date().toISOString(), status: 'running',
    sourceProductsScanned: 0, eligibleSourceProducts: 0, sourceRecords: 0, missingSize: 0, invalidSourceType: 0,
    candidateCount: 0, sourcesWith4Recommendations: 0, sourcesWithLessThan4Recommendations: 0, sourcesWithExpandedPriceRange: 0,
    unchangedMetafields: 0, changedMetafields: 0, preservedEmpty: 0, skippedSources: 0, skippedUnconfiguredCollection: 0, written: 0, errors: 0 };
  const seen = new Set(), pools = new Map();
  const configuredSources = async sources => {
    const enabled = [];
    for (const source of sources) {
      if (config.collections[`${source.group}:${source.size}`]) { enabled.push(source); continue; }
      summary.skippedSources++; summary.skippedUnconfiguredCollection++;
      await output.log({ event: 'source_skipped', ownerId: source.ownerId, sourceProductId: source.productId,
        sourceVariantId: source.variantId, sourceSize: source.size, group: source.group, reason: 'collection_not_configured' });
      if (mode === 'write') output.writeResult(source, 'skipped_collection_not_configured');
    }
    return enabled;
  };
  const diagnostics = async result => {
    if (result.reason === 'invalid_source_type') summary.invalidSourceType++;
    for (const rejected of result.rejected || []) {
      if (rejected.reason === 'missing_size') summary.missingSize++;
      summary.skippedSources++;
      await output.log({ event: 'source_skipped', ...rejected });
    }
  };
  try {
    if (!Object.keys(config.collections).length) {
      summary.status = 'completed'; summary.definitions = [];
      summary.note = 'No collections configured; no Shopify operations performed.';
      return summary;
    }
    const collections = await repository.validateCollections(config.collections);
    summary.definitions = await ensureDefinitions(client, mode === 'write');
    for await (const page of repository.sources()) {
      const initial = [];
      for (const product of page) {
        if (seen.has(product.id)) continue; seen.add(product.id);
        summary.sourceProductsScanned++;
        const resolved = resolveSources(product, config);
        await diagnostics(resolved);
        const enabled = await configuredSources(resolved.sources);
        if (enabled.length) summary.eligibleSourceProducts++;
        initial.push(...enabled);
      }
      for (let offset = 0; offset < initial.length; offset += 25) {
        let sources = initial.slice(offset, offset + 25);
        // Target pools are cached for the whole run, same as audit mode; refetching per batch made
        // write mode refetch the same collections hundreds of times on large catalogs. Sources are
        // still refreshed per batch below for current price/size/status at write time.
        // A final source refresh below catches price/size changes during collection pagination.
        if (mode === 'write') {
          const ids = [...new Set(sources.map(s => s.productId))];
          const fresh = (await repository.refresh(ids)).flatMap(p => resolveSources(p, config).sources);
          const owners = new Set(sources.map(s => s.ownerId));
          sources = fresh.filter(s => owners.has(s.ownerId));
          for (const old of initial.slice(offset, offset + 25).filter(s => !sources.some(n => n.ownerId === s.ownerId))) {
            summary.skippedSources++; output.writeResult(old, 'skipped_source_changed');
            await output.log({ event: 'source_skipped', ownerId: old.ownerId, reason: 'source_deleted_inactive_or_no_longer_resolvable' });
          }
        }
        sources = await configuredSources(sources);
        for (const source of sources) {
          const handle = config.collections[`${source.group}:${source.size}`];
          if (!pools.has(handle)) pools.set(handle, await repository.pool(collections.get(handle)));
        }
        if (mode === 'write' && sources.length) {
          const fresh = (await repository.refresh([...new Set(sources.map(s => s.productId))])).flatMap(p => resolveSources(p, config).sources);
          sources = sources.flatMap(old => {
            const next = fresh.find(s => s.ownerId === old.ownerId);
            if (!next || next.size !== old.size || next.group !== old.group) {
              summary.skippedSources++; output.writeResult(old, 'skipped_source_changed_during_refresh'); return [];
            }
            return [next];
          });
        }
        const changes = [];
        for (const source of sources) {
          const handle = config.collections[`${source.group}:${source.size}`];
          const { eligible, rejected, selected, tolerance, stages } = recommend(source, pools.get(handle), config);
          const ids = selected.map(c => c.id);
          if (tolerance > 50) summary.sourcesWithExpandedPriceRange++;
          summary.sourceRecords++; summary.candidateCount += eligible.length;
          summary[selected.length === 4 ? 'sourcesWith4Recommendations' : 'sourcesWithLessThan4Recommendations']++;
          const decision = writeDecision(source, ids, config.empty);
          if (decision === 'changed') summary.changedMetafields++;
          if (decision === 'unchanged') summary.unchangedMetafields++;
          if (decision === 'preserved_empty') summary.preservedEmpty++;
          output.audit(source, selected);
          await output.log({ event: 'recommendation', sourceProductId: source.productId, sourceVariantId: source.variantId,
            ownerId: source.ownerId, sourceType: source.type, sourceSize: source.size, sourcePrice: displayMoney(source.price),
            collectionUsed: handle, priceTolerancePercent: tolerance, priceExpansionStages: stages,
            eligibleCandidates: eligible.map(c => ({ ...c, price: displayMoney(c.price) })),
            rejectedReasons: rejected, selectedVariantIds: ids, selectedPrices: selected.map(c => displayMoney(c.price)), decision, errors: [] });
          if (mode === 'write') {
            if (decision === 'changed') changes.push({ source, ids });
            else output.writeResult(source, decision, ids);
          }
        }
        if (mode === 'write' && changes.length) await writeBatch(client, changes, output, summary);
      }
      console.log(`Scanned ${summary.sourceProductsScanned} products; processed ${summary.sourceRecords} sources; written ${summary.written}.`);
    }
    summary.status = summary.errors ? 'completed_with_errors' : 'completed';
  } catch (error) {
    summary.status = 'failed'; summary.errors++; summary.fatalError = error.message;
    await output.log({ event: 'fatal_error', errors: [error.message] });
  } finally {
    summary.finishedAt = new Date().toISOString();
    await output.finish(summary);
  }
  return summary;
}
