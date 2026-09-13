import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { bootServer, client } from './helpers.js';

let srv;
before(async () => { srv = await bootServer({ ALLOW_OPEN_SIGNUP: 'false' }); });
after(async () => { await srv.close(); });

test('after the first account, sign-up is invite-only by default', async () => {
  const a = client(srv.base);
  const first = await a.post('/api/auth/register', { name: 'A', email: 'a@x.com', password: 'first-long-password', companyName: 'Acme' });
  assert.equal(first.status, 201);
  const b = client(srv.base);
  const second = await b.post('/api/auth/register', { name: 'B', email: 'b@x.com', password: 'second-long-password', companyName: 'Other' });
  assert.equal(second.status, 403);
  assert.match(second.data.error, /invite/i);

  const inv = await a.post('/api/company/invites', { role: 'owner' });
  assert.equal(inv.status, 201);
  const token = inv.data.url.split('/invite/')[1];
  const joined = await b.post(`/api/auth/invites/${token}/accept`, { name: 'B', email: 'b@x.com', password: 'second-long-password' });
  assert.equal(joined.status, 200);
  assert.equal(joined.data.companies[0].role, 'owner');

  const revoke = await a.post('/api/company/invites', { role: 'member' });
  const revokeToken = revoke.data.url.split('/invite/')[1];
  await a.del(`/api/company/invites/${revoke.data.invite.id}`);
  const c = client(srv.base);
  const revoked = await c.post(`/api/auth/invites/${revokeToken}/accept`, { name: 'C', email: 'c@x.com', password: 'third-long-password' });
  assert.equal(revoked.status, 410);
});
