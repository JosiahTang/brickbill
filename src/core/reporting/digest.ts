import { createHash } from 'node:crypto';

/** Shared server/CLI byte digest; keep hashing independent of repository storage. */
export function sha256(bytes: Uint8Array): string { return createHash('sha256').update(bytes).digest('hex'); }
