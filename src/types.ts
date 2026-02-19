import type { OpenClawConfig } from "openclaw/plugin-sdk";
import type { Nip17AccountConfig, Nip17Config } from "./config-schema.js";
import { getPublicKeyFromPrivate, DEFAULT_RELAYS } from "./nip17-bus.js";

export interface ResolvedNip17Account {
  accountId: string;
  name?: string;
  enabled: boolean;
  configured: boolean;
  privateKey: string;
  publicKey: string;
  relays: string[];
  config: Nip17AccountConfig;
}

const DEFAULT_ACCOUNT_ID = "default";

function getNip17ChannelConfig(cfg: OpenClawConfig): Nip17Config | undefined {
  return (cfg.channels as Record<string, unknown> | undefined)?.["nostr-nip17"] as
    | Nip17Config | undefined;
}

export function listNip17AccountIds(cfg: OpenClawConfig): string[] {
  const nip17Cfg = getNip17ChannelConfig(cfg);
  if (!nip17Cfg) return [];

  const accounts = nip17Cfg.accounts;
  if (accounts && typeof accounts === "object") {
    const ids = Object.keys(accounts).filter(Boolean);
    if (ids.length > 0) {
      // Also include "default" if top-level privateKey is set and "default" isn't explicitly in accounts
      if (nip17Cfg.privateKey && !ids.includes(DEFAULT_ACCOUNT_ID)) {
        return [DEFAULT_ACCOUNT_ID, ...ids].sort((a, b) => a.localeCompare(b));
      }
      return ids.sort((a, b) => a.localeCompare(b));
    }
  }

  // Fallback: single-account mode (top-level privateKey)
  if (nip17Cfg.privateKey) return [DEFAULT_ACCOUNT_ID];
  return [];
}

export function resolveDefaultNip17AccountId(cfg: OpenClawConfig): string {
  const ids = listNip17AccountIds(cfg);
  if (ids.includes(DEFAULT_ACCOUNT_ID)) return DEFAULT_ACCOUNT_ID;
  return ids[0] ?? DEFAULT_ACCOUNT_ID;
}

/**
 * Merge base (top-level) config with per-account overrides.
 * Account-level values take precedence over base values.
 */
function mergeAccountConfig(base: Nip17Config, accountOverride: Nip17AccountConfig | undefined): Nip17AccountConfig {
  if (!accountOverride) return base;
  return {
    ...base,
    ...accountOverride,
    // Only override arrays if explicitly set in account config
    relays: accountOverride.relays ?? base.relays,
    allowFrom: accountOverride.allowFrom ?? base.allowFrom,
  };
}

export function resolveNip17Account(opts: {
  cfg: OpenClawConfig;
  accountId?: string | null;
}): ResolvedNip17Account {
  const accountId = opts.accountId ?? DEFAULT_ACCOUNT_ID;
  const nip17Cfg = getNip17ChannelConfig(opts.cfg);

  // Get account-specific override if it exists
  const accountOverride = (accountId !== DEFAULT_ACCOUNT_ID || nip17Cfg?.accounts?.[DEFAULT_ACCOUNT_ID])
    ? nip17Cfg?.accounts?.[accountId]
    : undefined;

  // Merge base config with account override
  const { accounts: _ignored, ...baseConfig } = nip17Cfg ?? {};
  const merged = mergeAccountConfig(baseConfig as Nip17AccountConfig, accountOverride);

  const enabled = merged.enabled !== false;
  const privateKey = merged.privateKey ?? "";
  const configured = Boolean(privateKey.trim());

  let publicKey = "";
  if (configured) {
    try { publicKey = getPublicKeyFromPrivate(privateKey); } catch {}
  }

  return {
    accountId,
    name: merged.name?.trim() || undefined,
    enabled,
    configured,
    privateKey,
    publicKey,
    relays: merged.relays ?? DEFAULT_RELAYS,
    config: {
      enabled: merged.enabled,
      name: merged.name,
      privateKey: merged.privateKey,
      relays: merged.relays,
      dmPolicy: merged.dmPolicy,
      allowFrom: merged.allowFrom,
    },
  };
}
