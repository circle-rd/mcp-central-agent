import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Transport } from "@modelcontextprotocol/sdk/shared/transport.js";
import type { JSONRPCMessage } from "@modelcontextprotocol/sdk/types.js";
import type { EndpointConfig, LocalClientStatus } from "../src/local-client.js";

type TransportFactory = () => Transport;

const sdk = vi.hoisted(() => ({
    createTransport: (() => {
        throw new Error("transport factory not configured");
    }) as TransportFactory,
    behavior: {
        listTools: (): Promise<unknown> =>
            Promise.resolve({ tools: [{ name: "ping", inputSchema: {} }] }),
        listResources: (): Promise<unknown> => Promise.resolve({ resources: [] }),
        close: (): Promise<void> => Promise.resolve(),
    },
}));

vi.mock("@modelcontextprotocol/sdk/client/stdio.js", () => ({
    StdioClientTransport: class {
        constructor() {
            return sdk.createTransport();
        }
    },
}));

vi.mock("@modelcontextprotocol/sdk/client/index.js", () => ({
    Client: class {
        constructor(_info: unknown, _options: unknown, _transport?: Transport) {}

        async connect(transport: Transport): Promise<void> {
            await transport.start();
        }

        setNotificationHandler(): void {}

        listTools(): Promise<unknown> {
            return sdk.behavior.listTools();
        }

        listResources(): Promise<unknown> {
            return sdk.behavior.listResources();
        }

        callTool(): Promise<unknown> {
            return Promise.resolve({ content: [] });
        }

        readResource(): Promise<unknown> {
            return Promise.resolve({ contents: [] });
        }

        close(): Promise<void> {
            return sdk.behavior.close();
        }
    },
}));

const { LocalClient } = await import("../src/local-client.js");

const ENDPOINT: EndpointConfig = {
    id: "ep-1",
    name: "Filesystem",
    namespace: "filesystem",
    transport: "stdio",
    url: null,
    command: "fake-mcp-server",
    args: [],
    env: {},
    headers: {},
    isEnabled: true,
};

function createFakeTransport(): Transport & {
    failStart: (err: Error) => void;
    drop: (err: Error) => void;
} {
    const transport: Transport = {
        async start(): Promise<void> {},
        async send(_message: JSONRPCMessage): Promise<void> {},
        async close(): Promise<void> {},
    };
    return Object.assign(transport, {
        failStart: (err: Error) => transport.onerror?.(err),
        drop: (err: Error) => transport.onerror?.(err),
    });
}

function makeClient() {
    const statuses: { status: LocalClientStatus; error: string | undefined }[] =
        [];
    const client = new LocalClient(ENDPOINT, {
        onToolsChanged: () => {},
        onStatusChanged: (status, error) => statuses.push({ status, error }),
        onResourcesChanged: () => {},
        onResourceUpdated: () => {},
        onResourceListChanged: () => {},
    });
    return { client, statuses };
}

describe("LocalClient lifecycle", () => {
    let transports: ReturnType<typeof createFakeTransport>[];

    function transportAt(index: number): ReturnType<typeof createFakeTransport> {
        const transport = transports[index];
        if (!transport) throw new Error(`transport ${index} was never created`);
        return transport;
    }

    beforeEach(() => {
        vi.useFakeTimers();
        transports = [];
        sdk.createTransport = () => {
            const transport = createFakeTransport();
            transports.push(transport);
            return transport;
        };
        sdk.behavior.listTools = () =>
            Promise.resolve({ tools: [{ name: "ping", inputSchema: {} }] });
        sdk.behavior.listResources = () => Promise.resolve({ resources: [] });
        sdk.behavior.close = () => Promise.resolve();
    });

    afterEach(() => {
        vi.useRealTimers();
    });

    it("connects and only then reports connected", async () => {
        const { client, statuses } = makeClient();
        await client.connect();

        expect(client.status).toBe("connected");
        expect(statuses.map((s) => s.status)).toEqual([
            "connecting",
            "connected",
        ]);
        await client.disconnect();
    });

    it("reconnects after a transport drop", async () => {
        const { client, statuses } = makeClient();
        await client.connect();
        expect(transports).toHaveLength(1);

        transportAt(0).drop(new Error("connection reset"));
        expect(client.status).toBe("error");

        await vi.advanceTimersByTimeAsync(1_000);
        expect(transports).toHaveLength(2);
        expect(client.status).toBe("connected");
        expect(statuses.filter((s) => s.status === "connected")).toHaveLength(2);

        transportAt(0).drop(new Error("late error from the dropped transport"));
        expect(client.status).toBe("connected");
        await client.disconnect();
    });

    it("does not reconnect once disconnected", async () => {
        const { client, statuses } = makeClient();
        await client.connect();
        await client.disconnect();

        transportAt(0).drop(new Error("late error"));
        await vi.advanceTimersByTimeAsync(60_000);

        expect(statuses.filter((s) => s.status === "error")).toHaveLength(0);
        expect(client.status).not.toBe("connected");
    });

    it("closes the session when discovery fails", async () => {
        const close = vi.fn();
        sdk.behavior.close = () => {
            close();
            return Promise.resolve();
        };
        sdk.behavior.listTools = () => Promise.reject(new Error("boom"));

        const { client, statuses } = makeClient();
        await client.connect();

        expect(close).toHaveBeenCalled();
        expect(client.status).toBe("error");
        expect(statuses.at(-1)?.error).toBe("boom");
        await client.disconnect();
    });

    it("rejects calls before a session exists", async () => {
        const { client } = makeClient();
        await expect(client.callTool("ping", {})).rejects.toThrow(
            /not connected/,
        );
    });
});
