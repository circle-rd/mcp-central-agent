import { io, type Socket } from "socket.io-client";
import type { Resource, Tool } from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";
import type { AgentConfig } from "./config.js";
import type { LocalClientStatus } from "./local-client.js";
import { AGENT_VERSION } from "./version.js";

// ── Tunnel protocol types ────────────────────────────────────────────────

export const ToolCallPayloadSchema = z.strictObject({
    callId: z.string().min(1),
    endpointId: z.string().min(1),
    toolName: z.string().min(1),
    args: z.record(z.string(), z.unknown()),
});

export type ToolCallPayload = z.infer<typeof ToolCallPayloadSchema>;

export const ResourceReadPayloadSchema = z.strictObject({
    callId: z.string().min(1),
    endpointId: z.string().min(1),
    uri: z.string().min(1),
});

export type ResourceReadPayload = z.infer<typeof ResourceReadPayloadSchema>;

export const EndpointConfigSchema = z.strictObject({
    id: z.string().min(1),
    name: z.string().min(1),
    namespace: z.string().min(1),
    transport: z.enum(["stdio", "streamable-http", "sse"]),
    url: z.string().nullable(),
    command: z.string().nullable(),
    args: z.array(z.string()),
    env: z.record(z.string(), z.string()),
    headers: z.record(z.string(), z.string()),
    isEnabled: z.boolean(),
});

/** One endpoint pushed by MCP Central, as received on the wire. */
export type EndpointPayload = z.infer<typeof EndpointConfigSchema>;

export interface TunnelCallbacks {
    onEndpoints: (endpoints: EndpointPayload[]) => void;
    onEndpointAdd: (endpoint: EndpointPayload) => void;
    onEndpointRemove: (endpointId: string) => void;
    onEndpointToggle: (endpointId: string, isEnabled: boolean) => void;
    onEndpointUpdate: (endpoint: EndpointPayload) => void;
    onEndpointRefresh: (endpointId: string) => void;
    onToolCall: (payload: ToolCallPayload) => void;
    onResourceRead: (payload: ResourceReadPayload) => void;
    onDisconnect: () => void;
}

// ── Schema helpers ───────────────────────────────────────────────────────

/**
 * Parses an untrusted Socket.IO payload.
 *
 * A malformed server push is a protocol violation, not a recoverable state:
 * report it on stderr and drop the event instead of feeding an unvalidated
 * shape to the agent.
 */
function parseEvent<T>(schema: z.ZodType<T>, event: string, data: unknown): T {
    const result = schema.safeParse(data);
    if (!result.success) {
        console.error(
            `[AgentTunnel] Ignoring malformed '${event}' payload: ${z.prettifyError(result.error)}`,
        );
        throw new Error(`Malformed '${event}' payload`);
    }
    return result.data;
}

/** Event carrying one endpoint row pushed by MCP Central. */
const EndpointPushEventSchema = z.strictObject({
    endpoint: z
        .unknown()
        .transform((value, ctx) => {
            const result = EndpointConfigSchema.safeParse(
                pickEndpointFields(value),
            );
            if (!result.success) {
                ctx.addIssue({
                    code: "custom",
                    message: z.prettifyError(result.error),
                });
                return z.NEVER;
            }
            return result.data;
        }),
});
const EndpointRemoveEventSchema = z.strictObject({
    endpointId: z.string().min(1),
});
const EndpointToggleEventSchema = z.strictObject({
    endpointId: z.string().min(1),
    isEnabled: z.boolean(),
});
const EndpointRefreshEventSchema = z.strictObject({
    endpointId: z.string().min(1),
});
const JoinAckSchema = z.strictObject({ status: z.string() });

/**
 * Extracts the protocol fields of an endpoint pushed by MCP Central.
 *
 * MCP Central forwards its full endpoint row (database columns included), so
 * only the fields of the tunnel contract are kept before strict validation;
 * anything else is dropped rather than trusted.
 */
function pickEndpointFields(value: unknown): unknown {
    if (typeof value !== "object" || value === null) return value;
    const { id, name, namespace, transport, url, command, args, env, headers, isEnabled } =
        value as Record<string, unknown>;
    return { id, name, namespace, transport, url, command, args, env, headers, isEnabled };
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
                const parsed = JoinAckSchema.safeParse(ack);
                if (parsed.success && parsed.data.status === "error") {
                    console.error("[AgentTunnel] join rejected:", parsed.data);
                }
            });
        });

        this._socket.on("disconnect", (reason) => {
            console.warn(`[AgentTunnel] Disconnected: ${reason}`);
            this._callbacks.onDisconnect();
        });

        this._socket.on("connect_error", (err) => {
            console.error(`[AgentTunnel] Connection error: ${err.message}`);
        });

        // ── Server → Agent events (tunnel:* prefix) ─────────────────────────

        this._socket.on("tunnel:endpoints", (payload: unknown) => {
            let endpoints: EndpointPayload[];
            try {
                endpoints = parseEvent(
                    z.array(EndpointConfigSchema),
                    "tunnel:endpoints",
                    payload,
                );
            } catch {
                return;
            }
            console.log(`[AgentTunnel] Received ${endpoints.length} endpoints`);
            this._callbacks.onEndpoints(endpoints);
        });

        // The server pushes a full database row (agentId, tunnelId, …), so
        // event envelopes are normalized to the protocol fields before the
        // strict endpoint schema validates them.
        this._socket.on("tunnel:endpoint_add", (payload: unknown) => {
            try {
                const { endpoint } = parseEvent(
                    EndpointPushEventSchema,
                    "tunnel:endpoint_add",
                    payload,
                );
                console.log(`[AgentTunnel] Endpoint added: ${endpoint.name}`);
                this._callbacks.onEndpointAdd(endpoint);
            } catch {
                // Already reported by parseEvent.
            }
        });

        this._socket.on("tunnel:endpoint_remove", (payload: unknown) => {
            try {
                const { endpointId } = parseEvent(
                    EndpointRemoveEventSchema,
                    "tunnel:endpoint_remove",
                    payload,
                );
                console.log(`[AgentTunnel] Endpoint removed: ${endpointId}`);
                this._callbacks.onEndpointRemove(endpointId);
            } catch {
                // Already reported by parseEvent.
            }
        });

        this._socket.on("tunnel:endpoint_toggle", (payload: unknown) => {
            try {
                const { endpointId, isEnabled } = parseEvent(
                    EndpointToggleEventSchema,
                    "tunnel:endpoint_toggle",
                    payload,
                );
                this._callbacks.onEndpointToggle(endpointId, isEnabled);
            } catch {
                // Already reported by parseEvent.
            }
        });

        this._socket.on("tunnel:endpoint_update", (payload: unknown) => {
            try {
                const { endpoint } = parseEvent(
                    EndpointPushEventSchema,
                    "tunnel:endpoint_update",
                    payload,
                );
                console.log(`[AgentTunnel] Endpoint updated: ${endpoint.name}`);
                this._callbacks.onEndpointUpdate(endpoint);
            } catch {
                // Already reported by parseEvent.
            }
        });

        this._socket.on("tunnel:endpoint_refresh", (payload: unknown) => {
            try {
                const { endpointId } = parseEvent(
                    EndpointRefreshEventSchema,
                    "tunnel:endpoint_refresh",
                    payload,
                );
                console.log(`[AgentTunnel] Endpoint refresh: ${endpointId}`);
                this._callbacks.onEndpointRefresh(endpointId);
            } catch {
                // Already reported by parseEvent.
            }
        });

        this._socket.on("tunnel:tool_call", (payload: unknown) => {
            try {
                this._callbacks.onToolCall(
                    parseEvent(ToolCallPayloadSchema, "tunnel:tool_call", payload),
                );
            } catch {
                // Already reported by parseEvent.
            }
        });

        this._socket.on("tunnel:resource_read", (payload: unknown) => {
            try {
                this._callbacks.onResourceRead(
                    parseEvent(
                        ResourceReadPayloadSchema,
                        "tunnel:resource_read",
                        payload,
                    ),
                );
            } catch {
                // Already reported by parseEvent.
            }
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
        status: LocalClientStatus,
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
