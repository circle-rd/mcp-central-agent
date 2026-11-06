import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { SSEClientTransport } from "@modelcontextprotocol/sdk/client/sse.js";
import type { Transport } from "@modelcontextprotocol/sdk/shared/transport.js";
import {
    ResourceListChangedNotificationSchema,
    ResourceUpdatedNotificationSchema,
} from "@modelcontextprotocol/sdk/types.js";
import type { Resource, Tool } from "@modelcontextprotocol/sdk/types.js";
import type { EndpointPayload } from "./tunnel.js";
import { AGENT_VERSION } from "./version.js";

// ── Endpoint config ────────────────────────────────────────────────────────

/** Endpoint configuration as pushed by MCP Central (see `tunnel.ts`). */
export type EndpointConfig = EndpointPayload;

export type LocalClientStatus =
    | "disconnected"
    | "connecting"
    | "connected"
    | "error";

// ── Callbacks ─────────────────────────────────────────────────────────────

export interface LocalClientCallbacks {
    onToolsChanged: (tools: Tool[]) => void;
    onStatusChanged: (status: LocalClientStatus, error?: string) => void;
    onResourcesChanged: (resources: Resource[]) => void;
    onResourceUpdated: (uri: string) => void;
    onResourceListChanged: () => void;
}

// ── LocalClient ────────────────────────────────────────────────────────────

const RECONNECT_DELAYS = [1_000, 2_000, 5_000, 10_000, 30_000];

/** One live MCP session: the SDK client and the transport it dialled. */
interface Session {
    client: Client;
    transport: Transport;
}

function errorMessage(err: unknown): string {
    return err instanceof Error ? err.message : String(err);
}

export class LocalClient {
    readonly endpointId: string;
    readonly config: EndpointConfig;

    private _session: Session | null = null;
    private _status: LocalClientStatus = "disconnected";
    private _tools: Tool[] = [];
    private _resources: Resource[] = [];
    private _destroyed = false;
    private _connecting = false;
    private _reconnectAttempt = 0;
    private _reconnectTimer: ReturnType<typeof setTimeout> | null = null;
    private readonly _callbacks: LocalClientCallbacks;

    constructor(config: EndpointConfig, callbacks: LocalClientCallbacks) {
        this.endpointId = config.id;
        this.config = config;
        this._callbacks = callbacks;
    }

    get status(): LocalClientStatus {
        return this._status;
    }

    get tools(): Tool[] {
        return this._tools;
    }

    get resources(): Resource[] {
        return this._resources;
    }

    // ── Lifecycle ─────────────────────────────────────────────────────────

    async connect(): Promise<void> {
        if (this._destroyed || this._connecting) return;
        this._connecting = true;
        this._setStatus("connecting");

        let session: Session | undefined;
        try {
            session = await this._openSession();

            this._session = session;
            this._reconnectAttempt = 0;

            // Discover tools
            const response = await session.client.listTools();
            this._tools = response.tools ?? [];

            // Discover resources (capability is optional — many MCP servers do
            // not implement it; treat MethodNotFound as "no resources exposed").
            await this._discoverResources(session);

            this._hookTransportClose(session.transport);
            this._setStatus("connected");
            this._callbacks.onToolsChanged(this._tools);
        } catch (err) {
            // A failed attempt must not leak the SDK client or a spawned
            // process, so close whatever was dialled before retrying.
            if (session) {
                await this._closeSession(session);
            }
            if (this._destroyed) return;
            this._session = null;
            this._setStatus("error", errorMessage(err));
            this._scheduleReconnect();
        } finally {
            this._connecting = false;
        }
    }

    async callTool(
        toolName: string,
        args: Record<string, unknown>,
    ): Promise<unknown> {
        const session = this._session;
        if (!session) {
            throw new Error(
                `LocalClient for endpoint ${this.endpointId} is not connected`,
            );
        }
        return await session.client.callTool({
            name: toolName,
            arguments: args,
        });
    }

    /**
     * Read an MCP resource and return the SDK response verbatim.
     *
     * The caller (AgentTunnel) MUST forward the returned object byte-exact
     * to Central as `resourceResult.result` — cache-backed resources (e.g.
     * the firmware's `vandal://network/hosts`) encode an entire array inside
     * `contents[0].text` as a JSON string, and any re-parsing here would
     * break upstream consumers that rely on that shape.
     */
    async readResource(uri: string): Promise<unknown> {
        const session = this._session;
        if (!session) {
            throw new Error(
                `LocalClient for endpoint ${this.endpointId} is not connected`,
            );
        }
        return await session.client.readResource({ uri });
    }

    async disconnect(): Promise<void> {
        this._destroyed = true;
        if (this._reconnectTimer) {
            clearTimeout(this._reconnectTimer);
            this._reconnectTimer = null;
        }
        const session = this._session;
        this._session = null;
        if (session) {
            await this._closeSession(session);
        }
        this._setStatus("disconnected");
    }

    // ── Private helpers ───────────────────────────────────────────────────

    /** Dial the configured endpoint and return the live session. */
    private async _openSession(): Promise<Session> {
        const client = new Client(
            {
                name: `mcp-central-agent:${this.config.namespace}`,
                version: AGENT_VERSION,
            },
            { capabilities: { roots: {}, sampling: {} } },
        );

        // For HTTP endpoints: try Streamable HTTP (POST) first, fall back to
        // SSE (GET) if the POST handshake fails — mirrors the backend's
        // UpstreamClient.connectHttp() so the choice is transparent to users.
        let transport: Transport;
        try {
            if (this.config.transport === "streamable-http") {
                transport = await this._connectHttp(client);
            } else {
                const created = this._createTransport();
                await client.connect(created);
                transport = created;
            }
        } catch (err) {
            await client.close().catch(() => {});
            throw err;
        }

        // Wire MCP notifications to the session that carries them, so a late
        // notification can never be applied to a replacement session.
        const session: Session = { client, transport };
        client.setNotificationHandler(
            ResourceListChangedNotificationSchema,
            async () => {
                if (this._session !== session) return;
                this._callbacks.onResourceListChanged();
                await this._discoverResources(session);
            },
        );
        client.setNotificationHandler(
            ResourceUpdatedNotificationSchema,
            async (notif) => {
                if (this._session !== session) return;
                this._callbacks.onResourceUpdated(notif.params.uri);
            },
        );

        return session;
    }

    /** Close an SDK session, swallowing transport errors. */
    private async _closeSession(session: Session): Promise<void> {
        await session.client.close().catch(() => {});
    }

    private _createTransport(): Transport {
        const { transport, url, command, args, env, headers } = this.config;

        if (transport === "stdio") {
            if (!command) {
                throw new Error(
                    `stdio endpoint ${this.endpointId} has no command`,
                );
            }
            const inherited: Record<string, string> = {};
            for (const [key, value] of Object.entries(process.env)) {
                if (value !== undefined) inherited[key] = value;
            }
            // Spawned servers run with the local user's environment (so `PATH`
            // and normal tooling resolve), plus the endpoint's own variables.
            return new StdioClientTransport({
                command,
                args,
                env: { ...inherited, ...env },
            });
        }

        if (!url) {
            throw new Error(
                `${transport} endpoint ${this.endpointId} has no URL`,
            );
        }

        return transport === "streamable-http"
            ? new StreamableHTTPClientTransport(new URL(url), {
                  requestInit: { headers },
              })
            : new SSEClientTransport(new URL(url), { requestInit: { headers } });
    }

    /**
     * Attempts Streamable HTTP (POST) first; falls back to SSE (GET) on failure.
     * Mirrors the logic in the backend's UpstreamClient.connectHttp().
     *
     * Some MCP server providers only expose a GET/SSE endpoint while others use
     * the newer Streamable HTTP POST protocol — this makes both work transparently.
     */
    private async _connectHttp(
        client: Client,
    ): Promise<StreamableHTTPClientTransport | SSEClientTransport> {
        const { url, headers } = this.config;
        if (!url) {
            throw new Error(
                `streamable-http endpoint ${this.endpointId} has no URL`,
            );
        }

        const parsedUrl = new URL(url);
        const reqInit = { headers };

        // ── Attempt 1: Streamable HTTP (POST) ──────────────────
        const streamableTransport = new StreamableHTTPClientTransport(
            parsedUrl,
            { requestInit: reqInit },
        );
        try {
            await client.connect(streamableTransport);
            console.log(
                `[LocalClient] ${this.config.name}: connected via Streamable HTTP (POST)`,
            );
            return streamableTransport;
        } catch {
            // Explicitly close the transport so its underlying fetch/socket is
            // aborted. client.close() alone may not reach the transport if
            // connect() threw before the SDK registered the transport internally.
            streamableTransport.close().catch(() => {});
            await client.close().catch(() => {});
        }

        // ── Attempt 2: SSE (GET) fallback ──────────────────────
        console.log(
            `[LocalClient] ${this.config.name}: Streamable HTTP failed, retrying via SSE (GET)…`,
        );
        const sseTransport = new SSEClientTransport(parsedUrl, {
            requestInit: reqInit,
        });
        try {
            await client.connect(sseTransport);
            console.log(
                `[LocalClient] ${this.config.name}: connected via SSE (GET)`,
            );
            return sseTransport;
        } catch (err) {
            // Same cleanup — abort the dangling fetch so it doesn't fire when the
            // server eventually comes back up.
            sseTransport.close().catch(() => {});
            await client.close().catch(() => {});
            throw err;
        }
    }

    private _setStatus(status: LocalClientStatus, error?: string): void {
        this._status = status;
        this._callbacks.onStatusChanged(status, error);
    }

    /**
     * Detect a server-side drop.
     *
     * `onerror` fires when the remote end closes the connection mid-session
     * (ECONNRESET, ECONNREFUSED after restart, etc.) — the primary signal for
     * SSE and Streamable-HTTP transports. `onclose` fires on any explicit
     * transport close, including our own `disconnect()`.
     *
     * Handlers are no-ops once a client is destroyed or a newer session took
     * over, so a graceful shutdown never reports an error or reconnects.
     */
    private _hookTransportClose(transport: Transport): void {
        const session = this._session;
        const onDrop = (reason: string): void => {
            if (this._destroyed || this._session !== session) return;
            console.warn(`[LocalClient] ${this.config.name}: ${reason}`);
            this._dropConnection(reason);
        };

        transport.onerror = (err) => {
            if (this._status !== "connected") return;
            onDrop(`transport error — ${err.message}`);
        };
        transport.onclose = () => {
            if (this._status !== "connected") return;
            onDrop("transport closed unexpectedly");
        };
    }

    /** Tear down the dropped session and schedule a reconnect. */
    private _dropConnection(reason: string): void {
        const session = this._session;
        this._session = null;
        if (session) {
            session.client.close().catch(() => {});
        }
        this._tools = [];
        this._resources = [];
        this._callbacks.onResourcesChanged(this._resources);
        this._setStatus("error", reason);
        this._scheduleReconnect();
    }

    /**
     * Pull the resource list from the upstream MCP server and fan it out.
     *
     * Servers without the `resources` capability respond with a JSON-RPC
     * `MethodNotFound` (-32601) error; we treat that as "no resources" and
     * leave the cache empty without surfacing an error.
     */
    private async _discoverResources(session: Session): Promise<void> {
        try {
            const response = await session.client.listResources();
            this._resources = response.resources ?? [];
            this._callbacks.onResourcesChanged(this._resources);
        } catch (err) {
            if (isMethodNotFound(err)) {
                // Resources capability not supported by this server.
                this._resources = [];
                this._callbacks.onResourcesChanged(this._resources);
                return;
            }
            console.warn(
                `[LocalClient] ${this.config.name}: listResources failed — ${errorMessage(err)}`,
            );
        }
    }

    private _scheduleReconnect(): void {
        if (this._destroyed) return;
        const delay =
            RECONNECT_DELAYS[
                Math.min(this._reconnectAttempt, RECONNECT_DELAYS.length - 1)
            ] ?? RECONNECT_DELAYS[RECONNECT_DELAYS.length - 1]!;
        this._reconnectAttempt++;
        console.log(
            `[LocalClient] Reconnecting ${this.config.name} in ${delay / 1000}s (attempt ${this._reconnectAttempt})…`,
        );
        this._reconnectTimer = setTimeout(() => {
            this._reconnectTimer = null;
            this.connect().catch((err: unknown) => {
                console.error(
                    `[LocalClient] ${this.config.name}: reconnect failed — ${errorMessage(err)}`,
                );
            });
        }, delay);
    }
}

/** JSON-RPC "Method not found" / "Invalid params" raised by older servers. */
function isMethodNotFound(err: unknown): boolean {
    const code = (err as { code?: unknown } | null)?.code;
    return code === -32601 || code === -32602;
}
