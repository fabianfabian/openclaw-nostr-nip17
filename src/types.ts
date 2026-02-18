import type { OpenClawConfig } from "openclaw/plugin-sdk";
import type { Nip17Config } from "./config-schema.js";
import { getPublicKeyFromPrivate, DEFAULT_RELAYS } from "./nip17-bus.js";

export interface ResolvedNip17Account {
  accountId: string;
  name?: string;
  enabled: boolean;
  configured: boolean;
  privateKey: string;
  publicKey: string;
  relays: string[];
  config: Nip17Config;
}

const DEFAULT_ACCOUNT_ID = "default";

export function listNip17AccountIds(cfg: OpenClawConfig): string[] {
  const nip17Cfg = (cfg.channels as Record<string, unknown> | undefined)?.["nostr-nip17"] as
    | Nip17Config | undefined;
  if (nip17Cfg?.privateKey) return [DEFAULT_ACCOUNT_ID];
  return [];
}

export function resolveDefaultNip17AccountId(cfg: OpenClawConfig): string {
  const ids = listNip17AccountIds(cfg);
  return ids.includes(DEFAULT_ACCOUNT_ID) ? DEFAULT_ACCOUNT_ID : (ids[0] ?? DEFAULT_ACCOUNT_ID);
}

export function resolveNip17Account(opts: {
  cfg: OpenClawConfig;
  accountId?: string | null;
}): ResolvedNip17Account {
  const accountId = opts.accountId ?? DEFAULT_ACCOUNT_ID;
  const nip17Cfg = (opts.cfg.channels as Record<string, unknown> | undefined)?.["nostr-nip17"] as
    | Nip17Config | undefined;

  const enabled = nip17Cfg?.enabled !== false;
  const privateKey = nip17Cfg?.privateKey ?? "";
  const configured = Boolean(privateKey.trim());

  let publicKey = "";
  if (configured) {
    try { publicKey = getPublicKeyFromPrivate(privateKey); } catch {}
  }

  return {
    accountId,
    name: nip17Cfg?.name?.trim() || undefined,
    enabled,
    configured,
    privateKey,
    publicKey,
    relays: nip17Cfg?.relays ?? DEFAULT_RELAYS,
    config: {
      enabled: nip17Cfg?.enabled,
      name: nip17Cfg?.name,
      privateKey: nip17Cfg?.privateKey,
      relays: nip17Cfg?.relays,
      dmPolicy: nip17Cfg?.dmPolicy,
      allowFrom: nip17Cfg?.allowFrom,
    },
  };
}
