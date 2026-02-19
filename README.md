# Nostr NIP-17 — OpenClaw Channel Plugin

Private DMs for [OpenClaw](https://github.com/openclaw/openclaw) via [Nostr](https://nostr.com) using [NIP-17](https://github.com/nostr-protocol/nips/blob/master/17.md) gift-wrapped encryption.

![Screenshot](https://nostur.com/screenshots/screenshot-openclaw-nostr.png "Screenshot")


## Features

- **NIP-17 gift-wrapped DMs** — end-to-end encrypted direct messages
- **Multi-account support** — run multiple npubs, each bound to a different agent
- **Relay dedup** — content-fingerprint dedup that persists across restarts
- **Auto-reconnect** — stays connected to relays via long-lived subscriptions

## Install

```bash
# Clone
git clone https://github.com/fabianfabian/nostr-nip17.git

# Install dependencies
cd nostr-nip17
npm install

# Link into OpenClaw
openclaw plugins install -l /path/to/nostr-nip17
```

Then restart the gateway:

```bash
openclaw gateway restart
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

Each account gets its own keypair and can be bound to a different agent:

```json
{
  "channels": {
    "nostr-nip17": {
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

Account-level settings override the base config. `relays`, `allowFrom`, and `dmPolicy` are inherited from the top level unless explicitly set per account.

### Config options

| Option | Type | Default | Description |
|--------|------|---------|-------------|
| `privateKey` | string | — | Nostr private key (nsec or hex) |
| `relays` | string[] | `["wss://relay.damus.io", "wss://nos.lol"]` | Relay URLs |
| `dmPolicy` | string | `"pairing"` | `"pairing"`, `"allowlist"`, `"open"`, or `"disabled"` |
| `allowFrom` | string[] | `[]` | Allowed sender pubkeys (hex or npub) |
| `name` | string | — | Display name for the account |
| `enabled` | boolean | `true` | Enable/disable the account |

## DM Policy

- **pairing** (default) — new senders must be approved via `openclaw channels approve`
- **allowlist** — only pubkeys in `allowFrom` can message
- **open** — anyone can message (use with caution)
- **disabled** — no inbound messages

## Requirements

- [OpenClaw](https://github.com/openclaw/openclaw) 2026.1.x or later
- Node.js 20+

## License

MIT
