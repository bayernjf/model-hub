import { timingSafeEqual } from 'node:crypto';
import type { AdminRole, HubConfig } from '../config.js';

export interface AdminIdentity {
  username: string;
  role: AdminRole;
}

// Constant-time comparison that also returns false for differing lengths.
function safeEqual(a: string, b: string): boolean {
  const ab = Buffer.from(a);
  const bb = Buffer.from(b);
  if (ab.length !== bb.length) return false;
  return timingSafeEqual(ab, bb);
}

// Authenticate against the fixed env-backed accounts. There is no user table
// and no registration. The operator account exists only when its password is
// configured.
export function authenticate(
  config: HubConfig,
  username: string,
  password: string,
): AdminIdentity | null {
  if (
    safeEqual(username, config.ownerUsername) &&
    safeEqual(password, config.adminPassword)
  ) {
    return { username: config.ownerUsername, role: 'owner' };
  }

  if (
    config.operatorPassword !== undefined &&
    safeEqual(username, config.operatorUsername) &&
    safeEqual(password, config.operatorPassword)
  ) {
    return { username: config.operatorUsername, role: 'operator' };
  }

  return null;
}
