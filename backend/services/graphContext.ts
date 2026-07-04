// Builds issue-specific repo context from a Graphify knowledge graph.
// Runs `graphify extract` (local AST pass, no API calls for code), parses
// graphify-out/graph.json, selects the subgraph relevant to the issue, and
// renders it as NODE/EDGE lines per docs/fable/07-graphify-context-prompt.md.

import { execFile } from "node:child_process";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";
import type { SourceFile } from "./repo.js";

const execFileAsync = promisify(execFile);

const EXTRACT_TIMEOUT_MS = 180_000;
const MAX_SEED_NODES = 20;
const MAX_NODES = 60;
const MAX_EDGES = 120;
const MAX_FILES = 5;
const MAX_FILE_CHARS = 8_000;

const STOPWORDS = new Set([
  "the", "and", "for", "with", "that", "this", "when", "then", "but", "not",
  "are", "was", "were", "has", "have", "had", "does", "did", "can", "cannot",
  "should", "would", "could", "into", "from", "after", "before", "there",
  "here", "what", "which", "will", "its", "it's", "your", "you", "our",
  "they", "them", "their", "been", "being", "because", "about", "issue",
  "bug", "error", "problem", "expected", "actual", "steps", "reproduce",
]);

export type GraphContext = {
  available: boolean;
  graphNodes: string;
  graphEdges: string;
  relevantFiles: SourceFile[];
  notes: string;
};

type GraphNode = {
  id: string;
  label?: string;
  file_type?: string;
  source_file?: string;
  source_location?: string;
  community?: number;
};

type GraphEdge = {
  source: string;
  target: string;
  relation?: string;
  confidence?: string;
};

type Graph = {
  nodes: GraphNode[];
  links: GraphEdge[];
};

export async function buildGraphContext(input: {
  repoPath: string;
  issueTitle: string;
  issueBody: string;
}): Promise<GraphContext> {
  try {
    await runGraphifyExtract(input.repoPath);
    const graph = await readGraph(input.repoPath);

    return await selectContext(graph, input);
  } catch (error) {
    return {
      available: false,
      graphNodes: "",
      graphEdges: "",
      relevantFiles: [],
      notes: `Graphify context unavailable: ${formatError(error)}`,
    };
  }
}

async function runGraphifyExtract(repoPath: string) {
  // Code-only extraction is fully local (tree-sitter AST); no API key needed.
  await execFileAsync("graphify", ["extract", ".", "--no-viz"], {
    cwd: repoPath,
    timeout: EXTRACT_TIMEOUT_MS,
    maxBuffer: 16 * 1024 * 1024,
  });
}

async function readGraph(repoPath: string): Promise<Graph> {
  const graphPath = path.join(repoPath, "graphify-out", "graph.json");
  const raw = await readFile(graphPath, "utf8");
  const parsed = JSON.parse(raw) as Partial<Graph>;

  if (!Array.isArray(parsed.nodes) || !Array.isArray(parsed.links)) {
    throw new Error("graph.json is missing nodes/links arrays.");
  }

  return { nodes: parsed.nodes, links: parsed.links };
}

async function selectContext(
  graph: Graph,
  input: { repoPath: string; issueTitle: string; issueBody: string },
): Promise<GraphContext> {
  const terms = tokenize(`${input.issueTitle} ${input.issueBody}`);
  const scores = scoreNodes(graph.nodes, terms);

  let seedIds = [...scores.entries()]
    .filter(([, score]) => score > 0)
    .sort((a, b) => b[1] - a[1])
    .slice(0, MAX_SEED_NODES)
    .map(([id]) => id);

  let notes = `Selected ${seedIds.length} seed nodes from issue terms.`;

  if (seedIds.length === 0) {
    seedIds = topDegreeNodeIds(graph, MAX_SEED_NODES);
    notes =
      "No graph nodes matched the issue terms; falling back to the most-connected nodes.";
  }

  const selectedIds = expandNeighbors(graph, seedIds);
  const selectedNodes = graph.nodes.filter((node) => selectedIds.has(node.id));
  const selectedEdges = graph.links
    .filter((edge) => selectedIds.has(edge.source) && selectedIds.has(edge.target))
    .slice(0, MAX_EDGES);

  const labelById = new Map(
    graph.nodes.map((node) => [node.id, node.label ?? node.id]),
  );

  const graphNodes = selectedNodes
    .slice(0, MAX_NODES)
    .map((node) => renderNode(node))
    .join("\n");

  const graphEdges = selectedEdges
    .map((edge) => renderEdge(edge, labelById))
    .join("\n");

  const relevantFiles = await hydrateFiles(
    input.repoPath,
    rankFiles(selectedNodes, scores),
  );

  return {
    available: true,
    graphNodes,
    graphEdges,
    relevantFiles,
    notes,
  };
}

function tokenize(text: string): string[] {
  const tokens = text
    .toLowerCase()
    .split(/[^a-z0-9_]+/)
    .filter((token) => token.length >= 3 && !STOPWORDS.has(token));

  return [...new Set(tokens)];
}

function scoreNodes(nodes: GraphNode[], terms: string[]): Map<string, number> {
  const scores = new Map<string, number>();

  for (const node of nodes) {
    const label = (node.label ?? "").toLowerCase();
    const id = node.id.toLowerCase();
    const sourceFile = (node.source_file ?? "").toLowerCase();
    let score = 0;

    for (const term of terms) {
      if (label.includes(term)) score += 3;
      if (id.includes(term)) score += 2;
      if (sourceFile.includes(term)) score += 1;
    }

    scores.set(node.id, score);
  }

  return scores;
}

function topDegreeNodeIds(graph: Graph, limit: number): string[] {
  const degree = new Map<string, number>();

  for (const edge of graph.links) {
    degree.set(edge.source, (degree.get(edge.source) ?? 0) + 1);
    degree.set(edge.target, (degree.get(edge.target) ?? 0) + 1);
  }

  return [...degree.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, limit)
    .map(([id]) => id);
}

function expandNeighbors(graph: Graph, seedIds: string[]): Set<string> {
  const selected = new Set(seedIds);

  for (const edge of graph.links) {
    if (selected.size >= MAX_NODES) break;

    if (selected.has(edge.source) && !selected.has(edge.target)) {
      selected.add(edge.target);
    } else if (selected.has(edge.target) && !selected.has(edge.source)) {
      selected.add(edge.source);
    }
  }

  return selected;
}

function renderNode(node: GraphNode): string {
  const location = [node.source_file ?? "unknown", node.source_location]
    .filter(Boolean)
    .join(":");
  const community = node.community === undefined ? "" : ` | community=${node.community}`;

  return `NODE ${node.label ?? node.id} | ${location}${community}`;
}

function renderEdge(edge: GraphEdge, labelById: Map<string, string>): string {
  const source = labelById.get(edge.source) ?? edge.source;
  const target = labelById.get(edge.target) ?? edge.target;
  const confidence = edge.confidence ?? "UNKNOWN";

  return `EDGE ${source} --${edge.relation ?? "related_to"}--> ${target} [${confidence}]`;
}

function rankFiles(
  selectedNodes: GraphNode[],
  scores: Map<string, number>,
): string[] {
  const fileScores = new Map<string, number>();

  for (const node of selectedNodes) {
    if (!node.source_file) continue;

    const current = fileScores.get(node.source_file) ?? 0;
    fileScores.set(node.source_file, current + 1 + (scores.get(node.id) ?? 0));
  }

  return [...fileScores.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, MAX_FILES)
    .map(([file]) => file);
}

async function hydrateFiles(
  repoPath: string,
  files: string[],
): Promise<SourceFile[]> {
  const resolvedRepo = path.resolve(repoPath);
  const results: SourceFile[] = [];

  for (const file of files) {
    const cleaned = file.replace(/^\.\//, "");
    const resolved = path.resolve(resolvedRepo, cleaned);

    // Never read outside the cloned repo.
    if (!resolved.startsWith(resolvedRepo + path.sep)) {
      continue;
    }

    try {
      const contents = await readFile(resolved, "utf8");

      results.push({
        path: cleaned,
        contents: contents.slice(0, MAX_FILE_CHARS),
        truncated: contents.length > MAX_FILE_CHARS,
      });
    } catch {
      // Skip unreadable files; the graph pointer is still in the NODE lines.
    }
  }

  return results;
}

function formatError(error: unknown) {
  if (error instanceof Error) {
    return error.message;
  }

  return String(error);
}
