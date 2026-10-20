import { afterEach, describe, it, mock } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import worker, { LabelQuota, accountConfiguration, nutrientKeys } from '../src/worker.js';

// All credentials and users here are synthetic. Every provider/API call is mocked.
const project = 'https://abcdefghijklmnopqrst.supabase.co';
const publishableKey = `sb_publishable_${'p'.repeat(32)}`;
const secretKey = `sb_secret_${'s'.repeat(32)}`;
const privateToken = '12'.repeat(32);
const userID = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const sessionID = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const image = readFileSync(new URL('./fixtures/blank.jpg', import.meta.url)).toString('base64');
const upload = { mimeType: 'image/jpeg', imageBase64: image };
const profile = (changes = {}) => ({ id: userID, aud: 'authenticated', role: 'authenticated', is_anonymous: false,
  email: 'synthetic@example.invalid', email_confirmed_at: '2026-01-01T00:00:00Z', ...changes });
function token(changes = {}) {
  const claims = { iss: `${project}/auth/v1`, sub: userID, session_id: sessionID, aud: 'authenticated',
    role: 'authenticated', exp: Math.floor(Date.now() / 1000) + 3600, is_anonymous: false, ...changes };
  return `${Buffer.from('{"alg":"RS256","typ":"JWT"}').toString('base64url')}.${Buffer.from(JSON.stringify(claims)).toString('base64url')}.offline_signature`;
}
function quotaFixture() {
  const values = new Map(), names = [];
  let alarmTime = null;
  const tx = { get: async key => structuredClone(values.get(key)), put: async (key, value) => values.set(key, structuredClone(value)),
    delete: async keys => { for (const key of Array.isArray(keys) ? keys : [keys]) values.delete(key); } };
  let queue = Promise.resolve();
  const quota = new LabelQuota({ storage: { setAlarm: async time => { alarmTime = time; }, deleteAlarm: async () => { alarmTime = null; }, transaction: callback => {
    const operation = queue.then(() => callback(tx)); queue = operation.catch(() => {}); return operation;
  } } });
  const stub = { fetch: (url, init) => quota.fetch(new Request(url, init)) };
  return { values, stub, binding: { idFromName: name => { names.push(name); return name; }, get: () => stub }, names,
    get alarmTime() { return alarmTime; }, runAlarm: () => quota.alarm() };
}
function environment(quota = quotaFixture(), changes = {}) {
  return { OPENAI_API_KEY: 'offline-openai-placeholder', OPENAI_MODEL: 'gpt-4.1-mini',
    PRIVATE_ACCESS_TOKEN_SHA256: createHash('sha256').update(privateToken).digest('hex'), LABEL_QUOTA: quota.binding,
    SUPABASE_URL: project, SUPABASE_PUBLISHABLE_KEY: publishableKey, ...changes };
}
function analysis(jwt = token(), body = upload) {
  return new Request('https://nudge.example/v1/nutrition-label/analyse', { method: 'POST',
    headers: { authorization: `Bearer ${jwt}`, 'content-type': 'application/json' }, body: typeof body === 'string' ? body : JSON.stringify(body) });
}
function account(path, method = 'GET', jwt = token(), body) {
  return new Request(`https://nudge.example${path}`, { method, headers: { authorization: `Bearer ${jwt}` },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
}
function extractionResponse() {
  const extraction = { type: 'product', meal: null, productName: null, brand: null, photoConsistency: 'sameProduct', servingSuggestion: null, categoryTag: null, retailer: null, labelKind: 'nutrition', ingredients: null, basis: 'per100g', servingSize: null, needsClearerPhoto: false, message: '',
    nutrients: Object.fromEntries(nutrientKeys.map(key => [key, key === 'energyKcal' ? { value: 100, unit: 'kcal' } : key === 'protein' ? { value: 2, unit: 'g' } : null])) };
  return Response.json({ status: 'completed', output: [{ type: 'message', content: [{ type: 'output_text', text: JSON.stringify(extraction) }] }] });
}
const subject = id => createHash('sha256').update(`${project}\n${id}`).digest('hex');
const quotaAction = async (quota, path, lease, principal) => (await quota.stub.fetch(`https://quota/${path}`, {
  method: 'POST', body: JSON.stringify({ lease, ...(principal ? { subject: principal } : {}) })
})).json();
function captureBinding(steps=[]){
  let purged=false;const purgeToken='cccccccc-cccc-4ccc-8ccc-cccccccccccc';
  const stub={fetch:async(url,init)=>{
    if(url.endsWith('/purge')){steps.push('capture-purge');purged=true;return Response.json({ok:true,purgeToken});}
    if(url.endsWith('/reactivate')){
      steps.push('capture-reactivate');assert.equal(init.headers['x-nudge-internal'],'true');assert.deepEqual(JSON.parse(init.body),{purgeToken});
      purged=false;return Response.json({ok:true});
    }
    steps.push('capture-upload');return Response.json(purged?{code:'capture_account_deleted'}:{job:{id:userID,status:'queued'}},{status:purged?410:202});
  }};
  return {binding:{idFromName:name=>{assert.equal(name,'private-captures-v1:'+subject(userID));return name;},get:()=>stub},get purged(){return purged;}};
}
afterEach(() => mock.restoreAll());

describe('managed account configuration and identity', () => {
  it('exposes only valid public configuration and keeps deletion opt-in', async () => {
    const disabled = [{}, { SUPABASE_URL: project }, { SUPABASE_PUBLISHABLE_KEY: publishableKey },
      ...['http://abcdefghijklmnopqrst.supabase.co', `${project}/path`, `${project}?secret=x`, 'https://user@abcdefghijklmnopqrst.supabase.co',
        'https://abcdefghijklmnopqrst.supabase.co.attacker.invalid', 'https://example.invalid', `${project}:443`].map(SUPABASE_URL => ({ SUPABASE_URL, SUPABASE_PUBLISHABLE_KEY: publishableKey })),
      { SUPABASE_URL: project, SUPABASE_PUBLISHABLE_KEY: secretKey }];
    const upstream = mock.method(globalThis, 'fetch', () => { throw new Error('must not call'); });
    for (const env of disabled) {
      assert.equal(accountConfiguration(env), null);
      const response = await worker.fetch(account('/v1/account/config'), env);
      assert.equal(response.status, 200); assert.deepEqual(await response.json(), { enabled: false });
    }
    for (const key of [undefined, 'legacy-or-invalid-secret', secretKey]) {
      const response = await worker.fetch(account('/v1/account/config'), environment(undefined, { SUPABASE_SECRET_KEY: key }));
      assert.deepEqual(await response.json(), { enabled: true, provider: 'supabase', url: project,
        publishableKey, deletionAvailable: key === secretKey, analysisLimits: {globalHourly:10, globalDaily:30, accountHourly:3, accountDaily:10} });
      assert.equal(response.headers.get('cache-control'), 'no-store');
    }
    assert.equal(upstream.mock.callCount(), 0);
  });
  it('keeps private access operational with managed auth absent or malformed', async () => {
    const upstream = mock.method(globalThis, 'fetch', async url => {
      assert.equal(url, 'https://api.openai.com/v1/responses'); return extractionResponse();
    });
    for (const SUPABASE_URL of [undefined, 'https://attacker.invalid']) {
      assert.equal((await worker.fetch(analysis(privateToken), environment(undefined, { SUPABASE_URL }))).status, 200);
    }
    assert.equal(upstream.mock.callCount(), 2);
    const denied = await worker.fetch(analysis(), environment(undefined, { SUPABASE_URL: undefined }));
    assert.equal(denied.status, 503); assert.equal((await denied.json()).code, 'account_not_configured');
    assert.equal(upstream.mock.callCount(), 2);
  });
  it('verifies every managed request remotely and derives stable private quota keys', async () => {
    const jwt = token(), quota = quotaFixture(), env = environment(quota, { PRIVATE_ACCESS_TOKEN_SHA256: undefined });
    let verifications = 0, paid = 0;
    mock.method(globalThis, 'fetch', async (url, init) => {
      if (url === `${project}/auth/v1/user`) {
        verifications++; assert.equal(init.method, 'GET'); assert.equal(init.redirect, 'manual');
        assert.equal(init.headers.apikey, publishableKey); assert.equal(init.headers.authorization, `Bearer ${jwt}`);
        return Response.json(profile());
      }
      assert.equal(url, 'https://api.openai.com/v1/responses'); paid++; return extractionResponse();
    });
    for (let i = 0; i < 2; i++) assert.equal((await worker.fetch(analysis(jwt), env)).status, 200);
    assert.equal(verifications, 2); assert.equal(paid, 2);
    assert.equal(quota.values.get('quota').daily, 2); assert.equal(quota.values.get(`user:${subject(userID)}`).daily, 2);
    assert.deepEqual(quota.names, ['private-owner', 'private-owner']);
    const stored = JSON.stringify([...quota.values]);
    for (const sensitive of [userID, sessionID, jwt, profile().email, image, publishableKey]) assert.equal(stored.includes(sensitive), false);
  });
  it('rejects expired/wrong-project/missing-session claims before upload or paid admission', async () => {
    const upstream = mock.method(globalThis, 'fetch', () => { throw new Error('must not call'); });
    for (const changes of [{ exp: 0 }, { exp: 3.5 }, { iss: 'https://attacker.invalid/auth/v1' }, { aud: 'anon' }, { role: 'service_role' },
      { session_id: undefined }, { session_id: '00000000-0000-0000-0000-000000000000' }, { sub: 'attacker' }, { is_anonymous: true }]) {
      const quota = quotaFixture(), response = await worker.fetch(analysis(token(changes), '{'), environment(quota));
      assert.equal(response.status, 401); assert.equal((await response.json()).code, 'account_authentication_required');
      assert.equal(quota.values.size, 0);
    }
    assert.equal(upstream.mock.callCount(), 0);
  });
  it('never authorizes from a self-decoded JWT when the provider rejects it', async () => {
    const quota = quotaFixture();
    const upstream = mock.method(globalThis, 'fetch', async url => {
      assert.equal(url, `${project}/auth/v1/user`); return new Response('private-signature-rejection', { status: 403 });
    });
    const response = await worker.fetch(analysis(), environment(quota)), body = await response.json();
    assert.equal(response.status, 401); assert.equal(body.code, 'account_authentication_required');
    assert.doesNotMatch(JSON.stringify(body), /private-signature/); assert.equal(quota.values.size, 0); assert.equal(upstream.mock.callCount(), 1);
  });
  it('requires the verified matching confirmed nonanonymous user, not client metadata', async () => {
    const upstream = mock.method(globalThis, 'fetch');
    for (const user of [null, {}, profile({ id: sessionID }), profile({ is_anonymous: true }), profile({ is_anonymous: undefined }),
      profile({ role: 'service_role' }), profile({ aud: 'anon' }), profile({ email_confirmed_at: null, user_metadata: { email_verified: true } }),
      profile({ email_confirmed_at: 'not-a-date' })]) {
      upstream.mock.mockImplementation(async url => { assert.equal(url, `${project}/auth/v1/user`); return Response.json(user); });
      const quota = quotaFixture(), response = await worker.fetch(analysis(), environment(quota));
      assert.equal(response.status, 401); assert.equal(quota.values.size, 0);
    }
  });
  it('fails closed on provider redirects, malformed/oversized bodies and outages without leaking errors', async () => {
    const upstream = mock.method(globalThis, 'fetch');
    const responses = [() => new Response('private-auth-failure', { status: 500 }), () => new Response(null, { status: 307, headers: { location: 'https://attacker.invalid' } }),
      () => new Response('{'), () => new Response('x'.repeat(32_769), { headers: { 'content-length': '1' } })];
    for (const reply of responses) {
      upstream.mock.mockImplementation(async url => { assert.equal(url, `${project}/auth/v1/user`); return reply(); });
      const quota = quotaFixture(), response = await worker.fetch(analysis(), environment(quota));
      const body = await response.json();
      assert.equal(response.status, 503); assert.equal(body.code, 'account_auth_unavailable');
      assert.doesNotMatch(JSON.stringify(body), /private-auth|attacker/); assert.equal(quota.values.size, 0);
    }
  });
  it('bounds stalled provider bodies and releases no quota because authentication comes first', { timeout: 1000 }, async () => {
    const original = globalThis.setTimeout; mock.method(globalThis, 'setTimeout', callback => original(callback, 1));
    let cancelled = false;
    mock.method(globalThis, 'fetch', async () => new Response(new ReadableStream({ cancel() { cancelled = true; return new Promise(() => {}); } })));
    const quota = quotaFixture(), response = await worker.fetch(analysis(), environment(quota));
    assert.equal(response.status, 503); assert.equal((await response.json()).code, 'account_auth_unavailable');
    assert.equal(cancelled, true); assert.equal(quota.values.size, 0);
  });
  it('checks revocation again even for a previously accepted unchanged access token', async () => {
    const jwt = token(), quota = quotaFixture(); let revoked = false, paid = 0, checked = 0;
    mock.method(globalThis, 'fetch', async url => {
      if (url === `${project}/auth/v1/user`) { checked++; return revoked ? new Response(null, { status: 403 }) : Response.json(profile()); }
      assert.equal(url, 'https://api.openai.com/v1/responses'); paid++; return extractionResponse();
    });
    const env = environment(quota);
    assert.equal((await worker.fetch(analysis(jwt), env)).status, 200); revoked = true;
    assert.equal((await worker.fetch(analysis(jwt), env)).status, 401);
    assert.equal(checked, 2); assert.equal(paid, 1); assert.equal(quota.values.get('quota').daily, 1);
  });
});

describe('account-only logout and deletion', () => {
  it('accepts a zero-byte account body stream as well as an absent body', async () => {
    mock.method(globalThis, 'fetch', async url => url.endsWith('/user') ? Response.json(profile()) : new Response(null, { status: 204 }));
    const request = new Request('https://nudge.example/v1/account/logout', { method: 'POST', headers: { authorization: `Bearer ${token()}` }, body: '' });
    assert.ok(request.body);
    const response = await worker.fetch(request, environment());
    assert.equal(response.status, 200); assert.deepEqual(await response.json(), { ok: true });
  });
  it('signs out only the current session and rejects its revoked token on subsequent analysis', async () => {
    const jwt = token(), quota = quotaFixture(); let revoked = false;
    const upstream = mock.method(globalThis, 'fetch', async (url, init) => {
      assert.equal(init.headers.authorization, `Bearer ${jwt}`); assert.equal(init.headers.apikey, publishableKey);
      if (url.endsWith('/user')) return revoked ? new Response(null, { status: 403 }) : Response.json(profile());
      assert.equal(url, `${project}/auth/v1/logout?scope=local`); assert.equal(init.method, 'POST');
      revoked = true; return new Response(null, { status: 204 });
    });
    const env = environment(quota), response = await worker.fetch(account('/v1/account/logout', 'POST', jwt), env);
    assert.equal(response.status, 200); assert.deepEqual(await response.json(), { ok: true });
    assert.equal((await worker.fetch(analysis(jwt), env)).status, 401);
    assert.equal(upstream.mock.callCount(), 3); assert.equal(quota.values.size, 0);
  });
  it('deletes only the remotely verified current user with the server apikey and no bearer header', async () => {
    const jwt = token(), quota = quotaFixture(); let deleted = false;
    const upstream = mock.method(globalThis, 'fetch', async (url, init) => {
      if (url.endsWith('/user')) return deleted ? new Response(null, { status: 403 }) : Response.json(profile());
      assert.equal(url, `${project}/auth/v1/admin/users/${userID}`); assert.equal(init.method, 'DELETE');
      assert.equal(init.headers.apikey, secretKey); assert.equal(init.headers.authorization, undefined);
      assert.deepEqual(JSON.parse(init.body), { should_soft_delete: false });
      deleted = true; return Response.json(profile());
    });
    const env = environment(quota, { SUPABASE_SECRET_KEY: secretKey });
    const response = await worker.fetch(account('/v1/account', 'DELETE', jwt, {}), env);
    assert.equal(response.status, 200); assert.deepEqual(await response.json(), { ok: true });
    assert.equal((await worker.fetch(analysis(jwt), env)).status, 401);
    assert.equal(upstream.mock.callCount(), 3); assert.equal(quota.values.size, 0);
  });
  it('purges only this verified owner pending submissions before deleting Auth', async () => {
    const steps=[];
    mock.method(globalThis,'fetch',async url=>{if(url.endsWith('/user'))return Response.json(profile());steps.push('auth-delete');return Response.json(profile());});
    const env=environment(undefined,{SUPABASE_SECRET_KEY:secretKey,FOOD_CATALOGUE_INDEX:{idFromName:name=>name,get:()=>({fetch:async(url,init)=>{
      steps.push('purge');assert.match(url,/contributions\/purge-owner$/);assert.equal(init.headers['x-nudge-owner'],createHash('sha256').update(project+'\n'+userID).digest('hex'));assert.equal(init.body,'{}');return Response.json({purged:true});
    }})}});
    assert.equal((await worker.fetch(account('/v1/account','DELETE'),env)).status,200);assert.deepEqual(steps,['purge','auth-delete']);
    steps.length=0;env.FOOD_CATALOGUE_INDEX.get=()=>({fetch:async()=>new Response(null,{status:503})});
    assert.equal((await worker.fetch(account('/v1/account','DELETE'),env)).status,503);assert.deepEqual(steps,[],'Auth remains usable to retry a failed private-data purge');
  });
  it('reopens a rejected deletion only after freshly verifying the same active account, without restoring purged inputs',async()=>{
    const steps=[],captures=captureBinding(steps);
    mock.method(globalThis,'fetch',async url=>{
      if(url.endsWith('/user')){steps.push('verify');return Response.json(profile());}
      steps.push('auth-delete');return new Response('private rejection',{status:403});
    });
    const env=environment(undefined,{SUPABASE_SECRET_KEY:secretKey,PRIVATE_CAPTURE_JOBS:captures.binding});
    const response=await worker.fetch(account('/v1/account','DELETE'),env);
    assert.equal(response.status,502);assert.equal((await response.json()).code,'account_deletion_failed');
    assert.deepEqual(steps,['verify','capture-purge','auth-delete','verify','capture-reactivate']);assert.equal(captures.purged,false);
    const uploaded=await worker.fetch(analysis(token(),{...upload,captureId:userID}),env);
    assert.equal(uploaded.status,202);assert.equal(steps.filter(s=>s==='capture-reactivate').length,1);
  });
  it('keeps successful deletion fenced and capture entry points never reactivate from authentication alone',async()=>{
    const steps=[],captures=captureBinding(steps);
    mock.method(globalThis,'fetch',async url=>{if(url.endsWith('/user')){steps.push('verify');return Response.json(profile());}steps.push('auth-delete');return Response.json(profile());});
    const env=environment(undefined,{SUPABASE_SECRET_KEY:secretKey,PRIVATE_CAPTURE_JOBS:captures.binding});
    assert.equal((await worker.fetch(account('/v1/account','DELETE'),env)).status,200);
    assert.deepEqual(steps,['verify','capture-purge','auth-delete']);assert.equal(captures.purged,true);
    assert.equal((await worker.fetch(analysis(token(),{...upload,captureId:userID}),env)).status,410);
    assert.equal((await worker.fetch(account('/v1/nutrition-label/jobs/'+userID,'GET'),env)).status,410);
    assert.equal(steps.includes('capture-reactivate'),false);
  });
  it('never reopens on an uncertain delete outcome, failed fresh verification or changed identity',async()=>{
    for(const mode of ['network','server','deleted','verification-unavailable','different-user']){
      const steps=[],captures=captureBinding(steps);let verified=0;
      const provider=mock.method(globalThis,'fetch',async url=>{
        if(url.endsWith('/user')){
          steps.push('verify');verified++;
          if(verified===1)return Response.json(profile());
          if(mode==='deleted')return new Response(null,{status:403});
          if(mode==='verification-unavailable')return new Response(null,{status:503});
          return Response.json(profile({id:sessionID}));
        }
        steps.push('auth-delete');if(mode==='network')throw new TypeError('Uncertain network outcome');
        return new Response(null,{status:mode==='server'?503:403});
      });
      const response=await worker.fetch(account('/v1/account','DELETE'),environment(undefined,{SUPABASE_SECRET_KEY:secretKey,PRIVATE_CAPTURE_JOBS:captures.binding}));
      assert.equal(response.status,502,mode);assert.equal(captures.purged,true,mode);assert.equal(steps.includes('capture-reactivate'),false,mode);
      assert.equal(verified,['network','server'].includes(mode)?1:2,mode);
      provider.mock.restore();
    }
  });
  it('rejects client target identities/diary content and preserves deletion disabled until configured', async () => {
    const upstream = mock.method(globalThis, 'fetch', async url => { assert.equal(url, `${project}/auth/v1/user`); return Response.json(profile()); });
    for (const body of [{ userId: sessionID }, { diary: [] }, { value: 'x'.repeat(1025) }]) {
      const response = await worker.fetch(account('/v1/account', 'DELETE', token(), body), environment(undefined, { SUPABASE_SECRET_KEY: secretKey }));
      assert.equal(response.status, 400); assert.equal((await response.json()).code, 'account_request_invalid');
    }
    const query = await worker.fetch(account(`/v1/account?userId=${sessionID}`, 'DELETE'), environment(undefined, { SUPABASE_SECRET_KEY: secretKey }));
    assert.equal(query.status, 400);
    const disabled = await worker.fetch(account('/v1/account', 'DELETE'), environment());
    assert.equal(disabled.status, 503); assert.equal((await disabled.json()).code, 'account_deletion_unavailable');
    assert.equal(upstream.mock.callCount(), 5);
  });
  it('never allows a private token to delete an account or relays provider failure content', async () => {
    const upstream = mock.method(globalThis, 'fetch', async url => url.endsWith('/user') ? Response.json(profile()) : new Response('private-admin-error', { status: 403 }));
    const env = environment(undefined, { SUPABASE_SECRET_KEY: secretKey });
    assert.equal((await worker.fetch(account('/v1/account', 'DELETE', privateToken), env)).status, 401);
    assert.equal(upstream.mock.callCount(), 0);
    for (const [path, method, code] of [['/v1/account', 'DELETE', 'account_deletion_failed'], ['/v1/account/logout', 'POST', 'account_logout_failed']]) {
      const response = await worker.fetch(account(path, method), env), body = await response.json();
      assert.equal(response.status, 502); assert.equal(body.code, code); assert.doesNotMatch(JSON.stringify(body), /private-admin|sb_secret/);
    }
  });
});

describe('transactional shared and per-account quotas', () => {
  it('expires the bounded daily registry by alarm without altering the shared counter or lease', async () => {
    const quota = quotaFixture(); let now = Date.UTC(2026, 9, 1, 23, 59); mock.method(Date, 'now', () => now);
    await quotaAction(quota, 'acquire', 'first', subject(userID)); await quotaAction(quota, 'release', 'first');
    await quotaAction(quota, 'acquire', 'in-flight', subject(sessionID));
    const global = structuredClone(quota.values.get('quota'));
    assert.equal(quota.alarmTime, Date.UTC(2026, 9, 2));
    assert.equal(quota.values.get('quota-users').subjects.length, 2);
    await quota.runAlarm(); // Early delivery cannot remove current-day counters.
    assert.equal(quota.values.has(`user:${subject(userID)}`), true);
    now = Date.UTC(2026, 9, 2);
    await quota.runAlarm();
    assert.equal(quota.values.has(`user:${subject(userID)}`), false);
    assert.equal(quota.values.has(`user:${subject(sessionID)}`), false);
    assert.equal(quota.values.has('quota-users'), false); assert.equal(quota.alarmTime, null);
    assert.deepEqual(quota.values.get('quota'), global);
  });
  it('cleans old rows on the next request and makes delayed alarms safe for the new day', async () => {
    const quota = quotaFixture(); let now = Date.UTC(2026, 9, 1, 10); mock.method(Date, 'now', () => now);
    await quotaAction(quota, 'acquire', 'old', subject(userID)); await quotaAction(quota, 'release', 'old');
    now += 86_400_000;
    assert.equal((await quotaAction(quota, 'acquire', 'new', subject(sessionID))).allowed, true);
    assert.equal(quota.values.has(`user:${subject(userID)}`), false);
    const global = structuredClone(quota.values.get('quota'));
    await quota.runAlarm();
    assert.equal(quota.values.has(`user:${subject(sessionID)}`), true);
    assert.deepEqual(quota.values.get('quota'), global);
    assert.equal(quota.alarmTime, Date.UTC(2026, 9, 3));
  });
  it('forgets only a successfully deleted account and preserves the aggregate count and active lease', async () => {
    const quota = quotaFixture(); await quotaAction(quota, 'acquire', 'in-flight', subject(userID));
    const global = structuredClone(quota.values.get('quota'));
    const upstream = mock.method(globalThis, 'fetch', async url => url.endsWith('/user') ? Response.json(profile()) : new Response(null, { status: 403 }));
    const env = environment(quota, { SUPABASE_SECRET_KEY: secretKey });
    assert.equal((await worker.fetch(account('/v1/account', 'DELETE'), env)).status, 502);
    assert.equal(quota.values.has(`user:${subject(userID)}`), true);
    upstream.mock.mockImplementation(async () => Response.json(profile()));
    assert.equal((await worker.fetch(account('/v1/account', 'DELETE'), env)).status, 200);
    assert.equal(quota.values.has(`user:${subject(userID)}`), false);
    assert.equal(quota.values.has('quota-users'), false); assert.equal(quota.alarmTime, null);
    assert.deepEqual(quota.values.get('quota'), global);
  });
  it('keeps daily cleanup as fallback if immediate cleanup fails after irreversible Auth deletion', async () => {
    const quota = quotaFixture(); let now = Date.UTC(2026, 9, 1, 10); mock.method(Date, 'now', () => now);
    await quotaAction(quota, 'acquire', 'prior', subject(userID)); await quotaAction(quota, 'release', 'prior');
    const global = structuredClone(quota.values.get('quota'));
    mock.method(globalThis, 'fetch', async () => Response.json(profile()));
    const env = environment(quota, { SUPABASE_SECRET_KEY: secretKey });
    env.LABEL_QUOTA.get = () => { throw new Error('storage temporarily unavailable'); };
    assert.equal((await worker.fetch(account('/v1/account', 'DELETE'), env)).status, 200);
    assert.equal(quota.values.has(`user:${subject(userID)}`), true); assert.equal(quota.alarmTime, Date.UTC(2026, 9, 2));
    now = Date.UTC(2026, 9, 2); await quota.runAlarm();
    assert.equal(quota.values.has(`user:${subject(userID)}`), false);
    assert.deepEqual(quota.values.get('quota'), global);
  });
  it('retains existing global counts and private leases when managed users are introduced', async () => {
    const quota = quotaFixture(), now = Date.UTC(2026, 9, 1, 10), hour = Math.floor(now / 3_600_000), day = Math.floor(now / 86_400_000);
    mock.method(Date, 'now', () => now);
    quota.values.set('quota', { hour, day, hourly: 9, daily: 29, lease: 'old-private-lease', leaseUntil: now + 45_000 });
    assert.equal((await quotaAction(quota, 'acquire', 'managed', subject(userID))).allowed, false);
    await quotaAction(quota, 'release', 'old-private-lease');
    assert.equal((await quotaAction(quota, 'acquire', 'managed', subject(userID))).allowed, true);
    await quotaAction(quota, 'release', 'managed');
    assert.equal(quota.values.get('quota').hourly, 10); assert.equal(quota.values.get('quota').daily, 30);
    assert.equal((await quotaAction(quota, 'acquire', 'another', subject(sessionID))).allowed, false);
    assert.equal((await quotaAction(quota, 'acquire', 'private')).allowed, false);
    assert.equal(quota.values.has(`user:${subject(sessionID)}`), false);
  });
  it('enforces 3/hour and 10/day per managed user without increasing the 10/hour shared allowance', async () => {
    const quota = quotaFixture(); let now = Date.UTC(2026, 9, 1, 10); mock.method(Date, 'now', () => now);
    for (let hour = 0; hour < 4; hour++) {
      for (let i = 0; i < (hour < 3 ? 3 : 1); i++) {
        assert.equal((await quotaAction(quota, 'acquire', 'one', subject(userID))).allowed, true);
        await quotaAction(quota, 'release', 'one');
      }
      assert.equal((await quotaAction(quota, 'acquire', 'over-user', subject(userID))).allowed, false);
      now += 3_600_000;
    }
    assert.equal(quota.values.get('quota').daily, 10); assert.equal(quota.values.get(`user:${subject(userID)}`).daily, 10);
    assert.equal((await quotaAction(quota, 'acquire', 'other-user', subject(sessionID))).allowed, true);
    await quotaAction(quota, 'release', 'other-user');
    now += 86_400_000;
    assert.equal((await quotaAction(quota, 'acquire', 'tomorrow', subject(userID))).allowed, true);
  });
  it('keeps open signups within aggregate 30/day and global single-flight admission', async () => {
    const quota = quotaFixture(); let now = Date.UTC(2026, 9, 1, 10); mock.method(Date, 'now', () => now);
    const principal = i => createHash('sha256').update(`synthetic-user-${i}`).digest('hex');
    const concurrent = await Promise.all(Array.from({ length: 8 }, (_, i) => quotaAction(quota, 'acquire', `lease-${i}`, principal(i))));
    assert.equal(concurrent.filter(result => result.allowed).length, 1); await quotaAction(quota, 'release', 'lease-0');
    for (let i = 1; i < 30; i++) {
      if (i % 10 === 0) now += 3_600_000;
      assert.equal((await quotaAction(quota, 'acquire', 'next', principal(i))).allowed, true);
      await quotaAction(quota, 'release', 'next');
      if (i % 10 === 9) assert.equal((await quotaAction(quota, 'acquire', 'hour-limit', principal(100 + i))).allowed, false);
    }
    now += 3_600_000;
    assert.equal((await quotaAction(quota, 'acquire', 'day-limit', principal(999))).allowed, false);
    assert.equal(quota.values.get('quota').daily, 30); assert.equal(quota.values.has(`user:${principal(999)}`), false);
    assert.equal(quota.values.get('quota-users').subjects.length, 30);
  });
  it('counts failed paid attempts in both budgets and rejects the fourth attempt before OpenAI', async () => {
    const quota = quotaFixture(); let paid = 0, checked = 0;
    mock.method(globalThis, 'fetch', async url => {
      if (url === `${project}/auth/v1/user`) { checked++; return Response.json(profile()); }
      assert.equal(url, 'https://api.openai.com/v1/responses'); paid++; return new Response(null, { status: 500 });
    });
    const env = environment(quota);
    for (let i = 0; i < 3; i++) assert.equal((await worker.fetch(analysis(), env)).status, 502);
    assert.equal((await worker.fetch(analysis(), env)).status, 429);
    assert.equal(paid, 3); assert.equal(checked, 4); assert.equal(quota.values.get('quota').lease, null);
    assert.equal(quota.values.get('quota').daily, 3); assert.equal(quota.values.get(`user:${subject(userID)}`).daily, 3);
  });
});
