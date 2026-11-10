// Offline regression for the stop bug reported against whacked/pi-aatwad v0.1.2; no real Pi/model/worker is started.
// Usage: node --experimental-strip-types bug-reports/reproduce-team-stop.mjs /path/to/pi-aatwad
import assert from 'node:assert/strict';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

const repo = process.argv[2];
if (!repo) throw new Error('Pass the pi-aatwad checkout path as the sole argument');
const { harness, newRun, sql } = await import(pathToFileURL(resolve(repo, 'test/controller/helpers.ts')).href);
const hs = await harness(); // Temp state, fake executor; never contacts the user's controller.
try {
  const { run_id, root } = await newRun(hs);
  const body = { action: 'cancel', reason: 'offline stop reproduction', children_policy: 'cascade' };
  const first = await hs.call('POST', `/agents/${root}/lifecycle`, { token: hs.op, body, key: 'first-stop' });
  const replay = await hs.call('POST', `/agents/${root}/lifecycle`, { token: hs.op, body, key: 'first-stop' });
  const second = await hs.call('POST', `/agents/${root}/lifecycle`, { token: hs.op, body, key: 'second-stop' });
  const listing = await hs.call('GET', '/runs', { token: hs.op });
  const run = listing.body.runs.find(r => r.run_id === run_id);
  const agents = sql(hs, 'SELECT status, desired_state, observed_state FROM agents WHERE run_id = ?', run_id);
  const summary = { first: { http: first.status, status: first.body.status },
    same_key_replay: { http: replay.status, status: replay.body.status },
    second_with_new_key: { http: second.status, status: second.body.status, error: second.body.error },
    run_listing_status: run.status, agents };
  console.log(JSON.stringify(summary, null, 2));
  // These assertions verify the fixed behavior; the report retains the original evidence.
  assert.equal(first.status, 200);
  assert.equal(replay.status, 200);
  assert.equal(second.status, 200);
  assert.deepEqual(second.body.affected_agent_ids, []);
  assert.equal(run.status, 'CANCELLED');
  assert.ok(agents.every(a => a.status === 'CANCELLED' && a.observed_state === 'STOPPED'));
  console.log('Verified: repeated stop succeeds and run status is CANCELLED; fake executor only.');
} finally {
  await hs.cleanup();
}
