import { describe, expect, it } from "vitest";
import {
    EndpointConfigSchema,
    ResourceReadPayloadSchema,
    ToolCallPayloadSchema,
} from "../src/tunnel.js";

const ENDPOINT = {
    id: "ep-1",
    name: "Filesystem",
    namespace: "filesystem",
    transport: "stdio",
    url: null,
    command: "npx",
    args: ["-y", "@modelcontextprotocol/server-filesystem", "/tmp"],
    env: {},
    headers: {},
    isEnabled: true,
};

describe("EndpointConfigSchema", () => {
    it("accepts a stdio endpoint", () => {
        expect(EndpointConfigSchema.safeParse(ENDPOINT).success).toBe(true);
    });

    it("accepts an HTTP endpoint", () => {
        const result = EndpointConfigSchema.safeParse({
            ...ENDPOINT,
            transport: "streamable-http",
            command: null,
            url: "http://localhost:3001/mcp",
            headers: { Authorization: "Bearer x" },
        });
        expect(result.success).toBe(true);
    });

    it("rejects an unsupported transport", () => {
        const result = EndpointConfigSchema.safeParse({
            ...ENDPOINT,
            transport: "websocket",
        });
        expect(result.success).toBe(false);
    });

    it("rejects non-string env values", () => {
        const result = EndpointConfigSchema.safeParse({
            ...ENDPOINT,
            env: { DEBUG: true },
        });
        expect(result.success).toBe(false);
    });

    it("rejects a missing id", () => {
        const { id: _id, ...withoutId } = ENDPOINT;
        expect(EndpointConfigSchema.safeParse(withoutId).success).toBe(false);
    });

    it("rejects unknown fields instead of trusting them", () => {
        const result = EndpointConfigSchema.safeParse({
            ...ENDPOINT,
            agentId: "agent-1",
            tunnelId: "tunnel-1",
        });
        expect(result.success).toBe(false);
    });
});

describe("ToolCallPayloadSchema", () => {
    it("accepts a tool call with arguments", () => {
        const result = ToolCallPayloadSchema.safeParse({
            callId: "call-1",
            endpointId: "ep-1",
            toolName: "read_file",
            args: { path: "/tmp/file" },
        });
        expect(result.success).toBe(true);
    });

    it("rejects a missing toolName", () => {
        const result = ToolCallPayloadSchema.safeParse({
            callId: "call-1",
            endpointId: "ep-1",
            args: {},
        });
        expect(result.success).toBe(false);
    });

    it("rejects non-object arguments", () => {
        const result = ToolCallPayloadSchema.safeParse({
            callId: "call-1",
            endpointId: "ep-1",
            toolName: "read_file",
            args: ["path"],
        });
        expect(result.success).toBe(false);
    });
});

describe("ResourceReadPayloadSchema", () => {
    it("accepts a resource read", () => {
        const result = ResourceReadPayloadSchema.safeParse({
            callId: "call-1",
            endpointId: "ep-1",
            uri: "file:///tmp/file",
        });
        expect(result.success).toBe(true);
    });

    it("rejects an empty uri", () => {
        const result = ResourceReadPayloadSchema.safeParse({
            callId: "call-1",
            endpointId: "ep-1",
            uri: "",
        });
        expect(result.success).toBe(false);
    });
});
