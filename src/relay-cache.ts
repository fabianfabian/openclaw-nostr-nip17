import { readFile, writeFile, mkdir } from "node:fs/promises";
import { join } from "node:path";
import { homedir } from "node:os";
import { SimplePool, type Event } from "nostr-tools";

const CACHE_DIR = join(homedir(), ".openclaw", "state", "nostr-nip17", "relay-cache");

// Well-known relays for discovering kind 10050 events.
// DM-only relays (like nip17.com) often reject non-1059 kinds,
// so we need general-purpose relays for metadata lookups.
const DISCOVERY_RELAYS = [
  "wss://relay.damus.io",
  "wss://purplepag.es",
  "wss://relay.primal.net",
  "wss://nos.lol",
];

// In-memory cache to avoid hitting disk on every DM send
const memoryCache = new Map<string, { relays: string[]; fetchedAt: number }>();

// Re-fetch from relays if cache is older than this
const CACHE_TTL_MS = 6 * 60 * 60 * 1000; // 6 hours

function cacheFilePath(pubkey: string): string {
  return join(CACHE_DIR, `${pubkey}-10050.json`);
}

/**
 * Read a cached kind 10050 event for a pubkey.
 */
async function readCached(pubkey: string): Promise<{ event: Event; relays: string[]; fetchedAt: number } | null> {
  // Check memory first
  const mem = memoryCache.get(pubkey);
  if (mem) return { event: null as any, relays: mem.relays, fetchedAt: mem.fetchedAt };

  try {
    const data = JSON.parse(await readFile(cacheFilePath(pubkey), "utf-8"));
    const relays = extractRelaysFromEvent(data.event ?? data);
    const fetchedAt = data.fetchedAt ?? 0;
    if (relays.length > 0) {
      memoryCache.set(pubkey, { relays, fetchedAt });
    }
    return { event: data.event ?? data, relays, fetchedAt };
  } catch {
    return null;
  }
}

/**
 * Write a kind 10050 event to disk cache.
 */
async function writeCache(pubkey: string, event: Event): Promise<void> {
  await mkdir(CACHE_DIR, { recursive: true });
  const relays = extractRelaysFromEvent(event);
  const fetchedAt = Date.now();
  await writeFile(
    cacheFilePath(pubkey),
    JSON.stringify({ event, relays, fetchedAt }, null, 2),
  );
  memoryCache.set(pubkey, { relays, fetchedAt });
}

/**
 * Extract relay URLs from a kind 10050 event's tags.
 */
function extractRelaysFromEvent(event: Event): string[] {
  if (!event?.tags) return [];
  return event.tags
    .filter((t: string[]) => t[0] === "relay" && t[1])
    .map((t: string[]) => t[1]);
}

/**
 * Fetch the kind 10050 DM relay list for a pubkey from relays.
 * Uses discovery relays (general-purpose) since DM-only relays
 * like nip17.com may reject non-kind-1059 queries.
 * Returns the relay URLs or an empty array if not found.
 */
async function fetchKind10050(
  pool: SimplePool,
  pubkey: string,
  queryRelays: string[],
  onError?: (error: Error, context: string) => void,
): Promise<string[]> {
  try {
    // Merge discovery relays with configured relays for best coverage.
    // DM-only relays may not serve kind 10050, so discovery relays are essential.
    const normalizeUrl = (u: string) => u.replace(/\/+$/, "").toLowerCase();
    const seen = new Set(queryRelays.map(normalizeUrl));
    const allQueryRelays = [...queryRelays];
    for (const r of DISCOVERY_RELAYS) {
      if (!seen.has(normalizeUrl(r))) {
        allQueryRelays.push(r);
        seen.add(normalizeUrl(r));
      }
    }

    // Kind 10050 is a replaceable event — querySync returns the latest
    const events = await pool.querySync(
      allQueryRelays,
      { kinds: [10050], authors: [pubkey], limit: 1 },
    );

    if (!events || events.length === 0) return [];

    // Pick the most recent one
    const latest = events.sort((a, b) => b.created_at - a.created_at)[0];
    const relays = extractRelaysFromEvent(latest);

    if (relays.length > 0) {
      await writeCache(pubkey, latest);
    }

    return relays;
  } catch (err) {
    onError?.(err as Error, `fetch kind 10050 for ${pubkey}`);
    return [];
  }
}

/**
 * Get the DM relays for a recipient pubkey.
 * Uses cache if fresh, otherwise fetches from relays.
 */
export async function getRecipientDmRelays(
  pool: SimplePool,
  pubkey: string,
  queryRelays: string[],
  onError?: (error: Error, context: string) => void,
): Promise<string[]> {
  // Check cache
  const cached = await readCached(pubkey);
  if (cached && cached.relays.length > 0) {
    const age = Date.now() - cached.fetchedAt;
    if (age < CACHE_TTL_MS) {
      return cached.relays;
    }
  }

  // Fetch fresh
  const relays = await fetchKind10050(pool, pubkey, queryRelays, onError);
  return relays;
}
