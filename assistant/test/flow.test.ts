/**
 * Tests for card T12, against the real instruction files and the real
 * `docs/WORKFLOW.md`, which this card names the source of truth. The tests
 * parse the document (Nodes table, Edges section, Scripted lines table,
 * variable contract and the instruction drafts) so a change to the workflow
 * that forgets the code — or the other way around — fails here.
 */

import { readFileSync } from "node:fs";

import { describe, expect, it } from "vitest";

import {
  START_NODE_ID,
  buildConversationFlow,
  edgeDefinitions,
  nodeDefinitions,
} from "../flow.ts";
import type { FlowEdge, FlowNode, Instructions, McpToolName, ToolIds } from "../flow.ts";
import { loadInstructions } from "../instructions.ts";

const toolIds: ToolIds = {
  logDisclosure: "tool-log-disclosure-1",
  transfer: "tool-transfer-2",
  hangup: "tool-hangup-3",
};
const instructions = loadInstructions();
const flow = buildConversationFlow({ toolIds, instructions });

const WORKFLOW_MD = readFileSync(new URL("../../docs/WORKFLOW.md", import.meta.url), "utf8");

/** One `##` section of the document, up to the next `##` heading. */
function docSection(title: string): string {
  const marker = `## ${title}`;
  const start = WORKFLOW_MD.indexOf(marker);
  if (start === -1) {
    throw new Error(`docs/WORKFLOW.md has no section: ${title}`);
  }
  const rest = WORKFLOW_MD.slice(start + marker.length);
  const end = rest.search(/^## /m);
  return end === -1 ? rest : rest.slice(0, end);
}

/** The draft inside the ```text fence that follows a `###` heading. */
function instructionDraft(heading: string): string {
  const marker = `### ${heading}`;
  const start = WORKFLOW_MD.indexOf(marker);
  if (start === -1) {
    throw new Error(`docs/WORKFLOW.md has no heading: ${heading}`);
  }
  const fence = /```text\n([\s\S]*?)\n```/.exec(WORKFLOW_MD.slice(start + marker.length));
  if (fence === null) {
    throw new Error(`docs/WORKFLOW.md has no text fence after: ${heading}`);
  }
  return fence[1];
}

/** Markdown table rows, without the header separator line. */
function tableRows(sectionText: string): string[][] {
  return sectionText
    .split("\n")
    .filter((line) => line.trim().startsWith("|") && !/^\|[\s\-:|]+\|$/.test(line.trim()))
    .map((line) =>
      line
        .trim()
        .split("|")
        .slice(1, -1)
        .map((cell) => cell.trim()),
    );
}

/** Backticked tool names in a Nodes-table tools cell; `(stretch)` marks the token before it. */
function parseToolCell(cell: string): { name: string; stretch: boolean }[] {
  const tokens: { name: string; stretch: boolean }[] = [];
  const re = /`([^`]+)`/g;
  let match: RegExpExecArray | null;
  while ((match = re.exec(cell)) !== null) {
    const after = cell.slice(match.index + match[0].length);
    const next = after.indexOf("`");
    const gap = next === -1 ? after : after.slice(0, next);
    tokens.push({ name: match[1], stretch: gap.includes("(stretch)") });
  }
  return tokens;
}

type DocNode = {
  id: string;
  name: string;
  kind: string;
  mode: string | null;
  /** MCP tools the node's instructions name, without the stretch ones. */
  tools: string[];
  /** Every MCP tool the table lists for the node, stretch included. */
  mcpTools: string[];
};

function docNodes(): DocNode[] {
  const nodes: DocNode[] = [];
  for (const row of tableRows(docSection("Nodes"))) {
    const idCell = /^`(n_[^`]+)`$/.exec(row[0]);
    if (idCell === null) {
      continue;
    }
    const typeParts = row[2].split(",").map((part) => part.trim());
    const kind = typeParts[0];
    const toolTokens = parseToolCell(row[3]);
    nodes.push({
      id: idCell[1],
      name: row[1],
      kind,
      mode: kind === "prompt" ? typeParts[1] : null,
      tools: toolTokens.filter((token) => !token.stretch).map((token) => token.name),
      mcpTools: toolTokens.map((token) => token.name),
    });
  }
  return nodes;
}

/** The Scripted lines table: node name to its message. */
function docScriptedLines(): Map<string, string> {
  const lines = new Map<string, string>();
  for (const row of tableRows(docSection("Scripted lines"))) {
    if (row[0] === "Node") {
      continue;
    }
    lines.set(row[0], row[1]);
  }
  return lines;
}

type DocEdge =
  | { kind: "default"; target: string }
  | { kind: "llm"; prompt: string; target: string }
  | { kind: "variable"; variable: string; op: string; value: string; target: string };

/** The Edges section: node name to its edges, in declaration order. */
function docEdges(): Map<string, DocEdge[]> {
  const byNode = new Map<string, DocEdge[]>();
  let current: DocEdge[] | null = null;
  for (const rawLine of docSection("Edges").split("\n")) {
    const line = rawLine.trim();
    const heading = /^\*\*(.+)\*\*$/.exec(line);
    if (heading !== null) {
      current = [];
      byNode.set(heading[1], current);
      continue;
    }
    const parsed = /^\d+\.\s+(.+?)\s+→\s+(.+)$/.exec(line);
    if (parsed === null || current === null) {
      continue;
    }
    const body = parsed[1];
    const target = parsed[2].replace(/\s+\([^)]*\)$/, "").trim();
    if (body === "default") {
      current.push({ kind: "default", target });
      continue;
    }
    const llm = /^LLM\.\s+"(.*)"$/.exec(body);
    if (llm !== null) {
      current.push({ kind: "llm", prompt: llm[1], target });
      continue;
    }
    const comparison = /^`([^`]+)`$/.exec(body);
    const parts = comparison === null ? null : /^(\S+)\s+(==|!=|>=)\s+(.+)$/.exec(comparison[1]);
    if (parts === null) {
      throw new Error(`docs/WORKFLOW.md has an unparseable edge: ${line}`);
    }
    current.push({ kind: "variable", variable: parts[1], op: parts[2], value: parts[3], target });
  }
  return byNode;
}

/** The variable names of the contract table, backticked in its first column. */
function docContractVariables(): Set<string> {
  const variables = new Set<string>();
  for (const row of tableRows(docSection("Variable contract"))) {
    const cell = /^`([^`]+)`$/.exec(row[0]);
    if (cell !== null) {
      variables.add(cell[1]);
    }
  }
  return variables;
}

/** Node names to node ids, per the Nodes table. */
function docNodeIds(): Map<string, string> {
  return new Map(docNodes().map((node) => [node.name, node.id]));
}

function docNodeId(name: string): string {
  const id = docNodeIds().get(name);
  if (id === undefined) {
    throw new Error(`docs/WORKFLOW.md references an unknown node: ${name}`);
  }
  return id;
}

function edgesFrom(nodeId: string): FlowEdge[] {
  return flow.edges.filter((edge) => edge.start_node_id === nodeId);
}

function nodeById(id: string): FlowNode {
  const node = flow.nodes.find((candidate) => candidate.id === id);
  if (node === undefined) {
    throw new Error(`the flow has no node: ${id}`);
  }
  return node;
}

/** The `{{name}}` placeholders of a text, the name up to any `| filter`. */
function placeholdersIn(text: string): string[] {
  const found: string[] = [];
  const re = /\{\{\s*([^}\s|]+)[^}]*\}\}/g;
  let match: RegExpExecArray | null;
  while ((match = re.exec(text)) !== null) {
    found.push(match[1]);
  }
  return found;
}

function namesTool(text: string, tool: string): boolean {
  return new RegExp(`\\b${tool}\\b`).test(text);
}

/** Every message the flow says word for word, from speak nodes and the one tool node message. */
function flowMessages(): { where: string; text: string }[] {
  const messages: { where: string; text: string }[] = [];
  for (const node of flow.nodes) {
    if (node.type === "speak") {
      messages.push({ where: node.id, text: node.message });
    } else if (node.type === "tool" && node.message !== undefined) {
      messages.push({ where: node.id, text: node.message });
    }
  }
  return messages;
}

function flowTexts(): { where: string; text: string }[] {
  return [
    ...flowMessages(),
    ...Object.entries(instructions).map(([key, text]) => ({ where: key, text })),
  ];
}

describe("invariants", () => {
  it("every speak node has exactly one default edge", () => {
    for (const node of flow.nodes) {
      if (node.type !== "speak") {
        continue;
      }
      const defaults = edgesFrom(node.id).filter((edge) => edge.condition.type === "default");
      expect(defaults, node.id).toHaveLength(1);
    }
  });

  it("every tool node with edges has exactly one default edge; End call has none; Transfer has only its default", () => {
    for (const node of flow.nodes) {
      if (node.type !== "tool") {
        continue;
      }
      const outgoing = edgesFrom(node.id);
      const defaults = outgoing.filter((edge) => edge.condition.type === "default");
      if (node.id === "n_end") {
        expect(outgoing, "n_end").toHaveLength(0);
      } else if (node.id === "n_transfer") {
        expect(outgoing, "n_transfer").toHaveLength(1);
        expect(defaults, "n_transfer").toHaveLength(1);
      } else if (outgoing.length > 0) {
        expect(defaults, node.id).toHaveLength(1);
      }
    }
  });

  it("default edges leave only speak and tool nodes", () => {
    for (const edge of flow.edges) {
      if (edge.condition.type !== "default") {
        continue;
      }
      const source = nodeById(edge.start_node_id);
      expect(source.type === "speak" || source.type === "tool", edge.id).toBe(true);
    }
  });

  it("on each node, variable edges come before LLM edges", () => {
    for (const node of flow.nodes) {
      const kinds = edgesFrom(node.id).map((edge) => edge.condition.type);
      const lastVariable = kinds.lastIndexOf("expression");
      const firstLlm = kinds.indexOf("llm");
      expect(lastVariable === -1 || firstLlm === -1 || lastVariable < firstLlm, node.id).toBe(true);
    }
  });

  it("every edge's start and target exist, and every node except Disclosure has an incoming edge", () => {
    const ids = new Set(flow.nodes.map((node) => node.id));
    const incoming = new Map<string, number>();
    for (const edge of flow.edges) {
      expect(ids.has(edge.start_node_id), edge.id).toBe(true);
      expect(edge.target.type, edge.id).toBe("node");
      expect(ids.has(edge.target.node_id), edge.id).toBe(true);
      incoming.set(edge.target.node_id, (incoming.get(edge.target.node_id) ?? 0) + 1);
    }
    for (const node of flow.nodes) {
      if (node.id === START_NODE_ID) {
        continue;
      }
      expect(incoming.get(node.id) ?? 0, node.id).toBeGreaterThan(0);
    }
  });

  it("node and edge ids are unique", () => {
    const nodeIds = flow.nodes.map((node) => node.id);
    expect(new Set(nodeIds).size).toBe(nodeIds.length);
    const edgeIds = flow.edges.map((edge) => edge.id);
    expect(new Set(edgeIds).size).toBe(edgeIds.length);
  });
});

describe("payload", () => {
  it("starts at n_disclosure and has the 13 nodes of the Nodes table, in order", () => {
    expect(flow.start_node_id).toBe("n_disclosure");
    const doc = docNodes();
    expect(doc).toHaveLength(13);
    expect(flow.nodes).toHaveLength(13);
    flow.nodes.forEach((node, index) => {
      expect({ id: node.id, name: node.name, type: node.type }, `node ${index + 1}`).toEqual({
        id: doc[index].id,
        name: doc[index].name,
        type: doc[index].kind,
      });
    });
  });

  it("every prompt node sets the table's instructions_mode explicitly and carries no tool fields", () => {
    for (const node of flow.nodes) {
      if (node.type !== "prompt") {
        continue;
      }
      const doc = docNodes().find((candidate) => candidate.id === node.id);
      expect(node.instructions_mode, node.id).toBe(doc?.mode === "replace" ? "replace" : "append");
      expect(Object.keys(node).sort(), node.id).toEqual([
        "id",
        "instructions",
        "instructions_mode",
        "name",
        "type",
      ]);
      expect(node).not.toHaveProperty("shared_tool_ids");
      expect(node).not.toHaveProperty("tools_mode");
      expect(node.instructions, node.id).not.toHaveLength(0);
    }
  });

  it("speak and tool nodes carry only the documented fields", () => {
    for (const node of flow.nodes) {
      if (node.type === "speak") {
        expect(Object.keys(node).sort(), node.id).toEqual(["id", "message", "name", "type"]);
      }
      if (node.type === "tool") {
        const keys = node.id === "n_end"
          ? ["id", "message", "name", "shared_tool_id", "type"]
          : ["id", "name", "shared_tool_id", "type"];
        expect(Object.keys(node).sort(), node.id).toEqual(keys);
      }
    }
  });

  it("the three tool nodes carry the ids passed in, and End call says its line", () => {
    expect(nodeById("n_route")).toMatchObject({ type: "tool", shared_tool_id: toolIds.logDisclosure });
    expect(nodeById("n_transfer")).toMatchObject({ type: "tool", shared_tool_id: toolIds.transfer });
    expect(nodeById("n_end")).toMatchObject({
      type: "tool",
      shared_tool_id: toolIds.hangup,
      message: "Thanks for calling Duinvezel. Goodbye.",
    });
    expect(nodeById("n_route")).not.toHaveProperty("message");
    expect(nodeById("n_transfer")).not.toHaveProperty("message");
  });

  it("variable edges carry a string literal for the \"true\" comparisons and a number literal for the duration, never a boolean", () => {
    const expressions = flow.edges.filter((edge) => edge.condition.type === "expression");
    expect(expressions.length).toBeGreaterThan(0);
    for (const edge of expressions) {
      if (edge.condition.type !== "expression") {
        continue;
      }
      const { left, right } = edge.condition.expression;
      if (left.name === "telnyx_conversation_duration_secs") {
        expect(right, edge.id).toEqual({ type: "number_literal", value: 300 });
      } else {
        expect(right, edge.id).toEqual({ type: "string_literal", value: "true" });
      }
    }
  });
});

describe("against docs/WORKFLOW.md", () => {
  it("each scripted line appears word for word as its node's message, and no other node has one", () => {
    const scripted = docScriptedLines();
    expect(scripted.size).toBe(4);
    for (const [nodeName, message] of scripted) {
      expect(flowMessages().find((entry) => entry.where === docNodeId(nodeName))?.text, nodeName).toBe(
        message,
      );
    }
    expect(flowMessages().map((entry) => entry.where).sort()).toEqual(
      [...scripted.keys()].map((name) => docNodeId(name)).sort(),
    );
  });

  it("each edge matches the document's Edges section, in each node's declaration order", () => {
    for (const [nodeName, docList] of docEdges()) {
      const built = edgesFrom(docNodeId(nodeName));
      expect(built.length, `edge count of ${nodeName}`).toBe(docList.length);
      docList.forEach((docEdge, index) => {
        const label = `edge ${index + 1} from ${nodeName}`;
        const edge = built[index];
        expect(edge.target, label).toEqual({ type: "node", node_id: docNodeId(docEdge.target) });
        if (docEdge.kind === "default") {
          expect(edge.condition, label).toEqual({ type: "default" });
        } else if (docEdge.kind === "llm") {
          expect(edge.condition, label).toEqual({ type: "llm", prompt: docEdge.prompt });
        } else {
          expect(edge.condition, label).toEqual({
            type: "expression",
            expression: {
              type: "comparison",
              op: docEdge.op,
              left: { type: "variable", name: docEdge.variable },
              right: docEdge.value.startsWith('"')
                ? { type: "string_literal", value: docEdge.value.slice(1, -1) }
                : { type: "number_literal", value: Number(docEdge.value) },
            },
          });
        }
      });
    }
    // End call is the one node the Edges section never lists, and it has none.
    expect(edgesFrom("n_end")).toHaveLength(0);
  });

  const INSTRUCTION_FILES: [keyof Instructions, string, string][] = [
    ["base", "base.md", "Base instructions (assistant level)"],
    ["verify", "verify.md", "Verify account (append)"],
    ["outageHelp", "outage-help.md", "Outage help (append)"],
    ["triage", "triage.md", "Triage (append)"],
    ["diagnose", "diagnose.md", "Diagnose (append)"],
    ["repairTicket", "repair-ticket.md", "Repair ticket (append)"],
    ["takeMessage", "take-message.md", "Take message (append)"],
    ["degraded", "degraded.md", "Degraded (replace)"],
  ];

  it("each instruction file equals its draft, without the heading or the code fence", () => {
    for (const [, file, heading] of INSTRUCTION_FILES) {
      const content = readFileSync(new URL(`../instructions/${file}`, import.meta.url), "utf8");
      expect(content, file).toBe(`${instructionDraft(heading)}\n`);
    }
  });

  it("loadInstructions returns each draft without trailing whitespace", () => {
    for (const [key, , heading] of INSTRUCTION_FILES) {
      expect(instructions[key], key).toBe(instructionDraft(heading));
      expect(/\s$/.test(instructions[key]), key).toBe(false);
    }
  });

  it("each prompt node's tool data equals its Nodes-table entry, without the stretch tools", () => {
    const docById = new Map(docNodes().map((node) => [node.id, node]));
    for (const def of nodeDefinitions) {
      if (def.kind !== "prompt") {
        continue;
      }
      const doc = docById.get(def.id);
      if (doc === undefined) {
        throw new Error(`no Nodes-table entry for ${def.id}`);
      }
      expect([...def.tools], def.name).toEqual(doc.tools);
    }
  });

  it("each prompt node's instructions name every tool of its entry and no other MCP tool, as whole words; base.md names none", () => {
    const mcpTools = new Set(docNodes().flatMap((node) => node.mcpTools));
    expect(mcpTools.size).toBe(6);
    for (const def of nodeDefinitions) {
      if (def.kind !== "prompt") {
        continue;
      }
      const text = instructions[def.instructionsKey];
      for (const tool of mcpTools) {
        expect(namesTool(text, tool), `${def.name} naming ${tool}`).toBe(
          def.tools.includes(tool as McpToolName),
        );
      }
    }
    for (const tool of mcpTools) {
      expect(namesTool(instructions.base, tool), `base naming ${tool}`).toBe(false);
    }
  });
});

describe("the built flow's links to the inputs", () => {
  it("each prompt node carries its instruction file's text", () => {
    for (const def of nodeDefinitions) {
      if (def.kind !== "prompt") {
        continue;
      }
      const node = nodeById(def.id);
      if (node.type !== "prompt") {
        throw new Error(`${def.id} is not a prompt node`);
      }
      expect(node.instructions, def.id).toBe(instructions[def.instructionsKey]);
    }
  });

  it("the built edges are the definitions, one for one and in order", () => {
    expect(flow.edges.length).toBe(edgeDefinitions.length);
    flow.edges.forEach((edge, index) => {
      expect(edge.id).toBe(edgeDefinitions[index].id);
      expect(edge.start_node_id).toBe(edgeDefinitions[index].from);
      expect(edge.target.node_id).toBe(edgeDefinitions[index].to);
    });
  });
});

describe("variables", () => {
  it("every {{variable}} in a message or an instruction is in the variable contract or starts with telnyx_", () => {
    const contract = docContractVariables();
    const seen = new Set<string>();
    for (const { where, text } of flowTexts()) {
      for (const name of placeholdersIn(text)) {
        seen.add(name);
        expect(contract.has(name) || name.startsWith("telnyx_"), `${where} uses {{${name}}}`).toBe(true);
      }
    }
    expect(seen.size).toBeGreaterThan(0);
  });

  it("base.md contains {{name}} for every variable that a variable edge reads, apart from telnyx_*", () => {
    const read = new Set<string>();
    for (const edge of flow.edges) {
      if (edge.condition.type === "expression") {
        read.add(edge.condition.expression.left.name);
      }
    }
    expect(read.size).toBe(6);
    for (const name of read) {
      if (name.startsWith("telnyx_")) {
        continue;
      }
      expect(instructions.base.includes(`{{${name}}}`), name).toBe(true);
    }
  });

  it("no message or instruction contains session_id or mcp_token", () => {
    for (const { where, text } of flowTexts()) {
      expect(text.includes("session_id"), where).toBe(false);
      expect(text.includes("mcp_token"), where).toBe(false);
    }
  });
});
