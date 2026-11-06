#!/usr/bin/env node
import { createInterface } from "node:readline";
import { writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { program } from "commander";
import { McpCentralAgent } from "./agent.js";
import { AgentConfigSchema, loadConfig, type AgentConfig } from "./config.js";
import { AGENT_VERSION } from "./version.js";

// ── Helpers ────────────────────────────────────────────────────────────────

/**
 * Line-oriented prompt reader.
 *
 * Piped answers (tests, CI, `yes | …`) are buffered by Node's readline and
 * dropped unless a `line` listener exists, so answers are always consumed
 * through `line` instead of `rl.question()`.
 */
function createPromptReader(rl: ReturnType<typeof createInterface>) {
    const buffered: string[] = [];
    const waiting: ((line: string) => void)[] = [];

    rl.on("line", (line) => {
        const next = waiting.shift();
        if (next) next(line);
        else buffered.push(line);
    });

    return function readLine(question: string): Promise<string> {
        console.error(question);
        return new Promise((resolve) => {
            const next = buffered.shift();
            if (next !== undefined) resolve(next);
            else waiting.push(resolve);
        });
    };
}

/** Prompt for a value until it matches `validate`. */
async function askUntil(
    readLine: (question: string) => Promise<string>,
    question: string,
    validate: (value: string) => string | null,
): Promise<string> {
    for (;;) {
        const value = (await readLine(question)).trim();
        const error = validate(value);
        if (error === null) return value;
        console.error(`  ✗ ${error}`);
    }
}

function hasError(err: unknown): err is Error {
    return err instanceof Error;
}

// ── CLI ────────────────────────────────────────────────────────────────────

program
    .name("mcp-central-agent")
    .description(
        "Bridges local MCP servers to MCP Central via an outbound tunnel",
    )
    .version(AGENT_VERSION);

// ── init ──────────────────────────────────────────────────────────────────

program
    .command("init")
    .description("Create a mcp-agent.json config file interactively")
    .option("-o, --output <path>", "Output file path", "mcp-agent.json")
    .action(async (options: { output: string }) => {
        // Prompts go to stderr so `stdout` stays clean for piping.
        const rl = createInterface({
            input: process.stdin,
            output: process.stderr,
        });

        try {
            console.error("\n  MCP Central Agent — Config Setup\n");

            const readLine = createPromptReader(rl);

            const serverUrl = await askUntil(
                readLine,
                "  MCP Central server URL (e.g. https://mcp.example.com): ",
                (value) => {
                    const parsed = AgentConfigSchema.shape.serverUrl.safeParse(
                        value,
                    );
                    return parsed.success ? null : parsed.error.issues[0]!.message;
                },
            );

            const agentName = await askUntil(
                readLine,
                "  Tunnel name (e.g. My Laptop): ",
                (value) => (value.length > 0 ? null : "name is required"),
            );

            const apiKey = await askUntil(
                readLine,
                "  Tunnel key (starts with tunnel_): ",
                (value) => {
                    const parsed = AgentConfigSchema.shape.apiKey.safeParse(
                        value,
                    );
                    return parsed.success ? null : parsed.error.issues[0]!.message;
                },
            );

            const config: AgentConfig = { serverUrl, agentName, apiKey };

            const outputPath = resolve(options.output);
            await writeFile(
                outputPath,
                JSON.stringify(config, null, 2) + "\n",
                "utf-8",
            );

            console.error(`\n  ✓ Config saved to ${outputPath}`);
            console.error(
                `\n  Run the agent with:\n  npx mcp-central-agent start\n`,
            );
        } finally {
            rl.close();
        }
    });

// ── start ─────────────────────────────────────────────────────────────────

program
    .command("start")
    .description("Start the agent and connect to MCP Central")
    .option("-c, --config <path>", "Path to config file", "mcp-agent.json")
    .action(async (options: { config: string }) => {
        let config: AgentConfig;
        try {
            config = await loadConfig(options.config);
        } catch (err) {
            console.error(
                `\n  Error: ${hasError(err) ? err.message : String(err)}\n`,
            );
            process.exit(1);
        }

        const agent = new McpCentralAgent(config);
        agent.start();

        let stopping = false;
        const shutdown = async (signal: NodeJS.Signals): Promise<void> => {
            if (stopping) return;
            stopping = true;
            console.log(`\n  Shutting down (${signal})…`);
            try {
                await agent.stop();
                process.exit(0);
            } catch (err) {
                console.error(
                    `  Error during shutdown: ${hasError(err) ? err.message : String(err)}`,
                );
                process.exit(1);
            }
        };

        process.on("SIGINT", (signal) => void shutdown(signal));
        process.on("SIGTERM", (signal) => void shutdown(signal));
    });

// ── Parse ──────────────────────────────────────────────────────────────────

program.parseAsync(process.argv).catch((err: unknown) => {
    console.error(
        `  Error: ${hasError(err) ? err.message : String(err)}`,
    );
    process.exit(1);
});
