# Ornate Shopify Recommendations

Standalone Node.js 22.14+ script. Configured bed and bedroom-set product types receive mattress recommendations; configured mattress types receive adjustable-base recommendations. Results are stored as exact Shopify variant references.

## Setup

Open Windows PowerShell in the project directory:

```powershell
Set-Location 'D:\OrnateHome\Code Works\complementary-offer-script'
npm.cmd ci
```

Use `npm.cmd` on Windows to avoid PowerShell restrictions on `npm.ps1`. On other platforms, use `npm`.

## Environment configuration

Fill in the existing `.env` file. If it does not exist, copy `.env.example` to `.env`. Do not overwrite an existing configuration.

| Setting | Description |
| --- | --- |
| SHOPIFY_STORE_DOMAIN | Store hostname, such as shop.myshopify.com, without protocol or path |
| SHOPIFY_CLIENT_ID | Shopify app Client ID |
| SHOPIFY_CLIENT_SECRET | Shopify app Client Secret |
| SHOPIFY_API_VERSION | API version; the example uses 2026-07 |
| *_MATTRESS_COLLECTION | Mattress collection handle for the corresponding size |
| *_ADJUSTABLE_BASE_COLLECTION | Adjustable-base collection handle for the corresponding size |
| SIZE_OPTION_NAMES | Comma-separated option names; defaults to Size,Mattress Size,Bed Size |
| ALLOW_SHOPIFY_WRITE | Must be true to enable writes |
| EMPTY_RECOMMENDATIONS | preserve keeps existing values when no candidates qualify; clear empties the list |

Collection settings take handles, not URLs: use `queen-mattresses` for `/collections/queen-mattresses`.

**Blank collection settings are skipped.** Any size/group, including Split King, can remain blank. Its existing recommendations remain untouched, even with `EMPTY_RECOMMENDATIONS=clear`. Omitted or whitespace-only settings are also treated as disabled. Nonempty invalid or nonexistent handles stop the run. If every collection setting is blank, the run completes without Shopify requests.

The app must be installed on the store with `read_products` and `write_products` scopes. Client credentials authentication requires the app and store to belong to the same Shopify organization. Tokens are obtained server-side and refreshed before expiry. Keep credentials in the local, Git-ignored `.env` file. See [Shopify client credentials documentation](https://shopify.dev/docs/apps/build/authentication-authorization/client-credentials-grant).

## 1. Generate an audit report

```powershell
npm.cmd run recommendations:audit
```

Generates an Excel report, detailed JSONL logs and a run summary. Audit does not write recommendation values or create metafield definitions. Missing definitions are reported only.

## 2. Write to Shopify

After reviewing the audit, enable writes in `.env`:

```env
ALLOW_SHOPIFY_WRITE=true
```

To empty existing recommendations when no eligible candidates remain, also set:

```env
EMPTY_RECOMMENDATIONS=clear
```

Then run:

```powershell
npm.cmd run recommendations:write -- --confirm-write
```

Both `ALLOW_SHOPIFY_WRITE=true` and `--confirm-write` are required. `clear` writes `[]` only when a processed source has no eligible candidates; it does not delete the metafield definition. `preserve` leaves its existing recommendations untouched. When candidates exist, both settings calculate the new list and write it only if changed. Disabled collection mappings are skipped under either setting.

## Recommendation rules

- All ACTIVE source products are scanned. Recommendations apply only to the configured source product-type allowlists. Types are matched after trimming and lowercasing.
- Target pools come from the configured size collections and must also pass an exact product-type allowlist after trim/lowercase. Bed/bedroom-set sources accept Mattress, Innerspring Mattress, Latex Foam Mattress, Latex Hybrid Mattress, Hybrid Mattress, Memory Foam Mattress, Local Mattresses and Futon Mattress targets. Mattress sources accept Adjustable Bed Base, Adjustable Base and Adjustable Bed targets. Wrong or missing target types are logged as `target_type_mismatch`; they do not occupy a recommendation slot. The engine continues with other eligible variants and widens price bands as needed. Source type allowlists are unchanged.
- Targets are also excluded by title pattern, regardless of price or type match: products titled with a standalone "Box A"/"Box B" (`component_box_a_b`, split adjustable-base components) or "Half" (`half_size_product`, half-width bases such as a Half Cal. King) are never recommended. A Twin-tagged base whose title reads "Twin XL"/"Twin Extra Long" is excluded only for Twin-size sources (`title_size_conflicts_with_metafield`), since the title conflicts with its own declared size.
- Target products must be ACTIVE. Stock, sale availability and Online Store publication do not filter candidates. Out-of-stock, untracked and preorder variants are included when type, size and price match. Type filtering does not detect incorrectly declared size or incomplete products whose type is otherwise valid (such as Box A/Box B).
- Size comes from a named variant option first, or product `ornate.size` when no size option exists. An explicit but unsupported variant size is skipped rather than replaced with the product size. Titles are never used to guess size.
- Product size metafields support both plain text and Shopify lists such as `["California King"]`, including JSON-encoded list values. A list must resolve to one unique supported size; multi-size lists without a variant size option remain ambiguous and are skipped.
- Supported sizes: Twin, Twin XL, Full, Queen, King, California King, Split King and Split California King. Exact target variant size must match the source in addition to collection membership.
- Size aliases apply to both variant options and product `ornate.size`, for sources and targets: Eastern King → King; Full/Double or Full /Double → Full; Cal King or Cal. King → California King; Split Cal King or Split Cal. King → Split California King. Matching ignores case, surrounding whitespace and spaces around the slash. Split California King remains distinct from California King and Split King.
- Configure the new size with `SPLIT_CALIFORNIA_KING_MATTRESS_COLLECTION` and `SPLIT_CALIFORNIA_KING_ADJUSTABLE_BASE_COLLECTION`. Blank values disable the corresponding mapping.
- Products with a size option or different variant prices receive variant-level recommendations calculated from each variant's own price. Variants without a size option inherit product `ornate.size`. Products without a size option whose variant prices agree receive product-level recommendations using that shared price.
- Prices use `variant.price` in the shop's base currency. Compare-at prices, Markets pricing and checkout discounts are not used.
- Start with an inclusive ±50% price range (50–150% of source price). For mattress-to-adjustable-base recommendations only, eligible bases from the same vendor are selected first; vendor comparison ignores case and surrounding whitespace. The same-vendor price range widens as needed with no upper cap. If fewer than four same-vendor variants exist, remaining slots are filled from other vendors, starting again at ±50% and widening as needed. A blank source vendor keeps the original all-vendor behavior. Bed-to-mattress recommendations remain price-first across all vendors. Empty bands are skipped efficiently. Stop when four are selected or every otherwise eligible candidate has been considered. Keep earlier selections and fill only remaining slots; never relax size, collection membership or ACTIVE status. The four sequential target prices remain 50%, 83.3%, 116.7% and 150% of source price — four points evenly spaced across the ±50% band. If the collection has fewer than four eligible distinct variants at any price, return the available count. Logs include `priceTolerancePercent` and `priceExpansionStages`; each expansion stage also records its vendor scope. The summary counts `sourcesWithExpandedPriceRange`.
- Equal distances prefer the lower price; equal prices use variant ID order for deterministic results. Exact variants cannot repeat. Different eligible variants from the same product are allowed. The source product cannot recommend itself. Fewer than four candidates produce fewer recommendations.
- The four selected recommendations are written and displayed lowest price to highest, regardless of which tier or price-expansion stage found each one.

## Metafields and write behavior

Both fields use `list.variant_reference`:

- `ornate.mattress_recommendations`
- `ornate.adjustable_base_recommendations`

Write mode checks for missing PRODUCT and PRODUCTVARIANT definitions before creating them. Incompatible existing definition types stop the run. Product titles, tags and types are not modified. Products and variants are never deleted.

Each write group refreshes sources and the relevant target collections. Source prices are read again after target pagination. Sources whose size/type changes or that can no longer be resolved are skipped. Unchanged recommendations are not rewritten. Writes use groups of at most 25 fields, with previous values flushed to a snapshot before the mutation. `compareDigest` prevents overwriting a metafield changed by another process. Written values are read back for verification. A failed or uncertain batch stops further writes.

Prices and product status may change after the last read; recommendations reflect the data at read time. Existing recommendations on skipped sources remain untouched.

Theme rendering is separate: read the selected variant's recommendation field first, then fall back to the product field when absent or empty. The script does not generate an additional product-level fallback for multi-size products. Render each referenced variant's own URL and price.

## Output files

Folder: `output/MM-DD-YYYY/YYYY-MM-DD_HH-mm-ss/`. Folder names use local system time; JSON event timestamps use UTC.

| File | Contents |
| --- | --- |
| recommendations-audit.xlsx | Source SKU, product, size, price and four recommendation name/price pairs; write mode includes recalculated results |
| logs/recommendation-details.jsonl | Source IDs, size, price, collection, candidates, rejection/skip reasons and errors |
| run-summary.json | Processed/skipped sources, recommendation counts, changed/unchanged fields, writes and errors |
| run-progress.json | Live stage, source/collection counts, API request status and heartbeat timestamp |
| write-results.xlsx | Write mode only: write and verification results |
| pre-write-snapshot.jsonl | Write mode only: previous metafield values and intended new references |

`candidateCount` sums eligible candidates across sources; it is not the count of unique catalog variants. `skippedUnconfiguredCollection` counts sources skipped because their collection mapping is disabled; logs use `collection_not_configured`. `written` counts Shopify-acknowledged writes; verification failures are reported separately as errors. A snapshot alone does not prove that a write succeeded.

## Tests and operation

```powershell
npm.cmd test
npm.cmd run check
```

Tests require no Shopify credentials and make no live writes. They cover Excel export/readback, recommendation rules and the write workflow using mocked Shopify responses. Live verification requires a configured `.env` and an audit run.

The script scans ACTIVE product headers in pages of 250 and fetches variant/metafield details only for supported source types. Target collections use pages of 50 with lightweight variant data; stock, publication and recommendation metafields are not fetched for targets. Overflow variant connections are fully paginated. Audit caches collection pools; write mode still refreshes relevant pools for each group. Selection scans candidates once per slot instead of sorting the entire list four times. Rate-limit waits use the upcoming query's observed cost and Shopify's current budget, rather than the previous query's cost. See [Shopify API limits](https://shopify.dev/docs/api/usage/limits). Failed runs return a nonzero exit code.

While a run is active, a progress message appears every 15 seconds, including the current stage and API wait/retry state. `run-progress.json` updates throughout the run. The `Scanned` line is printed only after a source page finishes processing, so it can stay unchanged while a large target collection loads. Use the progress stage and completed request count to distinguish collection loading from API waits. Changes to script files take effect on the next run, not in an already-running Node.js process.

`.recommendations.lock` prevents overlapping runs from the same directory. After a crash, confirm that the recorded PID is no longer running before removing a stale lock. For weekly scheduling, set this project as the working directory and avoid concurrent writers on other machines.

## GitHub Actions schedule

`.github/workflows/scheduled-recommendations.yml` runs the write command directly, without a preceding audit, every Monday and Thursday at 04:00 Europe/Istanbul (01:00 UTC). It can also be started manually from the repository's **Actions** tab. GitHub scheduled workflows run from the default branch, so the workflow file must be committed and pushed there.

Add these repository **Actions secrets** under **Settings → Secrets and variables → Actions**:

- `SHOPIFY_STORE_DOMAIN`
- `SHOPIFY_CLIENT_ID`
- `SHOPIFY_CLIENT_SECRET`

Add `SHOPIFY_API_VERSION`, `EMPTY_RECOMMENDATIONS`, `SIZE_OPTION_NAMES`, and each enabled collection setting from `.env.example` as repository **Actions variables**. Blank or missing collection variables remain disabled and their existing metafields are preserved. The workflow sets `ALLOW_SHOPIFY_WRITE=true` itself, prevents overlapping scheduled writes, validates JavaScript before writing, and retains the summary and Excel reports as a GitHub artifact for 14 days. Detailed JSONL logs are intentionally excluded because they can be very large.

ExcelJS's UUID dependency is pinned to patched version `11.1.1`: [security advisory](https://github.com/advisories/GHSA-w5hq-g745-h8pq). Run `node scripts/export-graphql.js` to export resolved operations to `output/validation/operations.graphql` for Shopify schema validation.
