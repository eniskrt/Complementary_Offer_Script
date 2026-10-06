export const METAFIELDS = `
  mattress: metafield(namespace: "ornate", key: "mattress_recommendations") { id type value jsonValue compareDigest }
  adjustable_base: metafield(namespace: "ornate", key: "adjustable_base_recommendations") { id type value jsonValue compareDigest }
`;
export const TARGET_VARIANT = `id title price selectedOptions { name value }`;
export const VARIANT = `${TARGET_VARIANT} sku ${METAFIELDS}`;
export const PRODUCT = `id title vendor productType status
  size: metafield(namespace: "ornate", key: "size") { value jsonValue }
  ${METAFIELDS}
  variants(first: 20) { nodes { ${VARIANT} } pageInfo { hasNextPage endCursor } }`;
export const SOURCES = `query Sources($after: String) { products(first: 250, after: $after, query: "status:active", sortKey: ID) { nodes { id title vendor productType status } pageInfo { hasNextPage endCursor } } }`;
export const COLLECTION = `query Collection($handle: String!) { collectionByIdentifier(identifier: {handle: $handle}) { id handle } }`;
export const TARGET_PRODUCT = `id title vendor productType status size: metafield(namespace: "ornate", key: "size") { value jsonValue }
  variants(first: 5) { nodes { ${TARGET_VARIANT} } pageInfo { hasNextPage endCursor } }`;
export const POOL = `query Pool($id: ID!, $after: String) { collection(id: $id) { products(first: 50, after: $after) { nodes { ${TARGET_PRODUCT} } pageInfo { hasNextPage endCursor } } } }`;
export const REFRESH = `query Refresh($ids: [ID!]!) { nodes(ids: $ids) { ... on Product { ${PRODUCT} } } }`;
export const DEFINITIONS = `query Definitions($owner: MetafieldOwnerType!, $key: String!) { metafieldDefinitions(first: 10, ownerType: $owner, namespace: "ornate", key: $key) { nodes { id type { name } } } }`;
export const CREATE_DEFINITION = `mutation CreateDefinition($definition: MetafieldDefinitionInput!) { metafieldDefinitionCreate(definition: $definition) { createdDefinition { id } userErrors { field message code } } }`;
export const SET = `mutation SetRecommendations($metafields: [MetafieldsSetInput!]!) { metafieldsSet(metafields: $metafields) { metafields { owner { ... on Product { id } ... on ProductVariant { id } } key value compareDigest } userErrors { field message code } } }`;
export const VERIFY = `query Verify($ids: [ID!]!) { nodes(ids: $ids) { ... on Product { id ${METAFIELDS} } ... on ProductVariant { id ${METAFIELDS} } } }`;
