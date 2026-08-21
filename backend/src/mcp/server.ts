import 'dotenv/config';
/**
 * Hand of Midas MCP connector (stdio).
 *
 *   npm run mcp --workspace=backend
 *
 * Exposes the engine's market intelligence and its order path as MCP tools, so a
 * client — Claude, or a trading bot — can read signals and act on them through
 * the same code the web UI uses.
 *
 * SAFETY: the execution tools get no privileged path. They call the same
 * services/execution spine as everything else, so the kill switch, the
 * idempotency claim and the mandatory signal provenance all still apply. LIVE
 * additionally requires TRADING_ENABLED on the server AND a stored account
 * opt-in; without both, an order is refused rather than silently downgraded, so
 * a client can never quietly believe it traded live when it did not.
 *
 * stdout is the MCP transport. Anything written there that is not a protocol
 * frame corrupts the session, so ALL logging goes to stderr.
 */
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from '@modelcontextprotocol/sdk/types.js';
import { z } from 'zod';
import { TOOLS, MCP_PRINCIPAL } from './tools.js';

/** Minimal Zod -> JSON Schema for the shapes these tools use. */
function toJsonSchema(shape: z.ZodRawShape): Record<string, unknown> {
  const properties: Record<string, unknown> = {};
  const required: string[] = [];

  for (const [key, raw] of Object.entries(shape)) {
    let node: any = raw;
    let optional = false;
    let description: string | undefined;

    // Unwrap optional/default/describe layers to reach the core type.
    for (let i = 0; i < 6; i++) {
      const def = node?._def ?? {};
      description ??= def.description;
      const name = def.typeName ?? node?.constructor?.name;
      if (name === 'ZodOptional' || name === 'ZodDefault' || def.innerType) {
        optional = true;
        node = def.innerType ?? node._def?.innerType ?? node;
        if (!node?._def) break;
        continue;
      }
      break;
    }

    const def = node?._def ?? {};
    const typeName: string = def.typeName ?? '';
    let schema: Record<string, unknown>;

    if (def.values || typeName === 'ZodEnum') {
      schema = { type: 'string', enum: def.values ?? def.options };
    } else if (typeName.includes('Number')) {
      schema = { type: 'number' };
    } else if (typeName.includes('Object')) {
      schema = { type: 'object' };
    } else if (typeName.includes('Boolean')) {
      schema = { type: 'boolean' };
    } else {
      schema = { type: 'string' };
    }
    if (description) schema['description'] = description;

    properties[key] = schema;
    if (!optional) required.push(key);
  }

  return { type: 'object', properties, ...(required.length ? { required } : {}) };
}

async function main() {
  const server = new Server(
    { name: 'hand-of-midas', version: '1.0.0' },
    { capabilities: { tools: {} } },
  );

  server.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: TOOLS.map(t => ({
      name: t.name,
      title: t.title,
      description: t.description,
      inputSchema: toJsonSchema(t.inputSchema),
      annotations: {
        readOnlyHint: !t.mutating,
        // Orders move money and cannot be undone by calling again.
        destructiveHint: Boolean(t.mutating),
        idempotentHint: t.name === 'place_order', // guaranteed by idempotencyKey
      },
    })),
  }));

  server.setRequestHandler(CallToolRequestSchema, async request => {
    const tool = TOOLS.find(t => t.name === request.params.name);
    if (!tool) {
      return { isError: true, content: [{ type: 'text', text: `Unknown tool: ${request.params.name}` }] };
    }
    try {
      const parsed = z.object(tool.inputSchema).parse(request.params.arguments ?? {});
      const result = await tool.handler(parsed);
      return { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }] };
    } catch (err) {
      // Returned as an error result rather than thrown: the client should see
      // WHY an order was refused — a kill-switch refusal is information, not a
      // transport failure.
      const message = err instanceof Error ? err.message : String(err);
      return { isError: true, content: [{ type: 'text', text: message }] };
    }
  });

  await server.connect(new StdioServerTransport());
  console.error(
    `[MCP] hand-of-midas ready — ${TOOLS.length} tools, principal ${MCP_PRINCIPAL}, ` +
      `live trading ${process.env['TRADING_ENABLED'] === 'true' ? 'ENABLED on server' : 'disabled'}`,
  );
}

main().catch(err => {
  console.error('[MCP] fatal:', err);
  process.exit(1);
});
