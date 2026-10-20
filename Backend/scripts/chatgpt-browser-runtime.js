// Scoped browser-bundle substitutions. Every cloned value belongs to a JSON
// evidence contract. Native supplies a UUID callback; no credential is exposed.
export const structuredClone = value => JSON.parse(JSON.stringify(value));
export const crypto = { randomUUID() {
  const id = globalThis.__nudgeChatGPTUUID?.();
  if (typeof id !== 'string' || !/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i.test(id)) throw new Error('Local analysis identity is unavailable.');
  return id;
} };
