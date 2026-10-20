// Administrative commands require an explicit destination, never a built-in service.
export function requireAdminOrigin(raw = process.env.NUDGE_ADMIN_ORIGIN) {
  if (!raw) throw new Error('Set NUDGE_ADMIN_ORIGIN to your HTTPS service origin before running an administrative command.');
  let url; try { url = new URL(raw); } catch { throw new Error('Invalid administrative HTTPS origin.'); }
  if (url.protocol !== 'https:' || url.username || url.password || url.pathname !== '/' || url.search || url.hash || url.hostname.endsWith('.invalid') || raw !== url.origin)
    throw new Error('Use an HTTPS origin without credentials, path, query or fragment.');
  return url.origin;
}
