import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { AgentConfig } from "../src/config.js";
import type { TunnelCallbacks } from "../src/tunnel.js";

type Listener = (payload: unknown) => void;

const socket = vi.hoisted(() => {
    const listeners = new Map<string, Listener>();
    return {
        listeners,
        on: (event: string, listener: Listener): void => {
            listeners.set(event, listener);
        },
        emit: (): void => {},
        disconnect: (): void => {},
    };
});

vi.mock("socket.io-client", () => ({ io: () => socket }));

const { AgentTunnel } = await import("../src/tunnel.js");

const CONFIG: AgentConfig = {
    serverUrl: "https://mcp.example.com",
    agentName: "My Laptop",
    apiKey: "tunnel_0123456789abcdef0123456789abcdef",
};

const ENDPOINT = {
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

function createCallbacks() {
    return {
        onEndpoints: vi.fn(),
        onEndpointAdd: vi.fn(),
        onEndpointRemove: vi.fn(),
        onEndpointToggle: vi.fn(),
        onEndpointUpdate: vi.fn(),
        onEndpointRefresh: vi.fn(),
        onToolCall: vi.fn(),
        onResourceRead: vi.fn(),
    } satisfies TunnelCallbacks;
}

function receive(event: string, payload: unknown): void {
    const listener = socket.listeners.get(event);
    if (!listener) throw new Error(`no listener registered for '${event}'`);
    listener(payload);
}

describe("AgentTunnel server events", () => {
    let callbacks: ReturnType<typeof createCallbacks>;
    let stderr: ReturnType<typeof vi.spyOn>;

    beforeEach(() => {
        vi.spyOn(console, "log").mockImplementation(() => {});
        vi.spyOn(console, "warn").mockImplementation(() => {});
        stderr = vi.spyOn(console, "error").mockImplementation(() => {});
        socket.listeners.clear();
        callbacks = createCallbacks();
        new AgentTunnel(CONFIG, callbacks).connect();
    });

    afterEach(() => {
        vi.restoreAllMocks();
    });

    it("forwards a valid payload to the callback", () => {
        receive("tunnel:endpoint_remove", { endpointId: "ep-1" });

        expect(callbacks.onEndpointRemove).toHaveBeenCalledWith("ep-1");
        expect(stderr).not.toHaveBeenCalled();
    });

    it("reports a malformed payload on stderr and drops it", () => {
        receive("tunnel:endpoint_remove", { endpointId: "" });

        expect(callbacks.onEndpointRemove).not.toHaveBeenCalled();
        expect(stderr).toHaveBeenCalledWith(
            expect.stringContaining("'tunnel:endpoint_remove'"),
        );
    });

    it("keeps only the protocol fields of a pushed endpoint row", () => {
        receive("tunnel:endpoint_add", {
            endpoint: { ...ENDPOINT, agentId: "agent-1", tunnelId: "tunnel-1" },
        });

        expect(callbacks.onEndpointAdd).toHaveBeenCalledWith(ENDPOINT);
    });

    it("does not swallow exceptions raised by a callback", () => {
        callbacks.onToolCall.mockImplementation(() => {
            throw new Error("callback failed");
        });

        expect(() =>
            receive("tunnel:tool_call", {
                callId: "call-1",
                endpointId: "ep-1",
                toolName: "read_file",
                args: {},
            }),
        ).toThrow("callback failed");
        expect(stderr).not.toHaveBeenCalled();
    });
});
