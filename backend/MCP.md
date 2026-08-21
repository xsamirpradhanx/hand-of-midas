# Hand of Midas MCP connector

Exposes the engine's market intelligence and its order path as MCP tools, so a
client — Claude, or a trading bot — can read signals and act on them through the
same code the web UI uses.

```bash
npm run mcp --workspace=backend
```

## Connecting from Claude Code

```json
{
  "mcpServers": {
    "hand-of-midas": {
      "command": "npx",
      "args": ["tsx", "src/mcp/server.ts"],
      "cwd": "/Users/sammy/Git/handofmidas/backend"
    }
  }
}
```

`cwd` matters: `.env` is loaded relative to it, so Schwab credentials and the
DynamoDB table name resolve only when the server starts inside `backend/`.

## Tools

| Tool | Mutating | What it does |
|---|---|---|
| `get_trade_plan` | no | Full engine output for a symbol: bias, conviction, zones, geometry, every factor vote |
| `run_screener` | no | Scan for setups — `premarket` / `open` / `momentum` / `highdemand` |
| `get_factor_performance` | no | Graded accuracy per factor, on each factor's own directional vote |
| `get_setup_performance` | no | Win rate and modelled R by setup |
| `get_broker_status` | no | Connection state, grant expiry, whether trading is permitted |
| `place_order` | **yes** | Submit an order. PAPER by default |
| `list_orders` | no | Orders with fills and the signal behind each |
| `reconcile_order` | **yes** | Re-read one order from the broker and adopt its view |

## Safety

The execution tools get no privileged path. They call the same
`services/execution` spine as every other caller, so all of it still applies:

- **PAPER is the default.** LIVE additionally requires `TRADING_ENABLED=true` on
  the server AND a stored account opt-in. Without both, an order is **refused**
  rather than silently downgraded — a client can never believe it traded live
  when it did not.
- **Provenance is mandatory.** `place_order` requires the prediction identifiers,
  plan geometry, conviction and engine version behind the trade. Call
  `get_trade_plan` first and pass its identifiers through.
- **Idempotency.** Reusing an `idempotencyKey` returns the original order. This
  is what stops a retrying client from double-filling.
- **The halt is sticky.** If reconciliation finds a divergence it cannot explain,
  trading stops — including PAPER — until a human clears it.

### Two things not to misread

`conviction` is an **evidence-strength score** in [0.05, 0.95], not a win
probability. Do not present it as one.

Paper fills have **no slippage, partial-fill or queue model**. They are an
optimistic bound and must never be quoted as expected live performance.
