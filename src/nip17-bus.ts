import {
  SimplePool,
  getPublicKey,
  finalizeEvent,
  nip19,
  type Event,
} from "nostr-tools";
import { wrapEvent, unwrapEvent } from "nostr-tools/nip59";
import {
  readNostrBusState,
  writeNostrBusState,
  computeSinceTimestamp,
} from "./state-store.js";
import { getRecipientDmRelays } from "./relay-cache.js";
import {
  parseImetaTags,
  fetchAndDecryptBlob,
  mediaToDataUrl,
  deriveConversationKey,
  type MediaAttachment,
} from "./media-handler.js";
import {
  parseKind15Tags,
  fetchAndDecryptKind15File,
  type Kind15FileMetadata,
} from "./kind15-handler.js";

export const DEFAULT_RELAYS = ["wss://relay.damus.io", "wss://nos.lol"];

// NIP-59 gift wraps use randomized timestamps up to 2 days in the past,
// so we need a much wider lookback window than normal
const STARTUP_LOOKBACK_SEC = 2 * 24 * 60 * 60; // 2 days
const MAX_PERSISTED_EVENT_IDS = 5000;
const STATE_PERSIST_DEBOUNCE_MS = 5000;

// ============================================================================
// Types
// ============================================================================

export interface DecryptedMedia {
  dataUrl: string;
  mimeType?: string;
  originalUrl: string;
  blurhash?: string;
  dimensions?: { width: number; height: number };
}

export interface Nip17BusOptions {
  privateKey: string;
  relays?: string[];
  accountId?: string;
  onMessage: (
    senderPubkey: string,
    text: string,
    reply: (text: string) => Promise<void>,
    media?: DecryptedMedia[],
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

// ============================================================================
// Module-level dedup — survives across bus restarts / multiple startAccount calls
// ============================================================================
const globalSeen = new Set<string>();
const GLOBAL_SEEN_MAX = 20000;

function globalDedup(key: string): boolean {
  if (globalSeen.has(key)) return true; // already seen
  globalSeen.add(key);
  // Trim oldest entries when too large
  if (globalSeen.size > GLOBAL_SEEN_MAX) {
    const toDelete = globalSeen.size - Math.floor(GLOBAL_SEEN_MAX * 0.8);
    let deleted = 0;
    for (const id of globalSeen) {
      if (deleted >= toDelete) break;
      globalSeen.delete(id);
      deleted++;
    }
  }
  return false;
}

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

  // NIP-42: automatically sign AUTH challenges, but ONLY for relays in our config.
  // We don't want to hand signed auth events to arbitrary relays.
  const normalizeRelayUrl = (url: string) => url.replace(/\/+$/, "").toLowerCase();
  const trustedRelays = new Set(relays.map(normalizeRelayUrl));

  const pool = new SimplePool({
    automaticallyAuth: (url: string) => {
      if (!trustedRelays.has(normalizeRelayUrl(url))) return undefined;
      return (authEvent: any) => finalizeEvent(authEvent, sk);
    },
  });
  const accountId = options.accountId ?? pk.slice(0, 16);
  const gatewayStartedAt = Math.floor(Date.now() / 1000);

  // State persistence
  const state = await readNostrBusState({ accountId });
  const baseSince = computeSinceTimestamp(state, gatewayStartedAt);
  const since = Math.max(0, baseSince - STARTUP_LOOKBACK_SEC);

  if (state?.recentEventIds?.length) {
    for (const id of state.recentEventIds) globalDedup(`gw:${id}`);
  }

  // On restart, don't replay old backlog. Only process rumors that arrived
  // within a short grace window before this gateway started. Anything older
  // is considered "seen" even if we never responded — prevents the flood of
  // old messages being replayed after an update/restart.
  const RESTART_GRACE_SEC = 10 * 60; // 10 minutes
  const savedLastRumorAt = state?.lastRumorAt ?? 0;
  const minLastRumorAt = gatewayStartedAt - RESTART_GRACE_SEC;
  const effectiveLastRumorAt = Math.max(savedLastRumorAt, minLastRumorAt);

  await writeNostrBusState({
    accountId,
    lastProcessedAt: state?.lastProcessedAt ?? gatewayStartedAt,
    gatewayStartedAt,
    recentEventIds: state?.recentEventIds ?? [],
    lastRumorAt: effectiveLastRumorAt,
  });

  let lastProcessedAt = state?.lastProcessedAt ?? gatewayStartedAt;
  let lastRumorAt = effectiveLastRumorAt;
  let recentEventIds = (state?.recentEventIds ?? []).slice(-MAX_PERSISTED_EVENT_IDS);

  function persistStateNow(): void {
    writeNostrBusState({
      accountId,
      lastProcessedAt,
      gatewayStartedAt,
      recentEventIds,
      lastRumorAt,
    }).catch((err) => onError?.(err as Error, "persist state"));
  }

  function scheduleStatePersist(eventCreatedAt: number, eventId: string): void {
    lastProcessedAt = Math.max(lastProcessedAt, eventCreatedAt);
    recentEventIds.push(eventId);
    if (recentEventIds.length > MAX_PERSISTED_EVENT_IDS)
      recentEventIds = recentEventIds.slice(-MAX_PERSISTED_EVENT_IDS);
    // Write immediately to survive restarts — dedup correctness > disk IO savings
    persistStateNow();
  }

  // inflight removed — using module-level globalDedup instead

  // Handle incoming gift-wrapped events (kind 1059)
  async function handleEvent(event: Event): Promise<void> {
    try {
      // Dedupe at gift-wrap level (module-global, survives restarts)
      if (globalDedup(`gw:${event.id}`)) return;

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

      // Handle kind 14 (chat messages) and kind 15 (file attachments)
      if (rumor.kind !== 14 && rumor.kind !== 15) return;

      // Dedupe by rumor ID (same rumor arrives in different gift wraps from each relay).
      const rumorId = rumor.id ? `rumor:${rumor.id}` : `rumor:${rumor.pubkey}:${rumor.created_at}:${rumor.content?.slice(0, 32)}`;
      if (globalDedup(rumorId)) return;

      // Skip our own messages
      if (rumor.pubkey === pk) return;

      // Skip rumors we've already seen — only process newer than last known rumor timestamp
      if (lastRumorAt > 0 && rumor.created_at <= lastRumorAt) return;

      // Already marked in globalDedup above

      const senderPubkey = rumor.pubkey;
      const text = rumor.content;

      // Create reply function — wrapped to prevent unhandled rejections
      const replyFn = async (responseText: string): Promise<void> => {
        try {
          await sendNip17Dm(pool, sk, senderPubkey, responseText, relays, trustedRelays, onError);
        } catch (err) {
          onError?.(err as Error, `reply to ${senderPubkey}`);
        }
      };

      // Parse and decrypt media attachments (if any)
      let decryptedMedia: DecryptedMedia[] | undefined;
      
      if (rumor.kind === 15) {
        // Kind 15: File message with AES-GCM encryption
        const metadata = parseKind15Tags(rumor.tags || []);
        if (metadata) {
          metadata.url = rumor.content; // URL is in content for kind 15
          try {
            const { data, mimeType } = await fetchAndDecryptKind15File(metadata);
            const dataUrl = mediaToDataUrl(data, mimeType);
            
            decryptedMedia = [{
              dataUrl,
              mimeType,
              originalUrl: metadata.url,
              blurhash: metadata.blurhash,
              dimensions: metadata.dimensions,
            }];
          } catch (err) {
            onError?.(err as Error, `decrypt kind 15 file ${metadata.url}`);
          }
        }
      } else {
        // Kind 14: Check for imeta tags (NIP-44 encrypted Blossom blobs)
        const mediaAttachments = parseImetaTags(rumor.tags || []);
        if (mediaAttachments.length > 0) {
          decryptedMedia = [];
          const conversationKey = deriveConversationKey(sk, senderPubkey);
          
          for (const attachment of mediaAttachments) {
            try {
              const { data, mimeType } = await fetchAndDecryptBlob(
                attachment.url,
                conversationKey,
              );
              const effectiveMimeType = mimeType || attachment.mimeType;
              const dataUrl = mediaToDataUrl(data, effectiveMimeType);
              
              decryptedMedia.push({
                dataUrl,
                mimeType: effectiveMimeType,
                originalUrl: attachment.url,
                blurhash: attachment.blurhash,
                dimensions: attachment.dimensions,
              });
            } catch (err) {
              onError?.(err as Error, `decrypt media ${attachment.url}`);
            }
          }
        }
      }

      await onMessage(senderPubkey, text, replyFn, decryptedMedia);
      lastRumorAt = Math.max(lastRumorAt, rumor.created_at);
      scheduleStatePersist(event.created_at, event.id);
    } catch (err) {
      onError?.(err as Error, `event ${event.id}`);
    } finally {
      // cleanup handled by globalDedup
    }
  }

  // Subscribe to kind 1059 (gift wraps) addressed to us
  // Use since set to 2 days ago to catch NIP-59 randomized timestamps
  let closed = false;
  let reconnectAttempts = 0;
  let reconnectTimer: ReturnType<typeof setTimeout> | null = null;

  // NIP-42 auth signer for subscription-level auth-required retries
  const authSigner = (authEvent: any) => finalizeEvent(authEvent, sk);

  function subscribe() {
    const subSince = Math.max(0, Math.floor(Date.now() / 1000) - STARTUP_LOOKBACK_SEC);
    return pool.subscribeMany(
      relays,
      { kinds: [1059], "#p": [pk], since: subSince } as any,
      {
        onauth: authSigner,
        onevent: (event) => { handleEvent(event).catch((err) => onError?.(err as Error, `unhandled in handleEvent ${event.id}`)); },
        oneose: () => {
          reconnectAttempts = 0; // reset backoff on successful EOSE
          onEose?.(relays.join(", "));
        },
        onclose: (reason) => {
          options.onDisconnect?.(relays.join(", "));
          onError?.(new Error(`Subscription closed: ${reason}`), "subscription");
          if (!closed) {
            const delay = Math.min(5000 * Math.pow(2, reconnectAttempts), 5 * 60 * 1000);
            reconnectAttempts++;
            onError?.(new Error(`Reconnecting in ${delay / 1000}s (attempt ${reconnectAttempts})`), "reconnect");
            reconnectTimer = setTimeout(() => {
              if (!closed) {
                activeSub = subscribe();
              }
            }, delay);
          }
        },
      },
    );
  }

  let activeSub = subscribe();

  const sendDm = async (toPubkey: string, text: string): Promise<void> => {
    await sendNip17Dm(pool, sk, toPubkey, text, relays, trustedRelays, onError);
  };

  return {
    close: () => {
      closed = true;
      if (reconnectTimer) clearTimeout(reconnectTimer);
      activeSub.close();
      persistStateNow();
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
  trustedRelays: Set<string>,
  onError?: (error: Error, context: string) => void,
): Promise<void> {
  const pk = getPublicKey(sk);

  // NIP-42 auth signer — only signs for relays in our config to prevent privacy leaks.
  // The auth event contains the relay URL, so a rogue relay could learn our pubkey
  // if we blindly sign for any relay that challenges us.
  const onauth = (authEvent: any) => {
    const relayTag = authEvent.tags?.find((t: string[]) => t[0] === "relay");
    const relayUrl = relayTag?.[1] ?? "";
    if (!trustedRelays.has(relayUrl.replace(/\/+$/, "").toLowerCase())) {
      throw new Error(`Refusing to auth against untrusted relay: ${relayUrl}`);
    }
    return finalizeEvent(authEvent, sk);
  };

  // Look up the recipient's DM relays (kind 10050) and merge with ours.
  // This ensures replies reach the recipient even if they use different relays.
  const recipientDmRelays = await getRecipientDmRelays(pool, toPubkey, relays, onError);
  const normalizeUrl = (u: string) => u.replace(/\/+$/, "").toLowerCase();
  const ourRelaySet = new Set(relays.map(normalizeUrl));
  const extraRelays = recipientDmRelays.filter(r => !ourRelaySet.has(normalizeUrl(r)));
  const allRelays = [...relays, ...extraRelays];

  if (extraRelays.length > 0) {
    onError?.(new Error(`Adding recipient DM relays: ${extraRelays.join(", ")}`), "recipient-relays");
  }

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

  // Publish recipient's wrap to all relays (ours + theirs)
  // Publish our self-copy wrap to only our relays
  // Pass onauth so publishes retry after NIP-42 auth challenges (only for trusted relays)
  const publishPromises: Promise<any>[] = [];

  // Recipient wrap → all relays (ours + recipient's DM relays)
  for (const relay of allRelays) {
    try {
      const pubResults = pool.publish([relay], wrapForRecipient as any, { onauth });
      for (const p of pubResults) {
        if (p && typeof p.catch === 'function') { p.catch(() => {}); publishPromises.push(p); }
      }
    } catch (err) {
      onError?.(err as Error, `publish to ${relay}`);
    }
  }

  // Self wrap → only our relays
  for (const relay of relays) {
    try {
      const pubResults = pool.publish([relay], wrapForSelf as any, { onauth });
      for (const p of pubResults) {
        if (p && typeof p.catch === 'function') { p.catch(() => {}); publishPromises.push(p); }
      }
    } catch (err) {
      onError?.(err as Error, `publish to ${relay}`);
    }
  }

  const results = await Promise.allSettled(publishPromises);
  const failures = results.filter(r => r.status === 'rejected');
  if (failures.length > 0) {
    onError?.(new Error(`Publish: ${results.length - failures.length}/${results.length} ok, failures: ${failures.map(f => (f as PromiseRejectedResult).reason).join(', ')}`), 'publish');
  }
  if (publishPromises.length === 0) {
    onError?.(new Error('No publish attempts succeeded (all relays threw synchronously)'), 'publish');
  }
}
