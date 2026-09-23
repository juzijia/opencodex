import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { QODER_TOOL_LIMITS } from "../../src/adapters/qoder/tool-bridge";

const tempDirs: string[] = [];
const serverPath = join(
  import.meta.dir,
  "..",
  "..",
  "src",
  "adapters",
  "qoder",
  "mcp-server.ts",
);

function definition(
  name: string,
  overrides: Record<string, unknown> = {},
): Record<string, unknown> {
  return {
    name,
    description: `Description for ${name}`,
    inputSchema: { type: "object" },
    ...overrides,
  };
}

async function rejectedCatalog(rawCatalog: string): Promise<string> {
  const dir = mkdtempSync(join(tmpdir(), "opencodex-qoder-mcp-reject-"));
  tempDirs.push(dir);
  const catalogPath = join(dir, "tools.json");
  writeFileSync(catalogPath, rawCatalog, { mode: 0o600 });
  const child = Bun.spawn({
    cmd: [process.execPath, serverPath, catalogPath],
    stdout: "ignore",
    stderr: "pipe",
  });
  const stderrPromise = new Response(child.stderr).text();
  const exitCode = await child.exited;
  const stderr = await stderrPromise;
  expect(exitCode).not.toBe(0);
  return stderr;
}

afterEach(() => {
  for (const dir of tempDirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

describe("Qoder capture-only MCP server", () => {
  test("compiled ocx serves the private Qoder MCP entrypoint", async () => {
    const dir = mkdtempSync(join(tmpdir(), "ocx-compiled-qoder-mcp-"));
    tempDirs.push(dir);
    const binary = join(dir, process.platform === "win32" ? "ocx.exe" : "ocx");
    const compiled = Bun.spawnSync([process.execPath, "build", "--compile", join(import.meta.dir, "../../src/cli/index.ts"), "--outfile", binary]);
    expect(compiled.exitCode).toBe(0);
    if (process.platform === "darwin") {
      expect(Bun.spawnSync(["codesign", "--force", "--sign", "-", binary]).exitCode).toBe(0);
    }
    const catalogPath = join(dir, "catalog.json");
    writeFileSync(catalogPath, JSON.stringify([definition("lookup")]));
    const client = new Client({ name: "compiled-qoder-test", version: "1.0.0" });
    const transport = new StdioClientTransport({ command: binary, args: ["__qoder-mcp", catalogPath], stderr: "pipe" });
    let pid: number | null = null;
    try {
      await client.connect(transport);
      pid = transport.pid;
      expect((await client.listTools()).tools.map(tool => tool.name)).toEqual(["lookup"]);
    } finally {
      await client.close();
      if (pid !== null) {
        for (let attempt = 0; attempt < 100; attempt++) {
          try { process.kill(pid, 0); } catch { break; }
          await Bun.sleep(20);
        }
      }
      // Windows releases a just-exited executable's file handle slightly after process exit.
      if (process.platform === "win32") await Bun.sleep(500);
    }
  });

  test("reports oversized arguments through a bounded capture error", async () => {
    const dir = mkdtempSync(join(tmpdir(), "opencodex-qoder-mcp-limit-"));
    tempDirs.push(dir);
    const catalogPath = join(dir, "tools.json");
    writeFileSync(catalogPath, JSON.stringify([definition("lookup")]));
    const client = new Client({ name: "qoder-limit-test", version: "1" });
    const transport = new StdioClientTransport({
      command: process.execPath, args: [serverPath, catalogPath], stderr: "pipe",
      env: { OCX_MCP_CAPTURE_DIR: dir, OCX_MCP_CAPTURE_NONCE: "test-nonce" },
    });
    const abort = new AbortController();
    try {
      await client.connect(transport);
      const pending = client.callTool({ name: "lookup", arguments: { value: "x".repeat(256 * 1024) } }, undefined, { signal: abort.signal });
      void pending.catch(() => {});
      const capture = join(dir, "capture-1.json");
      for (let i = 0; i < 100 && !existsSync(capture); i++) await Bun.sleep(5);
      expect(existsSync(capture)).toBe(true);
      const content = readFileSync(capture, "utf8");
      expect(content.length).toBeLessThan(1024);
      expect(JSON.parse(content)).toMatchObject({ version: 1, nonce: "test-nonce", error: "tool_call_limit" });
    } finally {
      abort.abort();
      await client.close();
    }
  });

  test("advertises only the private catalog, rejects unknown tools, and never executes known tools", async () => {
    const dir = mkdtempSync(join(tmpdir(), "opencodex-qoder-mcp-test-"));
    tempDirs.push(dir);
    const catalogPath = join(dir, "tools.json");
    writeFileSync(
      catalogPath,
      JSON.stringify([
        {
          name: "lookup",
          description: "Look up an item.",
          inputSchema: {
            type: "object",
            properties: { id: { type: "number" } },
            required: ["id"],
          },
        },
      ]),
      { mode: 0o600 },
    );

    const transport = new StdioClientTransport({
      command: process.execPath,
      args: [serverPath, catalogPath],
      stderr: "pipe",
    });
    const client = new Client({ name: "qoder-capture-test", version: "1.0.0" });

    try {
      await client.connect(transport);
      expect(client.getServerVersion()?.name).toBe("opencodex-qoder-capture");
      const listed = await client.listTools();
      expect(listed.tools).toEqual([
        {
          name: "lookup",
          description: "Look up an item.",
          inputSchema: {
            type: "object",
            properties: { id: { type: "number" } },
            required: ["id"],
          },
        },
      ]);

      const unknown = await client.callTool(
        { name: "not-advertised", arguments: {} },
        undefined,
        { timeout: 2000 },
      );
      expect(unknown).toMatchObject({
        isError: true,
        content: [{ type: "text", text: "unknown isolated tool" }],
      });

      const abort = new AbortController();
      let settled = false;
      const pending = client.callTool(
        {
          name: "lookup",
          arguments: { id: 7 },
        },
        undefined,
        { signal: abort.signal },
      );
      void pending
        .finally(() => {
          settled = true;
        })
        .catch(() => {});
      await Bun.sleep(50);
      expect(settled).toBe(false);
      abort.abort();
      await expect(pending).rejects.toThrow();
    } finally {
      await client.close();
    }
  });

  test("reads at most the catalog limit plus one byte", async () => {
    const stderr = await rejectedCatalog(
      " ".repeat(QODER_TOOL_LIMITS.maxCatalogBytes + 1),
    );
    expect(stderr).toContain("tool catalog is too large");
  });

  test("revalidates count, unique names, text, and schema boundaries in the helper", async () => {
    let deeplyNested: Record<string, unknown> = { type: "object" };
    for (
      let depth = 0;
      depth <= QODER_TOOL_LIMITS.maxSchemaDepth;
      depth++
    ) {
      deeplyNested = { type: "object", nested: deeplyNested };
    }

    const cases: Array<{ expected: string; value: unknown }> = [
      {
        expected: "too many definitions",
        value: Array.from(
          { length: QODER_TOOL_LIMITS.maxTools + 1 },
          (_, index) => definition(`tool_${index}`),
        ),
      },
      {
        expected: "duplicate names",
        value: [definition("same"), definition("same")],
      },
      {
        expected: "invalid definition",
        value: [definition("invalid name")],
      },
      {
        expected: "invalid definition",
        value: [
          definition("description", {
            description: "d".repeat(
              QODER_TOOL_LIMITS.maxDescriptionBytes + 1,
            ),
          }),
        ],
      },
      {
        expected: "object type",
        value: [definition("wrong_root", { inputSchema: { type: "array" } })],
      },
      {
        expected: "too deeply nested",
        value: [definition("deep", { inputSchema: deeplyNested })],
      },
    ];

    for (const { expected, value } of cases) {
      const stderr = await rejectedCatalog(JSON.stringify(value));
      expect(stderr).toContain(expected);
    }
  });

  test("exits when stdin closes instead of outliving the CLI", async () => {
    // The pinned MCP SDK (1.30.0) does not detect stdin EOF itself. Without the explicit
    // end/close handlers, this capture server would linger as an orphaned bun process
    // whenever the parent terminates the CLI it serves.
    const dir = mkdtempSync(join(tmpdir(), "opencodex-qoder-mcp-eof-"));
    tempDirs.push(dir);
    const catalogPath = join(dir, "tools.json");
    writeFileSync(catalogPath, JSON.stringify([definition("lookup")]), {
      mode: 0o600,
    });
    const child = Bun.spawn({
      cmd: [process.execPath, serverPath, catalogPath],
      stdin: "pipe",
      stdout: "ignore",
      stderr: "ignore",
    });
    child.stdin.end();
    const exit = await Promise.race([
      child.exited,
      Bun.sleep(4_000).then(() => "timeout" as const),
    ]);
    if (exit === "timeout") child.kill();
    expect(exit).toBe(0);
  });

});
