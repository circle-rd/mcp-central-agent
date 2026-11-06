import { beforeEach, describe, expect, it, vi } from "vitest";
import type { AgentConfig } from "../src/config.js";
import type { LocalClientStatus } from "../src/local-client.js";
import type { EndpointPayload, TunnelCallbacks } from "../src/tunnel.js";

const mocks = vi.hoisted(() => ({
    callbacks: undefined as TunnelCallbacks | undefined,
    clients: [] as { status: LocalClientStatus }[],
    tunnel: {
        connect: vi.fn(),
        disconnect: vi.fn(),
        sendStatusUpdate: vi.fn(),
        announceTools: vi.fn(),
        announceResources: vi.fn(),
        notifyResourceUpdated: vi.fn(),
        notifyResourceListChanged: vi.fn(),
    },
}));

vi.mock("../src/tunnel.js", () => ({
    AgentTunnel: class {
        constructor(_config: unknown, callbacks: TunnelCallbacks) {
            mocks.callbacks = callbacks;
            return mocks.tunnel;
        }
    },
}));

vi.mock("../src/local-client.js", () => ({
    LocalClient: class {
        status: LocalClientStatus = "connected";

        constructor() {
            mocks.clients.push(this);
        }

        connect(): Promise<void> {
            return Promise.resolve();
        }

        disconnect(): Promise<void> {
            return Promise.resolve();
        }
    },
}));

const { McpCentralAgent } = await import("../src/agent.js");

const CONFIG: AgentConfig = {
    serverUrl: "https://mcp.example.com",
    agentName: "My Laptop",
    apiKey: "tunnel_0123456789abcdef0123456789abcdef",
};

const ENDPOINT: EndpointPayload = {
    id: "ep-1",
    name: "Filesystem",
    namespace: "filesystem",
    transport: "stdio",
    url: null,
    command: "npx",
    args: [],
    env: {},
    headers: {},
    isEnabled: true,
};

function tunnelCallbacks(): TunnelCallbacks {
    if (!mocks.callbacks) throw new Error("agent did not create a tunnel");
    return mocks.callbacks;
}

describe("McpCentralAgent endpoint list", () => {
    beforeEach(() => {
        vi.spyOn(console, "log").mockImplementation(() => {});
        mocks.callbacks = undefined;
        mocks.clients.length = 0;
        mocks.tunnel.sendStatusUpdate.mockClear();
        new McpCentralAgent(CONFIG);
    });

    it("starts a client for each new enabled endpoint", () => {
        tunnelCallbacks().onEndpoints([ENDPOINT]);

        expect(mocks.clients).toHaveLength(1);
    });

    it("does not start a client for a disabled endpoint", () => {
        tunnelCallbacks().onEndpoints([{ ...ENDPOINT, isEnabled: false }]);

        expect(mocks.clients).toHaveLength(0);
    });
});

describe("McpCentralAgent endpoint list after a tunnel reconnect", () => {
    beforeEach(() => {
        vi.spyOn(console, "log").mockImplementation(() => {});
        mocks.callbacks = undefined;
        mocks.clients.length = 0;
        mocks.tunnel.sendStatusUpdate.mockClear();
        new McpCentralAgent(CONFIG);
        tunnelCallbacks().onEndpointAdd(ENDPOINT);
        mocks.tunnel.sendStatusUpdate.mockClear();
    });

    it("reports the real status of a retained client without reconnecting it", () => {
        tunnelCallbacks().onEndpoints([ENDPOINT]);

        expect(mocks.clients).toHaveLength(1);
        expect(mocks.tunnel.sendStatusUpdate).toHaveBeenCalledExactlyOnceWith(
            "ep-1",
            "connected",
        );
    });

    it("reports a retained client that is in error as such", () => {
        const [client] = mocks.clients;
        if (!client) throw new Error("no client was created");
        client.status = "error";

        tunnelCallbacks().onEndpoints([ENDPOINT]);

        expect(mocks.tunnel.sendStatusUpdate).toHaveBeenCalledExactlyOnceWith(
            "ep-1",
            "error",
        );
    });
});
