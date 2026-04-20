# Nostr NIP-17 — OpenClaw Channel Plugin

Private DMs for [OpenClaw](https://github.com/openclaw/openclaw) via [Nostr](https://nostr.com) using [NIP-17](https://github.com/nostr-protocol/nips/blob/master/17.md) gift-wrapped encryption.

![Screenshot](https://nostur.com/screenshots/screenshot-openclaw-nostr.png "Screenshot")


## Features

- **NIP-17 gift-wrapped DMs** — end-to-end encrypted direct messages
- **Multi-account support** — run multiple npubs, each bound to a different agent
- **Auto-reconnect** — stays connected to relays via long-lived subscriptions

## Install

```bash
# Clone the repo
git clone https://github.com/fabianfabian/openclaw-nostr-nip17.git nostr-nip17

# Install dependencies
cd nostr-nip17
npm install

# Link into OpenClaw
openclaw plugins install -l /path/to/nostr-nip17
```

Then restart OpenClaw:

```bash
openclaw gateway restart
```

Verify the plugin is visible:

```bash
openclaw plugins list
openclaw channels status
```

## Configuration

Add to your `openclaw.json`:

### Single account

```json
{
  "channels": {
    "nostr-nip17": {
      "privateKey": "nsec1...",
      "relays": [
        "wss://relay.damus.io",
        "wss://nos.lol",
        "wss://relay.primal.net"
      ],
      "dmPolicy": "pairing",
      "allowFrom": []
    }
  },
  "plugins": {
    "entries": {
      "nostr-nip17": {
        "enabled": true
      }
    }
  }
}
```

### Multiple accounts

Top-level settings act as the base config. If you set a top-level `privateKey`,
that becomes the `default` Nostr account. Named accounts under `accounts` inherit
the top-level `relays`, `dmPolicy`, and `allowFrom` unless they override them.

Each account gets its own keypair and can be bound to a different agent:

```json
{
  "channels": {
    "nostr-nip17": {
      "privateKey": "nsec1...", 
      "relays": ["wss://relay.damus.io", "wss://nos.lol"],
      "dmPolicy": "pairing",
      "accounts": {
        "second-agent": {
          "privateKey": "nsec1...",
          "name": "My Other Agent"
        }
      }
    }
  },
  "bindings": [
    {
      "match": { "channel": "nostr-nip17", "accountId": "second-agent" },
      "agentId": "my-other-agent"
    }
  ]
}
```

In that example:

- the top-level `privateKey` is the `default` Nostr account
- `second-agent` is a separate Nostr identity
- inbound DMs to account `second-agent` are routed to OpenClaw agent `my-other-agent`
- if you do not add a binding, messages fall back to the default/main routing path

You can also override the `default` account explicitly:

```json
{
  "channels": {
    "nostr-nip17": {
      "privateKey": "nsec1...",
      "relays": ["wss://relay.damus.io", "wss://nos.lol"],
      "accounts": {
        "default": {
          "name": "Main agent on Nostr",
          "dmPolicy": "allowlist",
          "allowFrom": ["npub1..."]
        },
        "codex": {
          "privateKey": "nsec1...",
          "name": "Min Jopus"
        }
      }
    }
  },
  "bindings": [
    {
      "match": { "channel": "nostr-nip17", "accountId": "codex" },
      "agentId": "codex"
    }
  ]
}
```

Account-level settings override the base config. `relays` and `allowFrom` are inherited from the top level unless explicitly set per account.

Each agent npub should have their DM relay list published (kind 10050), it also helps if the profile is already published (kind 0). This extension does not automatically do this.

### Config options

| Option | Type | Default | Scope | Description |
|--------|------|---------|-------|-------------|
| `privateKey` | string | — | top-level or account | Nostr private key in `nsec` or 64-char hex format |
| `relays` | string[] | `["wss://relay.damus.io", "wss://nos.lol"]` | top-level or account | Relay URLs used for inbox/outbox |
| `dmPolicy` | string | framework default | top-level or account | `"pairing"`, `"allowlist"`, `"open"`, or `"disabled"` |
| `allowFrom` | array<string \| number> | `[]` | top-level or account | Allowed sender pubkeys for allowlist/pairing flows |
| `name` | string | — | account | Display name for the account |
| `enabled` | boolean | `true` | account | Enable or disable that account |
| `accounts` | object | — | top-level | Named account overrides keyed by account id |

Minimal install checklist:

1. Install and link the plugin.
2. Add `channels.nostr-nip17` with at least one `privateKey`.
3. Add a `bindings` entry for any non-default account that should route to a specific agent.
4. Restart OpenClaw.
5. Publish a kind `10050` DM relay list for each Nostr identity you expect to receive replies on.

## DM Policy

- **pairing** — new senders must be approved via `openclaw pairing list` and `openclaw pairing approve`
- **allowlist** — only pubkeys in `allowFrom` can message
- **open** — anyone can message (use with caution)
- **disabled** — no inbound messages

## Requirements

- [OpenClaw](https://github.com/openclaw/openclaw) 2026.1.x or later
- Node.js 20+

## License

MIT
