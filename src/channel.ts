import {
  buildChannelConfigSchema,
  collectStatusIssuesFromLastError,
  createDefaultChannelRuntimeState,
  createReplyPrefixOptions,
  DEFAULT_ACCOUNT_ID,
  formatPairingApproveHint,
  type ChannelPlugin,
} from "openclaw/plugin-sdk";
import { Nip17ConfigSchema } from "./config-schema.js";
import { normalizePubkey, startNip17Bus, type Nip17BusHandle } from "./nip17-bus.js";
import { getNip17Runtime } from "./runtime.js";
import {
  listNip17AccountIds,
  resolveDefaultNip17AccountId,
  resolveNip17Account,
  type ResolvedNip17Account,
} from "./types.js";

const activeBuses = new Map<string, Nip17BusHandle>();

export const nip17Plugin: ChannelPlugin<ResolvedNip17Account> = {
  id: "nostr-nip17",
  meta: {
    id: "nostr-nip17",
    label: "Nostr (NIP-17)",
    selectionLabel: "Nostr (NIP-17)",
    docsPath: "/channels/nostr",
    docsLabel: "nostr-nip17",
    blurb: "Private DMs via Nostr relays (NIP-17 gift-wrapped)",
    order: 54,
  },
  capabilities: {
    chatTypes: ["direct"],
    media: false,
  },
  reload: { configPrefixes: ["channels.nostr-nip17"] },
  configSchema: buildChannelConfigSchema(Nip17ConfigSchema),

  config: {
    listAccountIds: (cfg) => listNip17AccountIds(cfg),
    resolveAccount: (cfg, accountId) => resolveNip17Account({ cfg, accountId }),
    defaultAccountId: (cfg) => resolveDefaultNip17AccountId(cfg),
    isConfigured: (account) => account.configured,
    describeAccount: (account) => ({
      accountId: account.accountId,
      name: account.name,
      enabled: account.enabled,
      configured: account.configured,
      publicKey: account.publicKey,
    }),
    resolveAllowFrom: ({ cfg, accountId }) =>
      (resolveNip17Account({ cfg, accountId }).config.allowFrom ?? []).map(String),
    formatAllowFrom: ({ allowFrom }) =>
      allowFrom
        .map((e) => String(e).trim())
        .filter(Boolean)
        .map((e) => {
          if (e === "*") return "*";
          try { return normalizePubkey(e); } catch { return e; }
        })
        .filter(Boolean),
  },

  pairing: {
    idLabel: "nostrPubkey",
    normalizeAllowEntry: (entry) => {
      try { return normalizePubkey(entry.replace(/^nostr:/i, "")); } catch { return entry; }
    },
    notifyApproval: async ({ id }) => {
      const bus = activeBuses.get(DEFAULT_ACCOUNT_ID);
      if (bus) await bus.sendDm(id, "Your pairing request has been approved!");
    },
  },

  security: {
    resolveDmPolicy: ({ account }) => ({
      policy: account.config.dmPolicy ?? "pairing",
      allowFrom: account.config.allowFrom ?? [],
      policyPath: "channels.nostr-nip17.dmPolicy",
      allowFromPath: "channels.nostr-nip17.allowFrom",
      approveHint: formatPairingApproveHint("nostr-nip17"),
      normalizeEntry: (raw) => {
        try { return normalizePubkey(raw.replace(/^nostr:/i, "").trim()); } catch { return raw.trim(); }
      },
    }),
  },

  messaging: {
    normalizeTarget: (target) => {
      const cleaned = target.replace(/^nostr:/i, "").trim();
      try { return normalizePubkey(cleaned); } catch { return cleaned; }
    },
    targetResolver: {
      looksLikeId: (input) => {
        const t = input.trim();
        return t.startsWith("npub1") || /^[0-9a-fA-F]{64}$/.test(t);
      },
      hint: "<npub|hex pubkey|nostr:npub...>",
    },
  },

  outbound: {
    deliveryMode: "direct",
    textChunkLimit: 4000,
    sendText: async ({ to, text, accountId }) => {
      const core = getNip17Runtime();
      const aid = accountId ?? DEFAULT_ACCOUNT_ID;
      const bus = activeBuses.get(aid);
      if (!bus) throw new Error(`NIP-17 bus not running for account ${aid}`);
      const tableMode = core.channel.text.resolveMarkdownTableMode({
        cfg: core.config.loadConfig(),
        channel: "nostr-nip17",
        accountId: aid,
      });
      const message = core.channel.text.convertMarkdownTables(text ?? "", tableMode);
      const normalizedTo = normalizePubkey(to);
      await bus.sendDm(normalizedTo, message);
      return {
        channel: "nostr-nip17" as const,
        to: normalizedTo,
        messageId: `nostr-nip17-${Date.now()}`,
      };
    },
    sendMedia: async ({ to, text, accountId }) => {
      // Nostr NIP-17 doesn't support media attachments natively;
      // send caption/text only as a fallback
      const core = getNip17Runtime();
      const aid = accountId ?? DEFAULT_ACCOUNT_ID;
      const bus = activeBuses.get(aid);
      if (!bus) throw new Error(`NIP-17 bus not running for account ${aid}`);
      const normalizedTo = normalizePubkey(to);
      if (text?.trim()) {
        await bus.sendDm(normalizedTo, text);
      }
      return {
        channel: "nostr-nip17" as const,
        to: normalizedTo,
        messageId: `nostr-nip17-${Date.now()}`,
      };
    },
  },

  status: {
    defaultRuntime: createDefaultChannelRuntimeState(DEFAULT_ACCOUNT_ID),
    collectStatusIssues: (accounts) => collectStatusIssuesFromLastError("nostr-nip17", accounts),
    buildChannelSummary: ({ snapshot }) => ({
      configured: snapshot.configured ?? false,
      publicKey: snapshot.publicKey ?? null,
      running: snapshot.running ?? false,
      lastStartAt: snapshot.lastStartAt ?? null,
      lastStopAt: snapshot.lastStopAt ?? null,
      lastError: snapshot.lastError ?? null,
    }),
    buildAccountSnapshot: ({ account, runtime }) => ({
      accountId: account.accountId,
      name: account.name,
      enabled: account.enabled,
      configured: account.configured,
      publicKey: account.publicKey,
      running: runtime?.running ?? false,
      lastStartAt: runtime?.lastStartAt ?? null,
      lastStopAt: runtime?.lastStopAt ?? null,
      lastError: runtime?.lastError ?? null,
      lastInboundAt: runtime?.lastInboundAt ?? null,
      lastOutboundAt: runtime?.lastOutboundAt ?? null,
    }),
  },

  gateway: {
    startAccount: async (ctx) => {
      const account = ctx.account;
      ctx.setStatus({
        accountId: account.accountId,
        publicKey: account.publicKey,
      });
      ctx.log?.info(`[${account.accountId}] Starting NIP-17 provider (pubkey: ${account.publicKey})`);

      if (!account.configured) throw new Error("NIP-17 private key not configured");

      const runtime = getNip17Runtime();

      const bus = await startNip17Bus({
        accountId: account.accountId,
        privateKey: account.privateKey,
        relays: account.relays,
        onMessage: async (senderPubkey, text, reply) => {
          ctx.log?.debug?.(`[${account.accountId}] NIP-17 DM from ${senderPubkey}: ${text.slice(0, 50)}...`);

          const { onModelSelected, ...prefixOptions } = createReplyPrefixOptions({
            cfg: runtime.config.loadConfig(),
            agentId: runtime.channel.reply.resolveAgentId({}),
            channel: "nostr-nip17",
            accountId: account.accountId,
          });

          const ctxPayload = runtime.channel.reply.finalizeInboundContext({
            Body: text,
            RawBody: text,
            CommandBody: text,
            From: `nostr:${senderPubkey}`,
            To: `nostr:${account.publicKey}`,
            CommandAuthorized: true,
            SessionKey: "main", // Target main session
          });

          await runtime.channel.reply.dispatchReplyWithBufferedBlockDispatcher({
            ctx: ctxPayload,
            cfg: runtime.config.loadConfig(),
            dispatcherOptions: {
              ...prefixOptions,
              deliver: async (payload) => {
                const responseText = payload.text ?? "";
                if (responseText.trim()) {
                  await reply(responseText);
                }
              },
              onError: (err, info) => {
                ctx.log?.error?.(`[${account.accountId}] NIP-17 reply failed: ${String(err)}`);
              },
            },
          });
        },
        onError: (error, context) => {
          ctx.log?.error?.(`[${account.accountId}] NIP-17 error (${context}): ${error.message}`);
        },
        onConnect: (relay) => {
          ctx.log?.debug?.(`[${account.accountId}] Connected to relay: ${relay}`);
        },
        onDisconnect: (relay) => {
          ctx.log?.debug?.(`[${account.accountId}] Disconnected from relay: ${relay}`);
        },
        onEose: (relays) => {
          ctx.log?.debug?.(`[${account.accountId}] EOSE from: ${relays}`);
        },
      });

      activeBuses.set(account.accountId, bus);
      ctx.log?.info(`[${account.accountId}] NIP-17 provider started on ${account.relays.length} relay(s)`);

      return {
        stop: () => {
          bus.close();
          activeBuses.delete(account.accountId);
          ctx.log?.info(`[${account.accountId}] NIP-17 provider stopped`);
        },
      };
    },
  },
};
