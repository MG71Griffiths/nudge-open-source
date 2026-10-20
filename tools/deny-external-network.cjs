'use strict';
// Allow only loopback fixtures; suites replace fetch with explicit local mocks.
const originalFetch = globalThis.fetch;
globalThis.fetch = (input, init) => {
  const value = input instanceof Request ? input.url : input;
  const url = new URL(value);
  if (!['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname)) {
    throw new Error('Offline check rejected an external network request.');
  }
  return originalFetch(input, init);
};
for (const name of ['http', 'https']) {
  const module = require('node:' + name);
  for (const method of ['request', 'get']) {
    const original = module[method];
    module[method] = function (input, ...args) {
      let host;
      if (typeof input === 'string' || input instanceof URL) host = new URL(input).hostname;
      else host = input?.hostname || input?.host || 'localhost';
      if (!['127.0.0.1', 'localhost', '[::1]', '::1'].includes(host)) throw new Error('Offline check rejected an external network request.');
      return original.call(this, input, ...args);
    };
  }
}
