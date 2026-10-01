/**
 * @payswap/protocol — the Value Conversion Graph (W1-003).
 *
 * FROZEN-ARCHITECTURE §10: "Every rail/currency pair is a graph node/edge
 * capability with quote, fee, latency, reliability, liquidity requirements,
 * compliance requirements, finality, reversibility/recourse, proof
 * requirement, capacity and provenance."
 *
 * Nodes are rail/currency pairs (`ConversionNode`, e.g. `MOBILE_MONEY:GHS`);
 * edges are conversion capabilities between two nodes carrying the full §10
 * descriptor set. An edge embeds an optional exact `FxQuote` (same-currency
 * rail hops need none) — the quote travels WITH the edge so route
 * evaluation can never lose FX provenance (INV-F09).
 *
 * `findRoutes` is deterministic route enumeration: DFS over
 * deterministically sorted adjacency (from, to, edgeId), simple paths only
 * (no repeated nodes), bounded by injected limits (`maxHops`, `maxRoutes`),
 * results ordered by (hops, edge-id sequence) and truncated to `maxRoutes`.
 * The same graph + limits always produce byte-identical output.
 *
 * This module is a CONTRACT: it enumerates and describes, it never executes
 * rails, mints balances or fabricates availability.
 */

import { type CurrencyCode, type Money } from './money.js';
import { ValidationError } from './errors.js';
import { InvalidIdentifierError } from './identifiers.js';
import type { FxQuote } from './fx.js';
import { asFxQuoteId } from './fx.js';

declare const ConversionNodeIdBrand: unique symbol;

/** Branded id of one graph node (a rail/currency pair). */
export type ConversionNodeId = string & { readonly [ConversionNodeIdBrand]: 'ConversionNodeId' };

declare const ConversionEdgeIdBrand: unique symbol;

/** Branded id of one conversion edge. */
export type ConversionEdgeId = string & { readonly [ConversionEdgeIdBrand]: 'ConversionEdgeId' };

/** Observed reliability of a conversion capability. */
export type ReliabilityClass = 'HIGH' | 'MEDIUM' | 'LOW';

/** Liquidity depth requirement to use the edge. */
export type LiquidityRequirementClass = 'DEEP' | 'ADEQUATE' | 'THIN';

/** Finality semantics of the conversion. */
export type FinalityClass = 'IMMEDIATE' | 'SAME_DAY' | 'NEXT_DAY' | 'DELAYED';

/** Reversibility/recourse semantics (FROZEN §10). */
export type ReversibilityClass = 'IRREVERSIBLE' | 'REVERSIBLE_WITHIN_WINDOW' | 'REVERSIBLE';

/** Proof required to consider the conversion final (INV-E03 adjacent). */
export type ProofRequirement = 'RAIL_PROOF' | 'SIGNED_RECEIPT' | 'MERKLE_ATTESTATION' | 'NONE';

/** How the edge's descriptors came to be known. */
export interface ConversionEdgeProvenance {
  /** Descriptor source, e.g. `capability-catalog:connector-x`. */
  readonly source: string;
  /** Reference to the underlying catalogue/certification record. */
  readonly reference: string;
  readonly recordedAt: bigint;
}

/** One node: a rail/currency pair where value can rest. */
export interface ConversionNode {
  readonly id: ConversionNodeId;
  /** Rail/provider descriptor, e.g. `mobile-money`, `card-scheme`. */
  readonly rail: string;
  readonly currency: CurrencyCode;
}

/**
 * One conversion capability between two nodes carrying the full FROZEN §10
 * descriptor set. `quote` is required whenever the edge crosses currencies
 * (validated at graph construction) and forbidden-verifies the pair matches.
 */
export interface ConversionEdge {
  readonly id: ConversionEdgeId;
  readonly from: ConversionNodeId;
  readonly to: ConversionNodeId;
  /** Exact provenanced FX quote; mandatory when the currencies differ. */
  readonly quote?: FxQuote;
  /** Fee charged for the conversion, in the `from` node's currency. */
  readonly fee: Money;
  /** Latency in milliseconds (bigint, deterministic). */
  readonly latencyMs: bigint;
  readonly reliability: ReliabilityClass;
  readonly liquidity: LiquidityRequirementClass;
  /** Compliance requirements that must be satisfied to use the edge. */
  readonly compliance: readonly string[];
  readonly finality: FinalityClass;
  readonly reversibility: ReversibilityClass;
  readonly proof: ProofRequirement;
  /** Capacity available on the edge, in the `from` node's currency. */
  readonly capacity: Money;
  readonly provenance: ConversionEdgeProvenance;
}

/** The value conversion graph. */
export interface ValueConversionGraph {
  readonly nodes: readonly ConversionNode[];
  readonly edges: readonly ConversionEdge[];
}

/** Injected bounds for deterministic route enumeration. */
export interface RouteEnumerationLimits {
  /** Maximum number of edges in a route (>= 1). */
  readonly maxHops: number;
  /** Maximum number of routes returned (>= 1). */
  readonly maxRoutes: number;
}

/** One enumerated route: an ordered edge chain from `from` to `to`. */
export interface ConversionRoute {
  readonly from: ConversionNodeId;
  readonly to: ConversionNodeId;
  readonly edges: readonly ConversionEdgeId[];
}

const DEFAULT_LIMITS: RouteEnumerationLimits = Object.freeze({ maxHops: 4, maxRoutes: 16 });

const RELIABILITY_CLASSES: readonly ReliabilityClass[] = ['HIGH', 'MEDIUM', 'LOW'];
const LIQUIDITY_CLASSES: readonly LiquidityRequirementClass[] = ['DEEP', 'ADEQUATE', 'THIN'];
const FINALITY_CLASSES: readonly FinalityClass[] = ['IMMEDIATE', 'SAME_DAY', 'NEXT_DAY', 'DELAYED'];
const REVERSIBILITY_CLASSES: readonly ReversibilityClass[] = [
  'IRREVERSIBLE',
  'REVERSIBLE_WITHIN_WINDOW',
  'REVERSIBLE',
];
const PROOF_REQUIREMENTS: readonly ProofRequirement[] = [
  'RAIL_PROOF',
  'SIGNED_RECEIPT',
  'MERKLE_ATTESTATION',
  'NONE',
];

/** Brand a validated string as a `ConversionNodeId`. */
export function asConversionNodeId(value: string): ConversionNodeId {
  if (typeof value !== 'string' || value.length === 0) {
    throw new InvalidIdentifierError('ConversionNodeId must be a non-empty string', { value });
  }
  if (value.length > 256) {
    throw new InvalidIdentifierError('ConversionNodeId exceeds 256 characters', { value });
  }
  if (value.trim() !== value) {
    throw new InvalidIdentifierError('ConversionNodeId must not carry surrounding whitespace', {
      value,
    });
  }
  return value as ConversionNodeId;
}

/** Brand a validated string as a `ConversionEdgeId`. */
export function asConversionEdgeId(value: string): ConversionEdgeId {
  if (typeof value !== 'string' || value.length === 0) {
    throw new InvalidIdentifierError('ConversionEdgeId must be a non-empty string', { value });
  }
  if (value.length > 256) {
    throw new InvalidIdentifierError('ConversionEdgeId exceeds 256 characters', { value });
  }
  if (value.trim() !== value) {
    throw new InvalidIdentifierError('ConversionEdgeId must not carry surrounding whitespace', {
      value,
    });
  }
  return value as ConversionEdgeId;
}

/** Construct a validated, frozen conversion node. */
export function defineConversionNode(input: {
  readonly id: string;
  readonly rail: string;
  readonly currency: CurrencyCode;
}): ConversionNode {
  const id = asConversionNodeId(input.id);
  if (typeof input.rail !== 'string' || input.rail.length === 0) {
    throw new ValidationError('node rail must be a non-empty string', { nodeId: id });
  }
  if (typeof input.currency !== 'string' || input.currency.length === 0) {
    throw new ValidationError('node currency must be a CurrencyCode', { nodeId: id });
  }
  return Object.freeze({ id, rail: input.rail, currency: input.currency });
}

/** Construct a validated, frozen conversion edge. */
export function defineConversionEdge(input: Omit<ConversionEdge, 'id'> & {
  readonly id: string;
}): ConversionEdge {
  const id = asConversionEdgeId(input.id);
  if (typeof input.from !== 'string' || input.from.length === 0) {
    throw new ValidationError('edge from must be a ConversionNodeId', { edgeId: id });
  }
  if (typeof input.to !== 'string' || input.to.length === 0) {
    throw new ValidationError('edge to must be a ConversionNodeId', { edgeId: id });
  }
  if (input.from === input.to) {
    throw new ValidationError('a conversion edge cannot loop on one node', { edgeId: id });
  }
  if (input.quote !== undefined) {
    if (input.quote === null || typeof input.quote !== 'object' || typeof input.quote.id !== 'string') {
      throw new ValidationError('edge quote must be an FxQuote', { edgeId: id });
    }
    asFxQuoteId(input.quote.id);
  }
  const fee = input.fee;
  if (fee === null || typeof fee !== 'object' || typeof fee.value !== 'bigint') {
    throw new ValidationError('edge fee must be exact Money (INV-F01)', { edgeId: id });
  }
  if (fee.value < 0n) {
    throw new ValidationError('edge fee cannot be negative', { edgeId: id });
  }
  if (typeof input.latencyMs !== 'bigint' || input.latencyMs < 0n) {
    throw new ValidationError('edge latencyMs must be a non-negative bigint', { edgeId: id });
  }
  if (!RELIABILITY_CLASSES.includes(input.reliability)) {
    throw new ValidationError('edge reliability is not a declared class', { edgeId: id });
  }
  if (!LIQUIDITY_CLASSES.includes(input.liquidity)) {
    throw new ValidationError('edge liquidity is not a declared class', { edgeId: id });
  }
  if (!Array.isArray(input.compliance) || input.compliance.some((entry) => typeof entry !== 'string' || entry.length === 0)) {
    throw new ValidationError('edge compliance must be an array of non-empty strings', {
      edgeId: id,
    });
  }
  if (!FINALITY_CLASSES.includes(input.finality)) {
    throw new ValidationError('edge finality is not a declared class', { edgeId: id });
  }
  if (!REVERSIBILITY_CLASSES.includes(input.reversibility)) {
    throw new ValidationError('edge reversibility is not a declared class', { edgeId: id });
  }
  if (!PROOF_REQUIREMENTS.includes(input.proof)) {
    throw new ValidationError('edge proof is not a declared requirement', { edgeId: id });
  }
  const capacity = input.capacity;
  if (capacity === null || typeof capacity !== 'object' || typeof capacity.value !== 'bigint') {
    throw new ValidationError('edge capacity must be exact Money (INV-F01)', { edgeId: id });
  }
  if (capacity.value < 0n) {
    throw new ValidationError('edge capacity cannot be negative', { edgeId: id });
  }
  const provenance = input.provenance;
  if (
    provenance === null ||
    typeof provenance !== 'object' ||
    typeof provenance.source !== 'string' ||
    provenance.source.length === 0 ||
    typeof provenance.reference !== 'string' ||
    provenance.reference.length === 0 ||
    typeof provenance.recordedAt !== 'bigint'
  ) {
    throw new ValidationError('edge provenance must carry source, reference and recordedAt', {
      edgeId: id,
    });
  }
  const edge: ConversionEdge = Object.freeze({
    id,
    from: input.from,
    to: input.to,
    ...(input.quote !== undefined ? { quote: input.quote } : {}),
    fee,
    latencyMs: input.latencyMs,
    reliability: input.reliability,
    liquidity: input.liquidity,
    compliance: Object.freeze([...input.compliance]),
    finality: input.finality,
    reversibility: input.reversibility,
    proof: input.proof,
    capacity,
    provenance: Object.freeze({ ...provenance }),
  });
  return edge;
}

/**
 * Assemble a validated graph:
 * - node ids unique; edge ids unique;
 * - every edge endpoint references a declared node;
 * - cross-currency edges MUST carry a quote whose pair matches the
 *   endpoints' currencies (base = from currency, quote = to currency) —
 *   an FX hop without provenanced rate cannot exist (INV-F09);
 * - same-currency edges carrying a quote are rejected (nothing to convert);
 * - edge fee/capacity must be denominated in the `from` node's currency.
 */
export function buildValueConversionGraph(
  nodes: readonly ConversionNode[],
  edges: readonly ConversionEdge[],
): ValueConversionGraph {
  if (!Array.isArray(nodes) || nodes.length === 0) {
    throw new ValidationError('a graph requires at least one node');
  }
  if (!Array.isArray(edges)) {
    throw new ValidationError('edges must be an array of ConversionEdge');
  }
  const nodeById = new Map<string, ConversionNode>();
  for (const node of nodes) {
    if (nodeById.has(node.id)) {
      throw new ValidationError('duplicate node id', { nodeId: node.id });
    }
    nodeById.set(node.id, node);
  }
  const edgeIds = new Set<string>();
  for (const edge of edges) {
    if (edgeIds.has(edge.id)) {
      throw new ValidationError('duplicate edge id', { edgeId: edge.id });
    }
    edgeIds.add(edge.id);
    const fromNode = nodeById.get(edge.from);
    const toNode = nodeById.get(edge.to);
    if (fromNode === undefined || toNode === undefined) {
      throw new ValidationError('edge endpoint is not a declared node', { edgeId: edge.id });
    }
    const crossesCurrencies = fromNode.currency !== toNode.currency;
    if (crossesCurrencies) {
      if (edge.quote === undefined) {
        throw new ValidationError(
          'a cross-currency edge must carry an exact provenanced FxQuote (INV-F09)',
          { edgeId: edge.id, from: edge.from, to: edge.to },
        );
      }
      if (
        edge.quote.pair.base !== fromNode.currency ||
        edge.quote.pair.quote !== toNode.currency
      ) {
        throw new ValidationError('edge quote pair does not match the endpoint currencies', {
          edgeId: edge.id,
          expected: `${fromNode.currency}/${toNode.currency}`,
          found: `${edge.quote.pair.base}/${edge.quote.pair.quote}`,
        });
      }
    } else if (edge.quote !== undefined) {
      throw new ValidationError('a same-currency edge must not carry an FxQuote', {
        edgeId: edge.id,
      });
    }
    if (edge.fee.currency !== fromNode.currency) {
      throw new ValidationError('edge fee must be denominated in the from-node currency', {
        edgeId: edge.id,
        expected: fromNode.currency,
        found: edge.fee.currency,
      });
    }
    if (edge.capacity.currency !== fromNode.currency) {
      throw new ValidationError('edge capacity must be denominated in the from-node currency', {
        edgeId: edge.id,
        expected: fromNode.currency,
        found: edge.capacity.currency,
      });
    }
  }
  return Object.freeze({
    nodes: Object.freeze([...nodes]),
    edges: Object.freeze([...edges]),
  });
}

/** Deterministic comparison of two edge-id sequences (lexicographic). */
function compareEdgeSequences(a: readonly ConversionEdgeId[], b: readonly ConversionEdgeId[]): number {
  const length = Math.min(a.length, b.length);
  for (let index = 0; index < length; index += 1) {
    const left = a[index];
    const right = b[index];
    if (left === undefined || right === undefined) continue;
    if (left < right) return -1;
    if (left > right) return 1;
  }
  return a.length - b.length;
}

/**
 * Deterministically enumerate routes `from → to`.
 *
 * Enumeration contract:
 * - only simple paths (a node is visited at most once);
 * - paths longer than `limits.maxHops` edges are not explored;
 * - DFS visits out-edges in sorted order (from, to, edgeId), so exploration
 *   order is a pure function of the graph;
 * - collected routes are ordered by (hop count, edge-id sequence
 *   lexicographic) and truncated to `limits.maxRoutes`;
 * - `from === to` returns a single empty route (zero hops) — value already
 *   rests at the destination.
 *
 * The same graph + limits always produce the identical route list.
 */
export function findRoutes(
  graph: ValueConversionGraph,
  from: ConversionNodeId,
  to: ConversionNodeId,
  limits?: RouteEnumerationLimits,
): readonly ConversionRoute[] {
  if (graph === null || typeof graph !== 'object') {
    throw new ValidationError('graph must be a ValueConversionGraph');
  }
  if (typeof from !== 'string' || from.length === 0) {
    throw new ValidationError('from must be a ConversionNodeId');
  }
  if (typeof to !== 'string' || to.length === 0) {
    throw new ValidationError('to must be a ConversionNodeId');
  }
  const effectiveLimits: RouteEnumerationLimits =
    limits === undefined
      ? DEFAULT_LIMITS
      : (() => {
          if (limits === null || typeof limits !== 'object') {
            throw new ValidationError('limits must be a RouteEnumerationLimits');
          }
          if (
            !Number.isInteger(limits.maxHops) ||
            limits.maxHops < 1 ||
            !Number.isInteger(limits.maxRoutes) ||
            limits.maxRoutes < 1
          ) {
            throw new ValidationError('limits.maxHops and limits.maxRoutes must be integers >= 1');
          }
          return limits;
        })();

  const nodeIds = new Set(graph.nodes.map((node) => node.id));
  if (!nodeIds.has(from)) {
    throw new ValidationError('from node is not part of the graph', { from });
  }
  if (!nodeIds.has(to)) {
    throw new ValidationError('to node is not part of the graph', { to });
  }
  if (from === to) {
    return Object.freeze([
      Object.freeze({ from, to, edges: Object.freeze([]) }),
    ]);
  }

  // Deterministic adjacency: out-edges sorted by (to, edgeId).
  const adjacency = new Map<string, ConversionEdge[]>();
  for (const edge of graph.edges) {
    const bucket = adjacency.get(edge.from);
    if (bucket === undefined) {
      adjacency.set(edge.from, [edge]);
    } else {
      bucket.push(edge);
    }
  }
  for (const bucket of adjacency.values()) {
    bucket.sort((a, b) => (a.to < b.to ? -1 : a.to > b.to ? 1 : a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  }

  const routes: ConversionEdgeId[][] = [];
  const path: ConversionEdgeId[] = [];
  const visited = new Set<string>();

  const explore = (current: string): void => {
    if (routes.length >= effectiveLimits.maxRoutes * 8) {
      // Exploration guard: bounded work even on dense graphs. The guard is a
      // deterministic function of traversal order (sorted adjacency), so
      // output remains reproducible.
      return;
    }
    const outEdges = adjacency.get(current) ?? [];
    for (const edge of outEdges) {
      if (visited.has(edge.to)) continue;
      if (path.length + 1 > effectiveLimits.maxHops) continue;
      path.push(edge.id);
      if (edge.to === to) {
        routes.push([...path]);
        // Do not recurse past the destination: a route that leaves and
        // returns would revisit `to`.
      } else {
        visited.add(edge.to);
        explore(edge.to);
        visited.delete(edge.to);
      }
      path.pop();
      if (routes.length >= effectiveLimits.maxRoutes * 8) return;
    }
  };

  visited.add(from);
  explore(from);

  routes.sort((a, b) => a.length - b.length || compareEdgeSequences(a, b));
  const truncated = routes.slice(0, effectiveLimits.maxRoutes);
  return Object.freeze(
    truncated.map((edges) =>
      Object.freeze({ from, to, edges: Object.freeze([...edges]) }),
    ),
  );
}

/**
 * Resolve a route's edges (in order) against the graph. Returns the full
 * edge records so callers can evaluate fees/latency/quotes without a second
 * lookup. The chain must actually connect `route.from → route.to`.
 */
export function resolveRoute(
  graph: ValueConversionGraph,
  route: ConversionRoute,
): readonly ConversionEdge[] {
  const byId = new Map(graph.edges.map((edge) => [edge.id, edge] as const));
  const resolved: ConversionEdge[] = [];
  let cursor = route.from;
  for (const edgeId of route.edges) {
    const edge = byId.get(edgeId);
    if (edge === undefined) {
      throw new ValidationError('route references an edge that is not part of the graph', {
        edgeId,
      });
    }
    if (edge.from !== cursor) {
      throw new ValidationError('route edges do not form a connected chain', {
        edgeId,
        expectedFrom: cursor,
      });
    }
    resolved.push(edge);
    cursor = edge.to;
  }
  if (cursor !== route.to) {
    throw new ValidationError('route does not end at its declared destination', {
      expected: route.to,
      found: cursor,
    });
  }
  return Object.freeze(resolved);
}
