import type { AgentConfig } from "./config.js";
import type { EndpointConfig, LocalClientStatus } from "./local-client.js";
import { LocalClient } from "./local-client.js";
import { AgentTunnel } from "./tunnel.js";

// ── McpCentralAgent ──────────────────────────────────────────────────────

/**
 * Orchestrates one Socket.IO tunnel and the pool of local MCP clients it
 * manages. Endpoints are owned by MCP Central: the tunnel pushes additions,
 * updates, toggles and removals, and this class keeps the pool in sync.
 */
export class McpCentralAgent {
    private readonly _config: AgentConfig;
    private readonly _tunnel: AgentTunnel;
    private readonly _clients = new Map<string, LocalClient>();
    private readonly _endpoints = new Map<string, EndpointConfig>();

    constructor(config: AgentConfig) {
        this._config = config;
        this._tunnel = new AgentTunnel(config, {
            onEndpoints: (endpoints) => this._syncEndpoints(endpoints),
            onEndpointAdd: (endpoint) => this._addEndpoint(endpoint),
            onEndpointRemove: (endpointId) => this._removeEndpoint(endpointId),
            onEndpointToggle: (endpointId, isEnabled) =>
                this._toggleEndpoint(endpointId, isEnabled),
            onEndpointUpdate: (endpoint) => this._updateEndpoint(endpoint),
            onEndpointRefresh: (endpointId) =>
                this._refreshEndpoint(endpointId),
            onToolCall: (payload) => this._handleToolCall(payload),
            onResourceRead: (payload) => this._handleResourceRead(payload),
            onDisconnect: () => this._markAllDisconnected(),
        });
    }

    /** Start the agent: connect tunnel and wait for endpoint list. */
    start(): void {
        console.log(
            `[McpCentralAgent] Starting agent '${this._config.agentName}'…`,
        );
        console.log(
            `[McpCentralAgent] Connecting to ${this._config.serverUrl}…`,
        );
        this._tunnel.connect();
    }

    /** Gracefully stop the agent. */
    async stop(): Promise<void> {
        console.log(`[McpCentralAgent] Stopping…`);
        for (const client of this._clients.values()) {
            await client.disconnect();
        }
        this._clients.clear();
        this._endpoints.clear();
        this._tunnel.disconnect();
    }

    // ── Endpoint lifecycle ───────────────────────────────────────────────

    private _syncEndpoints(endpoints: EndpointConfig[]): void {
        const incoming = new Set(endpoints.map((e) => e.id));
        for (const id of [...this._clients.keys()]) {
            if (!incoming.has(id)) {
                this._removeEndpoint(id);
            }
        }

        for (const endpoint of endpoints) {
            this._endpoints.set(endpoint.id, endpoint);
            if (!endpoint.isEnabled) continue;
            if (this._clients.has(endpoint.id)) continue;
            this._addEndpoint(endpoint);
        }
    }

    private _addEndpoint(endpoint: EndpointConfig): void {
        this._endpoints.set(endpoint.id, endpoint);

        if (!endpoint.isEnabled) {
            this._removeClient(endpoint.id);
            console.log(
                `[McpCentralAgent] Endpoint '${endpoint.name}' is disabled — skipping`,
            );
            return;
        }

        // Replace any existing client for this endpoint.
        this._removeClient(endpoint.id);

        const client = new LocalClient(endpoint, {
            onToolsChanged: (tools) => {
                this._tunnel.announceTools(endpoint.id, tools);
            },
            onStatusChanged: (status, error) => {
                this._tunnel.sendStatusUpdate(endpoint.id, status, error);
            },
            onResourcesChanged: (resources) => {
                this._tunnel.announceResources(endpoint.id, resources);
            },
            onResourceUpdated: (uri) => {
                this._tunnel.notifyResourceUpdated(endpoint.id, uri);
            },
            onResourceListChanged: () => {
                this._tunnel.notifyResourceListChanged(endpoint.id);
            },
        });

        this._clients.set(endpoint.id, client);
        client.connect().catch((err: unknown) => {
            console.error(
                `[McpCentralAgent] Failed to connect '${endpoint.name}': ${String(err)}`,
            );
        });
    }

    /** Drop a client without touching the endpoint registry. */
    private _removeClient(endpointId: string): void {
        const client = this._clients.get(endpointId);
        if (!client) return;
        this._clients.delete(endpointId);
        client.disconnect().catch((err: unknown) => {
            console.warn(
                `[McpCentralAgent] Failed to disconnect ${endpointId}: ${String(err)}`,
            );
        });
    }

    private _removeEndpoint(endpointId: string): void {
        const known = this._endpoints.delete(endpointId);
        this._removeClient(endpointId);
        if (known) {
            console.log(`[McpCentralAgent] Endpoint ${endpointId} removed`);
        }
    }

    private _toggleEndpoint(endpointId: string, isEnabled: boolean): void {
        this._removeClient(endpointId);
        if (!isEnabled) {
            this._tunnel.sendStatusUpdate(endpointId, "disconnected");
            return;
        }
        // Re-enable: the stored config is authoritative when known, otherwise
        // Central answers the status update with a full `endpoint_refresh`.
        const endpoint = this._endpoints.get(endpointId);
        this._tunnel.sendStatusUpdate(endpointId, "connecting");
        if (endpoint) {
            this._addEndpoint(endpoint);
        }
    }

    private _updateEndpoint(endpoint: EndpointConfig): void {
        this._addEndpoint(endpoint);
    }

    private _refreshEndpoint(endpointId: string): void {
        const client = this._clients.get(endpointId);
        // A client still in its initial connecting phase was created by the
        // `tunnel:endpoints` push that precedes the refresh — reconnect only
        // settled sessions so the refresh does not open a duplicate.
        if (client && client.status === "connecting") return;

        const endpoint = this._endpoints.get(endpointId);
        this._removeClient(endpointId);
        if (endpoint) {
            this._addEndpoint(endpoint);
        }
    }

    private _markAllDisconnected(): void {
        for (const endpointId of this._clients.keys()) {
            this._tunnel.sendStatusUpdate(endpointId, "disconnected");
        }
    }

    // ── Tool call handling ───────────────────────────────────────────────

    private async _handleToolCall(payload: {
        callId: string;
        endpointId: string;
        toolName: string;
        args: Record<string, unknown>;
    }): Promise<void> {
        const { callId, endpointId, toolName, args } = payload;
        const client = this._connectedClient(endpointId);

        if (!client.ok) {
            this._tunnel.sendToolError(callId, client.error);
            return;
        }

        try {
            const result = await client.client.callTool(toolName, args);
            this._tunnel.sendToolResult(callId, result);
        } catch (err) {
            this._tunnel.sendToolError(callId, errorMessage(err));
        }
    }

    // ── Resource read handling ───────────────────────────────────────────

    private async _handleResourceRead(payload: {
        callId: string;
        endpointId: string;
        uri: string;
    }): Promise<void> {
        const { callId, endpointId, uri } = payload;
        const client = this._connectedClient(endpointId);

        if (!client.ok) {
            this._tunnel.sendResourceError(callId, client.error);
            return;
        }

        try {
            // Forwarded verbatim — see LocalClient.readResource() rationale.
            const result = await client.client.readResource(uri);
            this._tunnel.sendResourceResult(callId, result);
        } catch (err) {
            this._tunnel.sendResourceError(callId, errorMessage(err));
        }
    }

    /** Resolve an endpoint id to a connected client, or an error message. */
    private _connectedClient(
        endpointId: string,
    ): { ok: true; client: LocalClient } | { ok: false; error: string } {
        const client = this._clients.get(endpointId);
        if (!client) {
            return {
                ok: false,
                error: `No local client for endpoint ${endpointId}`,
            };
        }
        if (client.status !== "connected") {
            return {
                ok: false,
                error: `Endpoint ${endpointId} is not connected (status: ${client.status})`,
            };
        }
        return { ok: true, client };
    }
}

function errorMessage(err: unknown): string {
    return err instanceof Error ? err.message : String(err);
}

export type { EndpointConfig, LocalClientStatus };
