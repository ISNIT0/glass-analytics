/**
 * Once per CLI process, warn when the Worker is behind either this CLI or the
 * latest published release. Agents and humans both see it on normal commands.
 */

import { GLASS_VERSION, UPGRADE_COMMAND } from '@dataflare/core/version';
import { call } from './client.ts';
import { skip } from './output.ts';

interface Health {
  version: string;
  latest?: string | null;
  upgradeAvailable?: boolean;
  upgradeCommand?: string;
}

let checked = false;

export async function warnIfOutdated(options: { json?: boolean } = {}): Promise<void> {
  if (checked || options.json) return;
  checked = true;
  try {
    const health = await call<Health>('GET', '/health');
    const command = health.upgradeCommand ?? UPGRADE_COMMAND;
    if (health.upgradeAvailable && health.latest) {
      skip(
        `Dataflare ${health.latest} is available (this deployment is ${health.version}). Run: ${command}`,
      );
      return;
    }
    if (health.version !== GLASS_VERSION) {
      skip(`Worker is Dataflare ${health.version}; this CLI is ${GLASS_VERSION}. Run: ${command}`);
    }
  } catch {
    // Offline / misconfigured projects still need the original command's error.
  }
}

/** Reset for tests. */
export function resetUpgradeCheck(): void {
  checked = false;
}
