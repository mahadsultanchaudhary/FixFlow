import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client';
import { isRecord, type JsonRecord } from './types';

type TextBlock = { type?: string; text?: string };
type CallResult = {
  isError?: boolean;
  content?: TextBlock[];
  structuredContent?: unknown;
};

export interface McpConnectionInfo {
  tools: string[];
  endpoint: string;
}

function endpointUrl(): string {
  const configured = import.meta.env.VITE_MCP_URL?.trim();
  if (configured) return configured;
  const host = typeof window !== 'undefined' ? window.location.hostname : '127.0.0.1';
  return `http://${host || '127.0.0.1'}:8000/mcp`;
}

function contentAsValue(result: CallResult): unknown {
  if (result.structuredContent !== undefined && result.structuredContent !== null) {
    return result.structuredContent;
  }
  for (const block of result.content ?? []) {
    if (block.type !== 'text' || typeof block.text !== 'string') continue;
    try {
      return JSON.parse(block.text) as unknown;
    } catch {
      return block.text;
    }
  }
  return undefined;
}

export function unwrapToolEnvelope(value: unknown): unknown {
  // MCP transports can carry structured content while the application itself
  // wraps values in {ok,data}. Unwrap explicit envelopes recursively, never
  // dropping a legitimate business field merely named `data`.
  let current = value;
  for (let depth = 0; depth < 5; depth += 1) {
    if (!isRecord(current)) return current;
    if (current.ok === false) {
      const message = typeof current.error === 'string' ? current.error : 'The repair operation was rejected.';
      throw new Error(message);
    }
    if (current.ok === true && Object.prototype.hasOwnProperty.call(current, 'data')) {
      current = current.data;
      continue;
    }
    if (isRecord(current.result) && (
      current.result.ok === false
      || (current.result.ok === true && Object.prototype.hasOwnProperty.call(current.result, 'data'))
    )) {
      current = current.result;
      continue;
    }
    return current;
  }
  return current;
}

/**
 * Browser client for the official MCP TypeScript SDK.
 * The SDK owns initialize/initialized, Streamable HTTP framing, session IDs,
 * protocol-version headers, JSON-RPC errors and transport response parsing.
 */
export class FixFlowMcpClient {
  private client: Client | undefined;
  private transport: StreamableHTTPClientTransport | undefined;
  private connectionPromise: Promise<McpConnectionInfo> | undefined;
  private discoveredTools: string[] = [];
  private readonly endpoint = endpointUrl();

  async connect(): Promise<McpConnectionInfo> {
    if (this.client) {
      return { tools: [...this.discoveredTools], endpoint: this.endpoint };
    }
    if (this.connectionPromise) return this.connectionPromise;

    this.connectionPromise = (async () => {
      const client = new Client({ name: 'fixflow-browser', version: '1.0.0' });
      const transport = new StreamableHTTPClientTransport(new URL(this.endpoint));
      try {
        await client.connect(transport);
        const { tools } = await client.listTools();
        this.client = client;
        this.transport = transport;
        this.discoveredTools = tools.map((tool) => tool.name);
        return { tools: [...this.discoveredTools], endpoint: this.endpoint };
      } catch (error) {
        try {
          await client.close();
        } catch {
          // Preserve the original connection error.
        }
        throw error;
      }
    })();

    try {
      return await this.connectionPromise;
    } finally {
      this.connectionPromise = undefined;
    }
  }

  get toolNames(): string[] {
    return [...this.discoveredTools];
  }

  async call<T = unknown>(name: string, args: JsonRecord = {}): Promise<T> {
    // Prevent a missing/blank approval ID from ever reaching the MCP transport.
    // The server independently enforces the same repair-scoped approval.
    if (['approve_action', 'reject_action', 'book_appointment'].includes(name)) {
      const approvalId = args.approval_id;
      if (typeof approvalId !== 'string' || !approvalId.trim()) {
        throw new Error(`Refusing to call ${name}: a persisted approval_id is required. Refresh or select a proposal first.`);
      }
      const incidentId = args.incident_id;
      if (typeof incidentId !== 'string' || !incidentId.trim()) {
        throw new Error(`Refusing to call ${name}: a repair incident_id is required.`);
      }
    }
    if (!this.client) await this.connect();
    if (!this.client) throw new Error('The MCP client did not connect.');
    if (!this.discoveredTools.includes(name)) {
      throw new Error(`The MCP server did not advertise the required tool: ${name}`);
    }
    const result = await this.client.callTool({ name, arguments: args }) as CallResult;
    const value = contentAsValue(result);
    if (result.isError) {
      if (isRecord(value) && typeof value.error === 'string') throw new Error(value.error);
      if (typeof value === 'string') throw new Error(value);
      throw new Error(`The MCP tool '${name}' returned an error.`);
    }
    return unwrapToolEnvelope(value) as T;
  }

  async disconnect(): Promise<void> {
    const transport = this.transport;
    const client = this.client;
    this.transport = undefined;
    this.client = undefined;
    this.discoveredTools = [];
    if (transport) {
      try {
        await transport.terminateSession();
      } catch {
        // Session termination is best-effort during local shutdown.
      }
    }
    if (client) await client.close();
  }
}

export const fixflowMcp = new FixFlowMcpClient();
