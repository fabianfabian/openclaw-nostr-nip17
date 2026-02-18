import {
  SimplePool,
  getPublicKey,
  nip19,
  type Event,
} from "nostr-tools";
import { wrapEvent, unwrapEvent } from "nostr-tools/nip59";
import {
  readNostrBusState,
  writeNostrBusState,
  computeSinceTimestamp,
} from "./state-store.js";

export const DEFAULT_RELAYS = ["wss://relay.damus.io", "wss://nos.lol"];

// NIP-59 gift wraps use randomized timestamps up to 2 days in the past,
// so we need a much wider lookback window than normal
const STARTUP_LOOKBACK_SEC = 2 * 24 * 60 * 60; // 2 days
const MAX_PERSISTED_EVENT_IDS = 5000;
const STATE_PERSIST_DEBOUNCE_MS = 5000;

// ============================================================================
// Types
// ============================================================================

export interface Nip17BusOptions {
  privateKey: string;
  relays?: string[];
  accountId?: string;
  onMessage: (
    senderPubkey: string,
    text: string,
    reply: (text: string) => Promise<void>,
  ) => Promise<void>;
  onError?: (error: Error, context: string) => void;
  onConnect?: (relay: string) => void;
  onDisconnect?: (relay: string) => void;
  onEose?: (relay: string) => void;
}

export interface Nip17BusHandle {
  close: () => void;
  publicKey: string;
  sendDm: (toPubkey: string, text: string) => Promise<void>;
}

// ============================================================================
// Key Utilities
// ============================================================================

export function validatePrivateKey(key: string): Uint8Array {
  const trimmed = key.trim();
  if (trimmed.startsWith("nsec1")) {
    const decoded = nip19.decode(trimmed);
    if (decoded.type !== "nsec") throw new Error("Invalid nsec key");
    return decoded.data as Uint8Array;
  }
  if (!/^[0-9a-fA-F]{64}$/.test(trimmed))
    throw new Error("Private key must be 64 hex chars or nsec format");
  const bytes = new Uint8Array(32);
  for (let i = 0; i < 32; i++) bytes[i] = parseInt(trimmed.slice(i * 2, i * 2 + 2), 16);
  return bytes;
}

export function getPublicKeyFromPrivate(privateKey: string): string {
  return getPublicKey(validatePrivateKey(privateKey));
}

export function normalizePubkey(input: string): string {
  const trimmed = input.trim();
  if (trimmed.startsWith("npub1")) {
    const decoded = nip19.decode(trimmed);
    if (decoded.type !== "npub") throw new Error("Invalid npub key");
    return Array.from(decoded.data as unknown as Uint8Array)
      .map((b) => b.toString(16).padStart(2, "0"))
      .join("");
  }
  if (!/^[0-9a-fA-F]{64}$/.test(trimmed))
    throw new Error("Pubkey must be 64 hex chars or npub format");
  return trimmed.toLowerCase();
}

export function pubkeyToNpub(hexPubkey: string): string {
  return nip19.npubEncode(normalizePubkey(hexPubkey));
}

export function isValidPubkey(input: string): boolean {
  if (typeof input !== "string") return false;
  const trimmed = input.trim();
  if (trimmed.startsWith("npub1")) {
    try { nip19.decode(trimmed); return true; } catch { return false; }
  }
  return /^[0-9a-fA-F]{64}$/.test(trimmed);
}

// ============================================================================
// Main Bus - NIP-17 Gift-Wrapped DMs
// ============================================================================

export async function startNip17Bus(options: Nip17BusOptions): Promise<Nip17BusHandle> {
  const {
    privateKey,
    relays = DEFAULT_RELAYS,
    onMessage,
    onError,
    onEose,
  } = options;

  const sk = validatePrivateKey(privateKey);
  const pk = getPublicKey(sk);
  const pool = new SimplePool();
  const accountId = options.accountId ?? pk.slice(0, 16);
  const gatewayStartedAt = Math.floor(Date.now() / 1000);

  // Dedupe
  const seen = new Set<string>();

  // State persistence
  const state = await readNostrBusState({ accountId });
  const baseSince = computeSinceTimestamp(state, gatewayStartedAt);
  const since = Math.max(0, baseSince - STARTUP_LOOKBACK_SEC);

  if (state?.recentEventIds?.length) {
    for (const id of state.recentEventIds) seen.add(id);
  }

  await writeNostrBusState({
    accountId,
    lastProcessedAt: state?.lastProcessedAt ?? gatewayStartedAt,
    gatewayStartedAt,
    recentEventIds: state?.recentEventIds ?? [],
  });

  let pendingWrite: ReturnType<typeof setTimeout> | undefined;
  let lastProcessedAt = state?.lastProcessedAt ?? gatewayStartedAt;
  let recentEventIds = (state?.recentEventIds ?? []).slice(-MAX_PERSISTED_EVENT_IDS);

  function scheduleStatePersist(eventCreatedAt: number, eventId: string): void {
    lastProcessedAt = Math.max(lastProcessedAt, eventCreatedAt);
    recentEventIds.push(eventId);
    if (recentEventIds.length > MAX_PERSISTED_EVENT_IDS)
      recentEventIds = recentEventIds.slice(-MAX_PERSISTED_EVENT_IDS);
    if (pendingWrite) clearTimeout(pendingWrite);
    pendingWrite = setTimeout(() => {
      writeNostrBusState({
        accountId,
        lastProcessedAt,
        gatewayStartedAt,
        recentEventIds,
      }).catch((err) => onError?.(err as Error, "persist state"));
    }, STATE_PERSIST_DEBOUNCE_MS);
  }

  const inflight = new Set<string>();

  // Handle incoming gift-wrapped events (kind 1059)
  async function handleEvent(event: Event): Promise<void> {
    try {
      // Dedupe
      if (seen.has(event.id) || inflight.has(event.id)) return;
      inflight.add(event.id);

      // Kind 1059 = gift wrap
      if (event.kind !== 1059) return;

      // Unwrap: gift wrap → rumor (unwrapEvent handles the full chain)
      let rumor: Event;
      try {
        rumor = unwrapEvent(event, sk) as unknown as Event;
      } catch (err) {
        onError?.(err as Error, `unwrap gift wrap ${event.id}`);
        return;
      }

      // We only handle kind 14 (chat messages) for now
      if (rumor.kind !== 14) return;

      // Skip our own messages
      if (rumor.pubkey === pk) return;

      // Skip stale events based on rumor timestamp (not gift wrap timestamp,
      // which is randomized per NIP-59)
      // Use a generous window since rumor timestamps are also slightly fuzzed
      const staleThreshold = Math.floor(Date.now() / 1000) - STARTUP_LOOKBACK_SEC * 1.5; // Wider for randomized timestamps
      if (rumor.created_at < staleThreshold) return;

      // Mark seen
      seen.add(event.id);

      const senderPubkey = rumor.pubkey;
      const text = rumor.content;

      // Create reply function
      const replyFn = async (responseText: string): Promise<void> => {
        await sendNip17Dm(pool, sk, senderPubkey, responseText, relays, onError);
      };

      await onMessage(senderPubkey, text, replyFn);
      scheduleStatePersist(event.created_at, event.id);
    } catch (err) {
      onError?.(err as Error, `event ${event.id}`);
    } finally {
      inflight.delete(event.id);
    }
  }

  // Subscribe to kind 1059 (gift wraps) addressed to us
  // Use since set to 2 days ago to catch NIP-59 randomized timestamps
  const sub = pool.subscribeMany(
    relays,
    { kinds: [1059], "#p": [pk], since } as any,
    {
      onevent: handleEvent,
      oneose: () => {
        onEose?.(relays.join(", "));
      },
      onclose: (reason) => {
        options.onDisconnect?.(relays.join(", "));
        onError?.(new Error(`Subscription closed: ${reason}`), "subscription");
      },
    },
  );

  const sendDm = async (toPubkey: string, text: string): Promise<void> => {
    await sendNip17Dm(pool, sk, toPubkey, text, relays, onError);
  };

  return {
    close: () => {
      sub.close();
      if (pendingWrite) {
        clearTimeout(pendingWrite);
        writeNostrBusState({ accountId, lastProcessedAt, gatewayStartedAt, recentEventIds })
          .catch((err) => onError?.(err as Error, "persist state on close"));
      }
    },
    publicKey: pk,
    sendDm,
  };
}

// ============================================================================
// Send NIP-17 DM
// ============================================================================

async function sendNip17Dm(
  pool: SimplePool,
  sk: Uint8Array,
  toPubkey: string,
  text: string,
  relays: string[],
  onError?: (error: Error, context: string) => void,
): Promise<void> {
  const pk = getPublicKey(sk);

  // Create the kind 14 rumor (unsigned chat message)
  const chatEvent = {
    kind: 14,
    content: text,
    tags: [["p", toPubkey]], // Only receiver
    created_at: Math.floor(Date.now() / 1000),
  };

  // Manual NIP-59: rumor → seal → wrap
  // createWrap already signs with an ephemeral key — do NOT re-sign with sk
  const rumor = require('nostr-tools/nip59').createRumor(chatEvent, sk);
  const sealRecipient = require('nostr-tools/nip59').createSeal(rumor, sk, toPubkey);
  const wrapForRecipient = require('nostr-tools/nip59').createWrap(sealRecipient, toPubkey);

  const sealSelf = require('nostr-tools/nip59').createSeal(rumor, sk, pk);
  const wrapForSelf = require('nostr-tools/nip59').createWrap(sealSelf, pk);

  // Publish both wraps to all relays
  const publishPromises: Promise<any>[] = [];
  for (const wrap of [wrapForRecipient, wrapForSelf]) {
    for (const relay of relays) {
      publishPromises.push(pool.publish([relay], wrap as any));
    }
  }

  const results = await Promise.allSettled(publishPromises);
  onError?.(new Error(`Publish results: ${results.length} total, ${results.filter(r => r.status === 'fulfilled').length} success, ${results.filter(r => r.status === 'rejected').length} failed`), 'publish');

  const failures = results.filter(r => r.status === 'rejected');
  if (failures.length > 0) {
    onError?.(new Error(`Failed to publish ${failures.length} messages: ${failures.map(f => f.reason).join(', ')}`), 'publish');
  }
}
