import { io, type Socket } from "socket.io-client";
import type { AgentConfig } from "./config.js";
import type { EndpointConfig } from "./local-client.js";
import type { Resource, Tool } from "@modelcontextprotocol/sdk/types.js";
import { AGENT_VERSION } from "./version.js";

// ── Tunnel protocol types ────────────────────────────────────────────────

export interface ToolCallPayload {
  callId: string;
  endpointId: string;
  toolName: string;
  args: Record<string, unknown>;
}

export interface ResourceReadPayload {
  callId: string;
  endpointId: string;
  uri: string;
}

export interface TunnelCallbacks {
  onEndpoints: (endpoints: EndpointConfig[]) => void;
  onEndpointAdd: (endpoint: EndpointConfig) => void;
  onEndpointRemove: (endpointId: string) => void;
  onEndpointToggle: (endpointId: string, isEnabled: boolean) => void;
  onEndpointUpdate: (endpoint: EndpointConfig) => void;
  onEndpointRefresh: (endpointId: string) => void;
  onToolCall: (payload: ToolCallPayload) => void;
  onResourceRead: (payload: ResourceReadPayload) => void;
}

// ── AgentTunnel ──────────────────────────────────────────────────────────

/**
 * Socket.IO client for the MCP-Central /tunnel namespace.
 *
 * Wire contract (mirrors the firmware `mcp_tunnel_client` C component, kept
 * as the canonical reference implementation):
 *
 *   Outgoing (agent → Central):
 *     join                  — first event after connect; registers the socket
 *     toolsAnnounce         — { endpointId, tools: McpToolDefinition[] }
 *     toolResult            — { callId, result?, error? }
 *     statusUpdate          — { endpointId, status, error? }
 *     resourcesAnnounce     — { endpointId, resources: Resource[] }
 *     resourceUpdated       — { endpointId, uri }
 *     resourceListChanged   — { endpointId }
 *     resourceResult        — { callId, result?: { contents: [...] }, error? }
 *
 *   Incoming (Central → agent), all prefixed `tunnel:`:
 *     tunnel:endpoints / tunnel:endpoint_{add,update,remove,toggle,refresh}
 *     tunnel:tool_call      — { callId, endpointId, toolName, args }
 *     tunnel:resource_read  — { callId, endpointId, uri }
 */
export class AgentTunnel {
  private _socket: Socket | null = null;
  private readonly _config: AgentConfig;
  private readonly _callbacks: TunnelCallbacks;

  constructor(config: AgentConfig, callbacks: TunnelCallbacks) {
    this._config = config;
    this._callbacks = callbacks;
  }

  /** Connect to the /tunnel namespace with the tunnel API key. */
  connect(): void {
    const url = this._config.serverUrl.replace(/\/$/, "");

    this._socket = io(`${url}/tunnel`, {
      auth: { apiKey: this._config.apiKey, version: AGENT_VERSION },
      transports: ["websocket"],
      reconnection: true,
      reconnectionDelay: 1_000,
      reconnectionDelayMax: 30_000,
      reconnectionAttempts: Infinity,
    });

    this._socket.on("connect", () => {
      console.log(`[AgentTunnel] Connected to ${url}/tunnel`);
      // Emit `join` so TunnelTransportService registers the socket and
      // pushes the endpoint list. IOServer wires public service methods as
      // socket.on(method) handlers; this first event is the entry point.
      this._socket?.emit("join", {}, (ack: unknown) => {
        if (
          ack &&
          typeof ack === "object" &&
          (ack as { status?: string }).status === "error"
        ) {
          console.error(`[AgentTunnel] join rejected:`, ack);
        }
      });
    });

    this._socket.on("disconnect", (reason) => {
      console.warn(`[AgentTunnel] Disconnected: ${reason}`);
    });

    this._socket.on("connect_error", (err) => {
      console.error(`[AgentTunnel] Connection error: ${err.message}`);
    });

    // ── Server → Agent events (tunnel:* prefix) ─────────────────────────

    this._socket.on("tunnel:endpoints", (endpoints: EndpointConfig[]) => {
      console.log(`[AgentTunnel] Received ${endpoints.length} endpoints`);
      this._callbacks.onEndpoints(endpoints);
    });

    this._socket.on(
      "tunnel:endpoint_add",
      ({ endpoint }: { endpoint: EndpointConfig }) => {
        console.log(`[AgentTunnel] Endpoint added: ${endpoint.name}`);
        this._callbacks.onEndpointAdd(endpoint);
      },
    );

    this._socket.on(
      "tunnel:endpoint_remove",
      (payload: { endpointId: string }) => {
        console.log(`[AgentTunnel] Endpoint removed: ${payload.endpointId}`);
        this._callbacks.onEndpointRemove(payload.endpointId);
      },
    );

    this._socket.on(
      "tunnel:endpoint_toggle",
      (payload: { endpointId: string; isEnabled: boolean }) => {
        this._callbacks.onEndpointToggle(payload.endpointId, payload.isEnabled);
      },
    );

    this._socket.on(
      "tunnel:endpoint_update",
      ({ endpoint }: { endpoint: EndpointConfig }) => {
        console.log(`[AgentTunnel] Endpoint updated: ${endpoint.name}`);
        this._callbacks.onEndpointUpdate(endpoint);
      },
    );

    this._socket.on(
      "tunnel:endpoint_refresh",
      (payload: { endpointId: string }) => {
        console.log(`[AgentTunnel] Endpoint refresh: ${payload.endpointId}`);
        this._callbacks.onEndpointRefresh(payload.endpointId);
      },
    );

    this._socket.on("tunnel:tool_call", (payload: ToolCallPayload) => {
      this._callbacks.onToolCall(payload);
    });

    this._socket.on("tunnel:resource_read", (payload: ResourceReadPayload) => {
      this._callbacks.onResourceRead(payload);
    });
  }

  disconnect(): void {
    this._socket?.disconnect();
    this._socket = null;
  }

  // ── Agent → Server events ──────────────────────────────────────────────

  /** Announce the list of tools available for an endpoint. */
  announceTools(endpointId: string, tools: Tool[]): void {
    this._socket?.emit("toolsAnnounce", {
      endpointId,
      tools: tools.map((t) => ({
        name: t.name,
        description: t.description,
        inputSchema: t.inputSchema,
      })),
    });
  }

  /** Send the result of a tool call back to the server. */
  sendToolResult(callId: string, result: unknown): void {
    this._socket?.emit("toolResult", { callId, result });
  }

  /** Send a tool call error back to the server. */
  sendToolError(callId: string, error: string): void {
    this._socket?.emit("toolResult", { callId, error });
  }

  /** Report the connection status of a local endpoint. */
  sendStatusUpdate(
    endpointId: string,
    status: "connecting" | "connected" | "disconnected" | "error",
    error?: string,
  ): void {
    this._socket?.emit("statusUpdate", { endpointId, status, error });
  }

  /** Announce the list of resources available for an endpoint. */
  announceResources(endpointId: string, resources: Resource[]): void {
    this._socket?.emit("resourcesAnnounce", {
      endpointId,
      resources: resources.map((r) => ({
        uri: r.uri,
        name: r.name,
        description: r.description,
        mimeType: r.mimeType,
      })),
    });
  }

  /** Notify Central that a single resource has been updated. */
  notifyResourceUpdated(endpointId: string, uri: string): void {
    this._socket?.emit("resourceUpdated", { endpointId, uri });
  }

  /** Notify Central that the resource list for this endpoint has changed. */
  notifyResourceListChanged(endpointId: string): void {
    this._socket?.emit("resourceListChanged", { endpointId });
  }

  /**
   * Send the result of a resource read back to Central.
   * `result` is forwarded verbatim — the firmware contract is to relay the
   * upstream `{ contents: [...] }` object byte-exact so cache-backed
   * resources (where `contents[0].text` carries a JSON-encoded array) reach
   * the MCP client without re-parsing.
   */
  sendResourceResult(callId: string, result: unknown): void {
    this._socket?.emit("resourceResult", { callId, result });
  }

  /** Send a resource read error back to Central. */
  sendResourceError(callId: string, error: string): void {
    this._socket?.emit("resourceResult", { callId, error });
  }
}
