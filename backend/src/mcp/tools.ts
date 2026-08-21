/**
 * Tool definitions for the Hand of Midas MCP connector.
 *
 * Split from the transport so the same tools can later be served over HTTP
 * without rewriting them, and so they are testable without a client attached.
 *
 * The intelligence tools are read-only and safe to call freely. The execution
 * tools route through the same safety spine as every other order path
 * (services/execution) — they get no privileged access and cannot bypass the
 * kill switch, the idempotency claim, or the provenance requirement. An MCP
 * client is just another caller.
 */
import { z } from 'zod';
import { getPredictiveZones } from '../services/predictiveEngine.js';
import { runScreener, type ScreenerMode } from '../services/screenerService.js';
import { getItem } from '../services/dynamodb.js';
import { schwabFor } from '../services/brokers/index.js';
import { checkTradingGate, getHalt } from '../services/execution/killSwitch.js';
import { placeOrder, reconcileOrder } from '../services/execution/orderService.js';
import { listOrders, getOrder } from '../services/execution/orderStore.js';
import { PaperExecutor } from '../services/execution/paperExecutor.js';
import type { OrderIntent } from '../services/execution/types.js';

/** Single-user project: everything runs as one principal. */
export const MCP_PRINCIPAL = process.env['MCP_PRINCIPAL'] ?? 'SYSTEM';

export interface ToolDef {
  name: string;
  title: string;
  description: string;
  inputSchema: z.ZodRawShape;
  /** true when the tool can change state — surfaced to the client as a hint. */
  mutating?: boolean;
  handler: (args: any) => Promise<unknown>;
}

const SYMBOL = z.string().min(1).max(12).describe('Ticker symbol, e.g. AAPL');

// ── intelligence ────────────────────────────────────────────────────────────

const tradePlan: ToolDef = {
  name: 'get_trade_plan',
  title: 'Get AI trade plan',
  description:
    'Full engine output for a symbol: bias, conviction, demand/supply zones, trigger/stop/targets, ' +
    'and every contributing factor with its vote. Conviction is an evidence-strength score in [0.05, 0.95], ' +
    'NOT a win probability — do not present it as one. Most symbols correctly resolve to NO TRADE. ' +
    'The `sizing` field is an ADVISORY size multiplier derived from each factor\'s measured historical ' +
    'accuracy; it is a separate signal from conviction and is deliberately not applied automatically.',
  inputSchema: { symbol: SYMBOL, expiry: z.string().optional().describe('Options expiry YYYY-MM-DD') },
  handler: async ({ symbol, expiry }) => {
    const r = await getPredictiveZones(String(symbol).toUpperCase(), expiry);
    const t: any = r.aiThesis;
    return {
      symbol: r.symbol,
      currentPrice: r.currentPrice,
      bias: t.bias,
      conviction: t.modelConviction,
      convictionNote: 'Evidence strength, not a win probability.',
      agreement: t.agreementLevel,
      tradePlan: t.tradePlan,
      // Advisory only — see the note on AISynthesisResult.sizing. Backtesting
      // says do not apply this automatically; it is here to be weighed.
      sizing: t.sizing ? { ...t.sizing, advisory: true } : undefined,
      zones: r.zones,
      factors: (t.factors ?? []).map((f: any) => ({
        name: f.factorName, bias: f.bias, weight: f.weight, reasoning: f.reasoning,
      })),
    };
  },
};

const screener: ToolDef = {
  name: 'run_screener',
  title: 'Run market screener',
  description:
    'Scan the market for setups. Modes: premarket, open, momentum (sub-$20), highdemand (sub-$20). ' +
    'Returns ranked candidates with setup type, scores and trade geometry.',
  inputSchema: {
    mode: z.enum(['premarket', 'open', 'momentum', 'highdemand']).default('open'),
    limit: z.number().int().min(1).max(50).default(15),
  },
  handler: async ({ mode, limit }) => {
    const results = await runScreener((mode ?? 'open') as ScreenerMode);
    return { mode: mode ?? 'open', count: results.length, results: results.slice(0, limit ?? 15) };
  },
};

const factorPerformance: ToolDef = {
  name: 'get_factor_performance',
  title: 'Get measured factor accuracy',
  description:
    'Graded accuracy per factor, scored on each factor\'s OWN directional vote against the realised move. ' +
    'Accuracy is over resolved votes; a high abstention rate means the factor rarely calls a direction ' +
    'rather than that it is wrong.',
  inputSchema: {},
  handler: async () => {
    const fs: any = await getItem('SYSTEM', 'FACTOR_STATS');
    const rows = Object.entries(fs?.stats ?? {}).map(([name, v]: [string, any]) => {
      const resolved = (v.wins ?? 0) + (v.losses ?? 0);
      const tries = v.tries ?? resolved;
      return {
        factor: name,
        resolvedVotes: resolved,
        accuracy: resolved >= 3 ? Number((v.wins / resolved).toFixed(3)) : null,
        abstentionRate: tries ? Number(((tries - resolved) / tries).toFixed(3)) : null,
      };
    }).sort((a, b) => b.resolvedVotes - a.resolvedVotes);
    return { factors: rows, note: 'Null accuracy means fewer than 3 directional votes.' };
  },
};

const setupPerformance: ToolDef = {
  name: 'get_setup_performance',
  title: 'Get measured setup expectancy',
  description:
    'Win rate and modelled R by setup and direction. R is MODELLED — a win is credited the full planned ' +
    'reward:risk and a loss debited exactly 1.0 — so it assumes perfect fills and is optimistic on ' +
    'illiquid names.',
  inputSchema: {},
  handler: async () => {
    const ss: any = await getItem('SYSTEM', 'SETUP_STATS');
    const rows = Object.entries(ss?.stats ?? {}).map(([k, v]: [string, any]) => ({
      setup: k, tries: v.tries, wins: v.wins, losses: v.losses, ambiguous: v.ambiguous,
      modelledR: Number((v.sumActualR ?? 0).toFixed(1)),
      expectancyR: v.tries ? Number(((v.sumActualR ?? 0) / v.tries).toFixed(3)) : null,
    })).sort((a, b) => b.tries - a.tries);
    return { setups: rows, note: 'Modelled R assumes perfect fills at target and stop.' };
  },
};

const brokerStatus: ToolDef = {
  name: 'get_broker_status',
  title: 'Get broker connection status',
  description: 'Whether the brokerage connection is live, when its grant expires, and whether trading is permitted.',
  inputSchema: {},
  handler: async () => {
    const conn = await schwabFor(MCP_PRINCIPAL).status();
    const halt = await getHalt(MCP_PRINCIPAL);
    const gate = await checkTradingGate(MCP_PRINCIPAL, 'LIVE', 0);
    return {
      broker: conn,
      halted: halt ? { reason: halt.reason, since: halt.haltedAt } : null,
      liveTradingAllowed: gate.allowed,
      liveTradingBlockedBecause: gate.allowed ? null : gate.reason,
    };
  },
};

// ── execution ───────────────────────────────────────────────────────────────

const executor = new PaperExecutor(() => {
  throw new Error('Paper executor needs a mark price; pass referencePrice explicitly.');
});

const placeOrderTool: ToolDef = {
  name: 'place_order',
  title: 'Place an order',
  description:
    'Submit an order. Defaults to PAPER; LIVE additionally requires TRADING_ENABLED on the server AND ' +
    'an account opt-in, and is refused otherwise. Every order MUST name the prediction that justified it — ' +
    'call get_trade_plan first and pass its identifiers. Reusing an idempotencyKey returns the original ' +
    'order rather than placing a second one.',
  mutating: true,
  inputSchema: {
    symbol: SYMBOL,
    side: z.enum(['BUY', 'SELL', 'BUY_TO_COVER', 'SELL_SHORT']),
    quantity: z.number().int().positive(),
    orderType: z.enum(['MARKET', 'LIMIT', 'STOP', 'STOP_LIMIT']).default('LIMIT'),
    limitPrice: z.number().positive().optional(),
    stopPrice: z.number().positive().optional(),
    referencePrice: z.number().positive().describe('Current price, used for the notional cap and paper fills'),
    mode: z.enum(['PAPER', 'LIVE']).default('PAPER'),
    idempotencyKey: z.string().min(8).describe('Unique per intent; reuse returns the original order'),
    signal: z.object({
      predictionPk: z.string(), predictionSk: z.string(),
      planBias: z.enum(['LONG', 'SHORT']),
      trigger: z.number(), stop: z.number(), target: z.number(),
      conviction: z.number(), engineVersion: z.string(), decidedAt: z.string(),
    }).describe('Provenance from get_trade_plan. Required — an order with no traceable cause is refused.'),
  },
  handler: async (a) => {
    const intent: OrderIntent = {
      symbol: String(a.symbol).toUpperCase(),
      side: a.side, quantity: a.quantity, orderType: a.orderType ?? 'LIMIT',
      limitPrice: a.limitPrice, stopPrice: a.stopPrice,
      signal: { ...a.signal, symbol: String(a.symbol).toUpperCase() },
    };
    const paper = new PaperExecutor(() => a.referencePrice);
    const order = await placeOrder({
      principal: MCP_PRINCIPAL, intent,
      idempotencyKey: a.idempotencyKey,
      requestedMode: a.mode ?? 'PAPER',
      executor: paper, referencePrice: a.referencePrice,
    });
    return {
      orderId: order.orderId, status: order.status, mode: order.mode,
      broker: order.broker, brokerOrderId: order.brokerOrderId,
      filledQuantity: order.filledQuantity, avgFillPrice: order.avgFillPrice,
      note: order.mode === 'PAPER'
        ? 'PAPER fill — no slippage, partial-fill or queue model. Optimistic; not live performance.'
        : 'LIVE order submitted.',
    };
  },
};

const listOrdersTool: ToolDef = {
  name: 'list_orders',
  title: 'List orders',
  description: 'Every order with its status, fills, and the signal that produced it.',
  inputSchema: { status: z.string().optional().describe('Filter by status, e.g. FILLED') },
  handler: async ({ status }) => {
    const all = await listOrders(MCP_PRINCIPAL);
    const rows = status ? all.filter(o => o.status === status) : all;
    return {
      count: rows.length,
      orders: rows.map(o => ({
        orderId: o.orderId, symbol: o.symbol, side: o.side, quantity: o.quantity,
        status: o.status, mode: o.mode, filledQuantity: o.filledQuantity,
        avgFillPrice: o.avgFillPrice, createdAt: o.createdAt,
        signal: { predictionSk: o.signal.predictionSk, conviction: o.signal.conviction, engineVersion: o.signal.engineVersion },
        events: o.events.length,
      })),
    };
  },
};

const reconcileTool: ToolDef = {
  name: 'reconcile_order',
  title: 'Reconcile an order against the broker',
  description:
    'Re-read one order from the broker and adopt its view. The broker is authoritative. ' +
    'If the two disagree in a way that cannot be explained, trading halts until a human clears it.',
  mutating: true,
  inputSchema: { orderId: z.string(), referencePrice: z.number().positive() },
  handler: async ({ orderId, referencePrice }) => {
    const existing = await getOrder(MCP_PRINCIPAL, orderId);
    if (!existing) return { error: `Order ${orderId} not found.` };
    const paper = new PaperExecutor(() => referencePrice);
    return reconcileOrder(MCP_PRINCIPAL, orderId, paper);
  },
};

export const TOOLS: ToolDef[] = [
  tradePlan, screener, factorPerformance, setupPerformance, brokerStatus,
  placeOrderTool, listOrdersTool, reconcileTool,
];

export const READ_ONLY_TOOLS = TOOLS.filter(t => !t.mutating).map(t => t.name);
