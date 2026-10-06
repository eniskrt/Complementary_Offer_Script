import { writeFileSync } from 'node:fs';
import path from 'node:path';

export function createProgress(directory, { intervalMs = 15000, print = console.log } = {}) {
  const state = { startedAt: new Date().toISOString(), stage: 'starting', requestsCompleted: 0 };
  const persist = () => writeFileSync(path.join(directory, 'run-progress.json'), JSON.stringify({ ...state, heartbeatAt: new Date().toISOString() }, null, 2));
  const update = event => {
    const { kind, ...details } = event;
    if (kind === 'api') state.api = details;
    else Object.assign(state, details);
    if (kind === 'api' && event.status === 'received') state.requestsCompleted++;
    state.lastActivityAt = new Date().toISOString();
    persist();
  };
  const timer = setInterval(() => {
    persist();
    const api = state.api || {};
    print(`[Progress] ${state.stage}; source products: ${state.sourceProducts ?? 0}; collection products: ${state.collectionProducts ?? 0}; API: ${api.operation || '-'} ${api.status || ''}${api.waitMs ? ` (${Math.ceil(api.waitMs / 1000)}s wait)` : ''}; completed requests: ${state.requestsCompleted}`);
  }, intervalMs);
  timer.unref();
  persist();
  return { update, close(status) { clearInterval(timer); state.stage = status; persist(); } };
}
