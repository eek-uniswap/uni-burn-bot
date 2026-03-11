# uni-burn-bot

TypeScript Slack bot that monitors Ethereum/Unichain for UNI token burns and sends rich Slack alerts.

## Architecture

```
Ethereum RPC → EthereumMonitor → bot.ts (30s loop) → SQLite DB → SlackService → Slack
```

## Key Files

| File | Purpose |
|------|---------|
| `src/bot.ts` | Main entry point, polling loop, orchestration |
| `src/ethereumMonitor.ts` | Web3.js v4, scans blocks for ERC-20 Transfer events |
| `src/database.ts` | SQLite persistence, migrations, analytics (7d MA, burner stats) |
| `src/slackService.ts` | Slack Block Kit formatting, ASCII chart for 7d MA trend |
| `src/types.ts` | `TokenTransfer` and `Config` interfaces |
| `src/viewHistory.ts` | CLI utility to inspect stored transactions |

## What It Monitors

- ERC-20 Transfer events to `RECIPIENT_ADDRESS` (burn address)
- Mainnet burns: 4k UNI; Unichain burns: 2k UNI (via `ADDITIONAL_AMOUNTS`)
- Historical backfill from Dec 27, 2025 on first run

## Database

- SQLite via `better-sqlite3`, file: `transactions.db`
- Schema version: v2 (migration: renamed `initiator_address` → `burner_address`)
- Key table: `token_transfers` — unique on `tx_hash`

## Environment Variables

**Required:**
- `ETHEREUM_RPC_URL` — RPC endpoint (Infura, Alchemy, etc.)
- `TOKEN_ADDRESS` — ERC-20 contract to monitor
- `RECIPIENT_ADDRESS` — Burn address to filter transfers to
- `AMOUNT` — Target transfer amount (smallest unit, e.g. wei)
- `SLACK_BOT_TOKEN` — Slack bot token (`xoxb-...`)
- `SLACK_CHANNEL` — Channel for alerts (e.g. `#burns`)

**Optional:**
- `ADDITIONAL_AMOUNTS` — Comma-separated extra amounts to monitor
- `TOKEN_DECIMALS` — Default: `18`
- `POLL_INTERVAL` — Polling frequency in seconds, default: `30`

## npm Scripts

```bash
npm run dev       # Run with ts-node (development)
npm start         # Run compiled dist/
npm test          # Jest test suite
npm run build     # Compile TypeScript → dist/
npm run view-history  # CLI: print stored transactions
```

## Notes
