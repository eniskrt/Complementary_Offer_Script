export const SIZES = ['Twin', 'Twin XL', 'Full', 'Queen', 'King', 'California King', 'Split King', 'Split California King'];
export const GROUPS = ['mattress', 'adjustable_base'];
export const keyFor = group => `${group}_recommendations`;
export const envKey = (size, group) => `${size.replaceAll(' ', '_')}_${group}_COLLECTION`.toUpperCase();

export function writeGuard(mode, args, env) {
  if (mode === 'write' && (env.ALLOW_SHOPIFY_WRITE !== 'true' || !args.includes('--confirm-write'))) {
    throw new Error('Write aborted: ALLOW_SHOPIFY_WRITE=true and --confirm-write are both required.');
  }
}

export function readConfig(env = process.env) {
  const required = ['SHOPIFY_STORE_DOMAIN', 'SHOPIFY_CLIENT_ID', 'SHOPIFY_CLIENT_SECRET', 'SHOPIFY_API_VERSION'];
  const missing = required.filter(key => !env[key]?.trim());
  if (missing.length) throw new Error(`Missing configuration: ${missing.join(', ')}`);
  const domain = env.SHOPIFY_STORE_DOMAIN.trim().toLowerCase();
  if (!/^[a-z0-9][a-z0-9-]*\.myshopify\.com$/.test(domain)) throw new Error('SHOPIFY_STORE_DOMAIN must be a *.myshopify.com hostname without https:// or a path.');
  const version = env.SHOPIFY_API_VERSION.trim();
  if (!/^20\d{2}-(01|04|07|10)$/.test(version)) throw new Error('Use a stable SHOPIFY_API_VERSION, e.g. 2026-07.');
  const empty = env.EMPTY_RECOMMENDATIONS || 'preserve';
  if (!['preserve', 'clear'].includes(empty)) throw new Error('EMPTY_RECOMMENDATIONS must be preserve or clear.');
  const collections = {};
  for (const group of GROUPS) for (const size of SIZES) {
    const key = envKey(size, group), handle = env[key]?.trim();
    if (!handle) continue;
    if (!/^[a-z0-9][a-z0-9-]*$/.test(handle)) throw new Error(`Invalid collection handle: ${key}`);
    collections[`${group}:${size}`] = handle;
  }
  return { domain, version, clientId: env.SHOPIFY_CLIENT_ID.trim(), clientSecret: env.SHOPIFY_CLIENT_SECRET.trim(), collections, empty,
    sizeOptions: (env.SIZE_OPTION_NAMES || 'Size,Mattress Size,Bed Size').split(',').map(x => x.trim().toLowerCase()).filter(Boolean) };
}
