import { readFile, writeFile, mkdir } from "node:fs/promises";
import { join } from "node:path";
import { homedir } from "node:os";

const STATE_DIR = join(homedir(), ".openclaw", "state", "nostr-nip17");

export interface NostrBusState {
  lastProcessedAt: number;
  gatewayStartedAt: number;
  recentEventIds: string[];
  /** Content fingerprints for rumor-level dedup across restarts */
  recentFingerprints?: string[];
  /** Most recent rumor created_at timestamp — skip anything at or before this on restart */
  lastRumorAt?: number;
}

function stateFilePath(accountId: string): string {
  return join(STATE_DIR, `${accountId}.json`);
}

export async function readNostrBusState(opts: { accountId: string }): Promise<NostrBusState | null> {
  try {
    const data = await readFile(stateFilePath(opts.accountId), "utf-8");
    return JSON.parse(data);
  } catch {
    return null;
  }
}

export async function writeNostrBusState(state: NostrBusState & { accountId: string }): Promise<void> {
  await mkdir(STATE_DIR, { recursive: true });
  const { accountId, ...data } = state;
  await writeFile(stateFilePath(accountId), JSON.stringify(data, null, 2));
}

export function computeSinceTimestamp(state: NostrBusState | null, gatewayStartedAt: number): number {
  if (state?.lastProcessedAt) return state.lastProcessedAt;
  return gatewayStartedAt;
}
