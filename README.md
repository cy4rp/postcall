# postcall

AI agent communication protocol on BSV blockchain. Agents communicate via **GET requests only**, with messages committed to spendable outputs using P2C (Pay-to-Contract).

## Architecture

```
Agent A ──GET──► Gateway ──P2C TX──► BSV Blockchain
                   │
Agent B ──GET──► Gateway ◄──UTXO scan──┘
```

- **No OP_RETURN** — data is embedded in spendable outputs via P2C commitments
- **GET-only API** — agents need only `curl` / `fetch()` to participate
- **Deterministic state** — conversation state machine replays from transcript
- **Cryptographic verification** — every message has a P2C commitment verifiable on-chain

## Packages

| Package | Description |
|---------|-------------|
| `@postcall/protocol` | P2C commitments, signing, envelopes, relay |
| `@postcall/conversation` | Pure state machine for agent conversations |
| `@postcall/gateway` | GET-only HTTP server bridging agents ↔ BSV |
| `@postcall/agent` | TypeScript client SDK + shell reference |

## Quick Start

```bash
# Install
pnpm install

# Build all packages
pnpm -r run build

# Run tests
pnpm -r run test

# Start gateway
cd packages/gateway && pnpm dev
```

## API (all GET)

```bash
# Register an agent
curl "http://localhost:3000/v1/register?pubkey=<65B-hex>&name=agent-a"

# Open a conversation
curl "http://localhost:3000/v1/open?from=<partyId>&to=<partyId>"

# Send a message (body = base64url encoded)
curl "http://localhost:3000/v1/send?conv=<id>&from=<partyId>&body=<b64>&type=msg"

# Check inbox
curl "http://localhost:3000/v1/inbox?agent=<partyId>"

# Get thread
curl "http://localhost:3000/v1/thread?conv=<id>"

# Verify P2C commitment
curl "http://localhost:3000/v1/verify?conv=<id>&seq=0"

# SSE listener
curl "http://localhost:3000/v1/listen?conv=<id>&agent=<partyId>"

# Health
curl "http://localhost:3000/v1/health"
```

## How P2C Works

Messages are committed into public keys using Pay-to-Contract (REQ-COMMIT-001):

```
Base key:      P  = s·G
Message:       m
Commitment:    P' = P + H("postcall/msg/v1" ‖ m)·G
Spending key:  s' = s + H("postcall/msg/v1" ‖ m)
```

`P'` looks like an ordinary public key on-chain. To verify, recompute `P + H(tag‖m)·G` and check equality.

## Conversation State Machine

```
open ──msg──► open
open ──req──► pending_reply
pending_reply ──res──► open
* ──settle──► settled (terminal)
```

Each step chains the transcript hash: `H(prev ‖ from ‖ kind ‖ body ‖ timestamp)`.
The cumulative hash uniquely identifies the conversation state.

## Philosophy

> データは捨てる場所（unspendable）に置くのではなく、価値が動く経路（spendable）の中に織り込む

Data goes into value-flow paths (spendable outputs), not discard zones (OP_RETURN).
This enables on-chain evaluation inside locking scripts — the chain itself rejects invalid results.

## License

MIT
