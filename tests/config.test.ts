import { describe, expect, it } from "vitest";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AgentConfigSchema, loadConfig } from "../src/config.js";

const VALID = {
    serverUrl: "https://mcp.example.com",
    agentName: "My Laptop",
    apiKey: "tunnel_0123456789abcdef0123456789abcdef",
};

async function withConfigFile(
    content: string,
    run: (path: string) => Promise<void>,
): Promise<void> {
    const dir = await mkdtemp(join(tmpdir(), "mcp-agent-config-"));
    try {
        const path = join(dir, "mcp-agent.json");
        await writeFile(path, content, "utf-8");
        await run(path);
    } finally {
        await rm(dir, { recursive: true, force: true });
    }
}

describe("AgentConfigSchema", () => {
    it("accepts a valid tunnel configuration", () => {
        const result = AgentConfigSchema.safeParse(VALID);
        expect(result.success).toBe(true);
    });

    it("rejects a non-URL serverUrl", () => {
        const result = AgentConfigSchema.safeParse({
            ...VALID,
            serverUrl: "not-a-url",
        });
        expect(result.success).toBe(false);
    });

    it("rejects keys that do not start with tunnel_", () => {
        const result = AgentConfigSchema.safeParse({
            ...VALID,
            apiKey: "agent_0123456789abcdef",
        });
        expect(result.success).toBe(false);
    });

    it("rejects an empty agentName", () => {
        const result = AgentConfigSchema.safeParse({
            ...VALID,
            agentName: "",
        });
        expect(result.success).toBe(false);
    });

    it("rejects unknown fields", () => {
        const result = AgentConfigSchema.safeParse({
            ...VALID,
            extra: true,
        });
        expect(result.success).toBe(false);
    });
});

describe("loadConfig", () => {
    it("loads a valid configuration file", async () => {
        await withConfigFile(JSON.stringify(VALID), async (path) => {
            await expect(loadConfig(path)).resolves.toEqual(VALID);
        });
    });

    it("reports invalid JSON", async () => {
        await withConfigFile("{ not json", async (path) => {
            await expect(loadConfig(path)).rejects.toThrow(/Invalid JSON/);
        });
    });

    it("reports a missing file", async () => {
        await expect(
            loadConfig(join(tmpdir(), "does-not-exist", "mcp-agent.json")),
        ).rejects.toThrow(/not found/);
    });

    it("lists schema issues for invalid content", async () => {
        await withConfigFile(
            JSON.stringify({ ...VALID, apiKey: "nope" }),
            async (path) => {
                await expect(loadConfig(path)).rejects.toThrow(/Invalid config/);
            },
        );
    });
});
