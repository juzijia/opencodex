import { describe, expect, test } from "bun:test";
import {
  CODEBUDDY_MCP_TOOL_PREFIX as QODER_MCP_TOOL_PREFIX,
  CODEBUDDY_TOOL_LIMITS as QODER_TOOL_LIMITS,
  buildToolBridge as buildQoderToolBridge,
  codeBuddyToolAlias as qoderToolAlias,
} from "../../src/adapters/coding-agent/tool-bridge";
import type { OcxParsedRequest, OcxTool, OcxToolChoice } from "../../src/types";

function tool(name: string, options: Partial<OcxTool> = {}): OcxTool {
  return {
    name,
    description: `Description for ${name}`,
    parameters: { type: "object", properties: {} },
    ...options,
  };
}

function parsed(
  tools: OcxTool[],
  toolChoice?: OcxToolChoice,
): OcxParsedRequest {
  return {
    modelId: "Qwen3.8-Flash",
    context: {
      messages: [{ role: "user", content: "Use a tool", timestamp: 1 }],
      tools,
    },
    stream: true,
    options: { toolChoice },
  };
}

function wireNames(request: OcxParsedRequest): string[] {
  return [...buildQoderToolBridge(request).emittedNameMap.values()];
}

function wireToAlias(request: OcxParsedRequest): Map<string, string> {
  return new Map(
    [...buildQoderToolBridge(request).emittedNameMap].map(([emitted, wire]) => [
      wire,
      emitted.slice(QODER_MCP_TOOL_PREFIX.length),
    ]),
  );
}

describe("Qoder capture-only tool choice", () => {
  const catalog = [tool("plain"), tool("lookup", { namespace: "mcp__alpha" })];

  test("supports auto, none, and required", () => {
    const automatic = buildQoderToolBridge(parsed(catalog, "auto"));
    expect([...automatic.emittedNameMap.values()]).toEqual([
      "plain",
      "mcp__alpha__lookup",
    ]);
    expect(automatic.requireToolCall).toBe(false);

    const none = buildQoderToolBridge(parsed(catalog, "none"));
    expect(none.tools).toEqual([]);
    expect(none.emittedNameMap.size).toBe(0);
    expect(none.requireToolCall).toBe(false);

    const required = buildQoderToolBridge(parsed(catalog, "required"));
    expect([...required.emittedNameMap.values()]).toEqual([
      "plain",
      "mcp__alpha__lookup",
    ]);
    expect(required.requireToolCall).toBe(true);
  });

  test("applies none before validating an unadvertised oversized or malformed catalog", () => {
    const ignored = Array.from(
      { length: QODER_TOOL_LIMITS.maxTools + 1 },
      (_, index) =>
        tool(`ignored_${index}`, {
          description:
            index === 0
              ? "d".repeat(QODER_TOOL_LIMITS.maxDescriptionBytes + 1)
              : `Ignored ${index}`,
          parameters:
            index === 1
              ? { type: "array" }
              : { type: "object", properties: {} },
        }),
    );

    const bridge = buildQoderToolBridge(parsed(ignored, "none"));
    expect(bridge.tools).toEqual([]);
    expect(bridge.emittedNameMap.size).toBe(0);
    expect(bridge.requireToolCall).toBe(false);
  });

  test("validates only definitions selected by named and allowed-tools choices", () => {
    const selected = tool("selected");
    const ignored = [
      null as unknown as OcxTool,
      tool("invalid name"),
      tool("bad_description", {
        description: "d".repeat(QODER_TOOL_LIMITS.maxDescriptionBytes + 1),
      }),
      tool("bad_schema", { parameters: { type: "array" } }),
      ...Array.from({ length: QODER_TOOL_LIMITS.maxTools }, (_, index) =>
        tool(`extra_${index}`),
      ),
    ];

    const named = buildQoderToolBridge(
      parsed([selected, ...ignored], { name: "selected" }),
    );
    expect([...named.emittedNameMap.values()]).toEqual(["selected"]);
    expect(named.requireToolCall).toBe(true);

    const allowed = buildQoderToolBridge(
      parsed([selected, ...ignored], {
        allowedTools: ["selected"],
        mode: "auto",
      }),
    );
    expect([...allowed.emittedNameMap.values()]).toEqual(["selected"]);
    expect(allowed.requireToolCall).toBe(false);

    expect(() =>
      buildQoderToolBridge(
        parsed([selected, ...ignored], {
          name: "bad_schema",
        }),
      ),
    ).toThrow("invalid input schema");
  });

  test("supports named selectors including the unique bare namespaced shorthand", () => {
    for (const name of ["lookup", "mcp__alpha.lookup", "mcp__alpha__lookup"]) {
      const bridge = buildQoderToolBridge(parsed(catalog, { name }));
      expect([...bridge.emittedNameMap.values()]).toEqual([
        "mcp__alpha__lookup",
      ]);
      expect(bridge.requireToolCall).toBe(true);
    }

    expect(() =>
      buildQoderToolBridge(parsed(catalog, { name: "missing" })),
    ).toThrow("tool_choice requires a tool");
  });

  test("supports allowed_tools in auto and required modes", () => {
    const automatic = buildQoderToolBridge(
      parsed(catalog, {
        allowedTools: ["plain"],
        mode: "auto",
      }),
    );
    expect([...automatic.emittedNameMap.values()]).toEqual(["plain"]);
    expect(automatic.requireToolCall).toBe(false);

    const required = buildQoderToolBridge(
      parsed(catalog, {
        allowedTools: ["lookup"],
        mode: "required",
      }),
    );
    expect([...required.emittedNameMap.values()]).toEqual([
      "mcp__alpha__lookup",
    ]);
    expect(required.requireToolCall).toBe(true);

    const noMatch = buildQoderToolBridge(
      parsed(catalog, {
        allowedTools: ["missing"],
        mode: "auto",
      }),
    );
    expect(noMatch.tools).toEqual([]);
    expect(() =>
      buildQoderToolBridge(
        parsed(catalog, {
          allowedTools: ["missing"],
          mode: "required",
        }),
      ),
    ).toThrow("tool_choice requires a tool");
  });

  test("fails closed for ambiguous bare selectors", () => {
    const ambiguous = [
      tool("lookup", { namespace: "mcp__alpha" }),
      tool("lookup", { namespace: "mcp__beta" }),
    ];
    expect(
      wireNames(
        parsed(ambiguous, {
          allowedTools: ["lookup"],
          mode: "auto",
        }),
      ),
    ).toEqual([]);
    expect(() =>
      buildQoderToolBridge(parsed(ambiguous, { name: "lookup" })),
    ).toThrow("tool_choice requires a tool");
    expect(wireNames(parsed(ambiguous, { name: "mcp__beta.lookup" }))).toEqual([
      "mcp__beta__lookup",
    ]);
  });
});

describe("Qoder tool aliases", () => {
  test("are deterministic, collision-safe, and reversibly mapped", () => {
    const unsafeWireName = "unsafe.name";
    const firstHashedCandidate = qoderToolAlias(unsafeWireName);
    const catalog = [
      tool(unsafeWireName),
      tool(firstHashedCandidate),
      tool("unsafe/name"),
      tool("x".repeat(80)),
    ];

    const forward = wireToAlias(parsed(catalog));
    const reverseOrder = wireToAlias(parsed([...catalog].reverse()));
    expect([...forward].sort()).toEqual([...reverseOrder].sort());
    expect(forward.get(firstHashedCandidate)).toBe(firstHashedCandidate);
    expect(forward.get(unsafeWireName)).not.toBe(firstHashedCandidate);
    expect(new Set(forward.values()).size).toBe(catalog.length);

    for (const [wireName, alias] of forward) {
      expect(alias).toMatch(/^[A-Za-z0-9_-]{1,40}$/);
      const bridge = buildQoderToolBridge(parsed(catalog));
      expect(
        bridge.emittedNameMap.get(`${QODER_MCP_TOOL_PREFIX}${alias}`),
      ).toBe(wireName);
    }
  });

  test("rejects duplicate source wire names instead of inventing an ambiguous mapping", () => {
    expect(() =>
      buildQoderToolBridge(parsed([tool("same"), tool("same")])),
    ).toThrow("duplicate wire name");
  });
});

describe("Qoder JSON Schema boundary", () => {
  test("preserves a normal complex schema and strips only Responses-private encrypted markers", () => {
    const parameters = {
      $schema: "https://json-schema.org/draft/2020-12/schema",
      type: "object",
      $defs: {
        address: {
          type: "object",
          properties: {
            city: { type: "string", minLength: 1 },
            postcode: { type: "string", pattern: "^[0-9]{5}$" },
          },
          required: ["city"],
          additionalProperties: false,
        },
      },
      properties: {
        address: { $ref: "#/$defs/address" },
        mode: { oneOf: [{ const: "fast" }, { const: "safe" }] },
        tags: {
          type: "array",
          prefixItems: [{ type: "string" }],
          items: { type: "string", pattern: "^[a-z]+$" },
          minItems: 1,
          maxItems: 5,
          uniqueItems: true,
        },
        metadata: {
          type: "object",
          patternProperties: {
            "^x-": { type: ["string", "number", "boolean", "null"] },
          },
          additionalProperties: false,
        },
        encrypted: { type: "string", encrypted: true },
        payload: { type: "object", default: { encrypted: true } },
      },
      required: ["address", "mode"],
      dependentRequired: { address: ["mode"] },
      if: { properties: { mode: { const: "fast" } } },
      then: { properties: { tags: { minItems: 2 } } },
      else: { properties: { tags: { maxItems: 2 } } },
      additionalProperties: false,
      encrypted: true,
    };
    const bridge = buildQoderToolBridge(
      parsed([tool("complex", { parameters })]),
    );
    const schema = bridge.tools[0].inputSchema as typeof parameters;

    expect(schema.$defs).toEqual(parameters.$defs);
    expect(schema.properties.address).toEqual({ $ref: "#/$defs/address" });
    expect(schema.properties.mode).toEqual(parameters.properties.mode);
    expect(schema.properties.tags).toEqual(parameters.properties.tags);
    expect(schema.properties.metadata).toEqual(parameters.properties.metadata);
    expect(schema.properties.encrypted).toEqual({ type: "string" });
    expect(schema.properties.payload.default).toEqual({ encrypted: true });
    expect(Object.hasOwn(schema, "encrypted")).toBe(false);
    expect(parameters.encrypted).toBe(true);
    expect(parameters.properties.encrypted.encrypted).toBe(true);
  });
  test("validates Bash tool schema with command and description properties", () => {
    const bashTool: OcxTool = {
      name: "Bash",
      description: "Execute a bash command in the terminal",
      parameters: {
        type: "object",
        properties: {
          command: { type: "string", description: "The command to execute" },
          description: {
            type: "string",
            description: "Reason for executing command",
          },
        },
        required: ["command"],
      },
    };
    const bridge = buildQoderToolBridge(parsed([bashTool]));
    expect(bridge.tools).toHaveLength(1);
    expect(bridge.tools[0].name).toBe("Bash");
    expect(bridge.tools[0].description).toBe(
      "Execute a bash command in the terminal",
    );
    expect(bridge.tools[0].inputSchema).toEqual(
      bashTool.parameters as Record<string, unknown>,
    );
    expect(bridge.emittedNameMap.get(`${QODER_MCP_TOOL_PREFIX}Bash`)).toBe(
      "Bash",
    );
  });

  test("adds the MCP-required root object type without mutating the source", () => {
    const parameters = {
      properties: { value: { type: "integer", minimum: 0 } },
      required: ["value"],
    };
    const schema = buildQoderToolBridge(
      parsed([tool("normalize", { parameters })]),
    ).tools[0].inputSchema;
    expect(schema).toEqual({ ...parameters, type: "object" });
    expect(Object.hasOwn(parameters, "type")).toBe(false);
  });

  test.each([
    ["non-object root", { type: "array", items: { type: "string" } }],
    [
      "unknown type",
      { type: "object", properties: { value: { type: "mystery" } } },
    ],
    ["malformed properties", { type: "object", properties: [] }],
    ["empty composition", { type: "object", allOf: [] }],
    [
      "invalid regex",
      { type: "object", patternProperties: { "[": { type: "string" } } },
    ],
    [
      "external reference",
      {
        type: "object",
        properties: { value: { $ref: "https://example.com/schema" } },
      },
    ],
    ["non-JSON value", { type: "object", default: undefined }],
  ])("rejects %s schemas", (_label, parameters) => {
    expect(() =>
      buildQoderToolBridge(
        parsed([
          tool("invalid", {
            parameters: parameters as Record<string, unknown>,
          }),
        ]),
      ),
    ).toThrow("invalid input schema");
  });

  test("rejects cyclic and accessor-bearing schemas before serialization", () => {
    const cyclic: Record<string, unknown> = { type: "object" };
    cyclic.self = cyclic;
    expect(() =>
      buildQoderToolBridge(parsed([tool("cyclic", { parameters: cyclic })])),
    ).toThrow(/invalid input schema.*cycles/);

    const accessor: Record<string, unknown> = { type: "object" };
    Object.defineProperty(accessor, "properties", {
      enumerable: true,
      get: () => ({ value: { type: "string" } }),
    });
    expect(() =>
      buildQoderToolBridge(
        parsed([tool("accessor", { parameters: accessor })]),
      ),
    ).toThrow(/invalid input schema.*data properties/);
  });

  test("preserves prototype-shaped property names as inert data", () => {
    const properties = JSON.parse(
      '{"__proto__":{"type":"string"},"constructor":{"type":"number"}}',
    );
    const schema = buildQoderToolBridge(
      parsed([
        tool("prototype_names", { parameters: { type: "object", properties } }),
      ]),
    ).tools[0].inputSchema;
    const emitted = schema.properties as Record<string, unknown>;
    expect(Object.hasOwn(emitted, "__proto__")).toBe(true);
    expect(emitted.__proto__).toEqual({ type: "string" });
    expect(emitted.constructor).toEqual({ type: "number" });
  });
});

describe("Qoder tool catalog limits", () => {
  test("bounds tool count, name bytes, and description bytes", () => {
    const tooMany = Array.from(
      { length: QODER_TOOL_LIMITS.maxTools + 1 },
      (_, index) => tool(`tool_${index}`),
    );
    expect(() => buildQoderToolBridge(parsed(tooMany))).toThrow("tool limit");

    const oversizedName = "é".repeat(
      Math.floor(QODER_TOOL_LIMITS.maxNameBytes / 2) + 1,
    );
    expect(() => buildQoderToolBridge(parsed([tool(oversizedName)]))).toThrow(
      "name exceeds",
    );

    const oversizedDescription = "d".repeat(
      QODER_TOOL_LIMITS.maxDescriptionBytes + 1,
    );
    expect(() =>
      buildQoderToolBridge(
        parsed([
          tool("large_description", { description: oversizedDescription }),
        ]),
      ),
    ).toThrow("description exceeds");
  });

  test("bounds schema depth and node count before JSON serialization", () => {
    let tooDeep: Record<string, unknown> = { type: "string" };
    for (let depth = 0; depth <= QODER_TOOL_LIMITS.maxSchemaDepth; depth++) {
      tooDeep = { nested: tooDeep };
    }
    expect(() =>
      buildQoderToolBridge(
        parsed([
          tool("deep", { parameters: { type: "object", extension: tooDeep } }),
        ]),
      ),
    ).toThrow(/invalid input schema.*too deep/);

    const tooManyNodes = Array.from(
      { length: QODER_TOOL_LIMITS.maxSchemaNodes },
      (_, index) => `value_${index}`,
    );
    expect(() =>
      buildQoderToolBridge(
        parsed([
          tool("nodes", { parameters: { type: "object", enum: tooManyNodes } }),
        ]),
      ),
    ).toThrow(/invalid input schema.*node count/);
  });

  test("bounds schema, individual definition, and aggregate catalog bytes independently", () => {
    expect(() =>
      buildQoderToolBridge(
        parsed([
          tool("large_schema", {
            parameters: {
              type: "object",
              $comment: "s".repeat(QODER_TOOL_LIMITS.maxSchemaBytes),
            },
          }),
        ]),
      ),
    ).toThrow(/invalid input schema.*schema exceeds/);

    expect(() =>
      buildQoderToolBridge(
        parsed([
          tool("large_definition", {
            description: "d".repeat(60 * 1024),
            parameters: { type: "object", $comment: "s".repeat(200 * 1024) },
          }),
        ]),
      ),
    ).toThrow("definition exceeds");

    const aggregate = Array.from({ length: 40 }, (_, index) =>
      tool(`aggregate_${index}`, { description: "d".repeat(55 * 1024) }),
    );
    expect(() => buildQoderToolBridge(parsed(aggregate))).toThrow(
      "catalog exceeds",
    );
  });
});
