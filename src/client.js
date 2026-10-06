import { setTimeout as sleep } from 'node:timers/promises';

export class ShopifyClient {
  constructor(config, { fetchFn = fetch, sleepFn = sleep, onProgress = () => {} } = {}) {
    this.config = config; this.fetch = fetchFn; this.sleep = sleepFn;
    this.onProgress = onProgress;
    this.token = null; this.expires = 0;
    this.costs = new Map(); this.budget = null;
  }
  costWait(key) {
    if (!this.budget || !this.costs.has(key)) return 0;
    const { currentlyAvailable, maximumAvailable, restoreRate, at } = this.budget;
    const available = Math.min(maximumAvailable, currentlyAvailable + (Date.now() - at) * restoreRate / 1000);
    return Math.max(0, (this.costs.get(key) - available) / restoreRate * 1000);
  }
  async authenticate() {
    if (this.token && Date.now() < this.expires) return;
    const response = await this.request(`https://${this.config.domain}/admin/oauth/access_token`, {
      method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ grant_type: 'client_credentials', client_id: this.config.clientId, client_secret: this.config.clientSecret }).toString()
    });
    const body = await response.json();
    if (!body.access_token || !(body.expires_in > 60)) throw new Error('Authentication returned an invalid token response.');
    this.token = body.access_token; this.expires = Date.now() + (body.expires_in - 60) * 1000;
  }
  async request(url, options) {
    for (let attempt = 0; attempt < 6; attempt++) {
      let response;
      try { response = await this.fetch(url, { ...options, signal: AbortSignal.timeout(30000) }); }
      catch {
        // Mutations with an unknown outcome must not be blindly replayed.
        if (options.mutation) throw new Error('Mutation network failure: outcome unknown; inspect Shopify and snapshot before rerunning.');
        if (attempt === 5) throw new Error('Shopify network request failed after retries.');
        this.onProgress({ kind: 'api', operation: options.operation || 'Authentication', status: 'network_retry', attempt: attempt + 1, waitMs: Math.min(30000, 500 * 2 ** attempt) });
        await this.sleep(Math.min(30000, 500 * 2 ** attempt)); continue;
      }
      if (response.ok || response.status === 401) return response;
      if (response.status === 429 || response.status >= 500) {
        if (options.mutation && response.status >= 500) throw new Error(`Mutation HTTP ${response.status}: outcome unknown; inspect snapshot before rerunning.`);
        if (attempt < 5) {
          const retryHeader = response.headers.get('retry-after');
          const seconds = Number(retryHeader);
          const retryMs = retryHeader && !Number.isFinite(seconds) ? Date.parse(retryHeader) - Date.now() : seconds * 1000;
          const waitMs = Math.max(500 * 2 ** attempt + Math.random() * 250, Number.isFinite(retryMs) ? retryMs : 0);
          this.onProgress({ kind: 'api', operation: options.operation || 'Authentication', status: 'http_retry', httpStatus: response.status, attempt: attempt + 1, waitMs });
          await this.sleep(waitMs); continue;
        }
      }
      throw new Error(`Shopify HTTP ${response.status}. Check app installation, scopes and configuration.`);
    }
  }
  async graphql(query, variables = {}) {
    const operation = query.match(/^\s*(?:query|mutation)\s+(\w+)/)?.[1] || 'GraphQL';
    // Array sizes affect node/mutation cost; cursors and IDs do not create separate entries.
    const costKey = query + JSON.stringify(Object.entries(variables).filter(([, v]) => Array.isArray(v)).map(([k, v]) => [k, v.length]));
    const mutation = /^\s*mutation\b/.test(query);
    if (mutation && !this.config.writeEnabled) throw new Error('Mutation blocked: client is read-only.');
    for (let attempt = 0; attempt < 6; attempt++) {
      await this.authenticate();
      const waitMs = this.costWait(costKey);
      if (waitMs) this.onProgress({ kind: 'api', operation, status: 'cost_wait', waitMs });
      await this.sleep(waitMs);
      this.onProgress({ kind: 'api', operation, status: 'requesting' });
      const response = await this.request(`https://${this.config.domain}/admin/api/${this.config.version}/graphql.json`, {
        method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Shopify-Access-Token': this.token },
        body: JSON.stringify({ query, variables }), mutation, operation
      });
      if (response.status === 401) { this.token = null; if (attempt < 5) continue; throw new Error('Shopify authentication failed.'); }
      const actualVersion = response.headers.get('x-shopify-api-version');
      if (actualVersion && actualVersion !== this.config.version) throw new Error(`Shopify served ${actualVersion} instead of configured ${this.config.version}; update API version.`);
      const body = await response.json();
      this.onProgress({ kind: 'api', operation, status: 'received' });
      const cost = body.extensions?.cost, throttle = cost?.throttleStatus;
      if (Number.isFinite(cost?.requestedQueryCost)) this.costs.set(costKey, cost.requestedQueryCost);
      if (throttle?.restoreRate > 0) this.budget = { ...throttle, at: Date.now() };
      if (body.errors?.length) {
        if (body.errors.every(e => e.extensions?.code === 'THROTTLED') && attempt < 5) {
          const waitMs = Math.max(1000 * 2 ** attempt, this.costWait(costKey));
          this.onProgress({ kind: 'api', operation, status: 'throttled', attempt: attempt + 1, waitMs });
          await this.sleep(waitMs); continue;
        }
        throw new Error(`GraphQL: ${body.errors.map(e => e.message).join('; ')}`);
      }
      if (!body.data) throw new Error('Shopify returned no GraphQL data.');
      return body.data;
    }
    throw new Error('Shopify retry limit reached.');
  }
}
