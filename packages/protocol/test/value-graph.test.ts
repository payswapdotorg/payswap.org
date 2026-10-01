import { describe, expect, it } from 'vitest';
import {
  GHS,
  USD,
  defineFxQuote,
  fromMinorUnits,
} from '../src/index.js';
import {
  asConversionEdgeId,
  asConversionNodeId,
  buildValueConversionGraph,
  defineConversionEdge,
  defineConversionNode,
  findRoutes,
  resolveRoute,
  type ConversionEdge,
  type ConversionNode,
  type ValueConversionGraph,
} from '../src/value-graph.js';

function usd(minorUnits: bigint) {
  return fromMinorUnits(USD, minorUnits);
}
function ghs(minorUnits: bigint) {
  return fromMinorUnits(GHS, minorUnits);
}

function node(id: string, rail: string, currency: typeof USD): ConversionNode {
  return defineConversionNode({ id, rail, currency });
}

function ghsUsdQuote(): ReturnType<typeof defineFxQuote> {
  return defineFxQuote({
    id: 'fxq-gbp-usd',
    pair: { base: GHS, quote: USD },
    rate: { numerator: 663n, denominator: 10_000n },
    providerRef: 'provider:fxcorp/quotes/80',
    quotedAt: 1_000n,
    expiresAt: 60_000n,
    provenance: {
      rateSource: 'provider:fxcorp',
      rateSourceRef: 'rate/2026-10-01/GHS-USD',
      observedAt: 900n,
    },
  });
}

function edge(
  id: string,
  from: string,
  to: string,
  overrides?: Partial<ConversionEdge>,
): ConversionEdge {
  // fee/capacity default to the from-node's currency (graph validation)
  const fromCurrency = from.endsWith(':GHS') ? GHS : USD;
  return defineConversionEdge({
    id,
    from: asConversionNodeId(from),
    to: asConversionNodeId(to),
    fee: fromMinorUnits(fromCurrency, 25n),
    latencyMs: 500n,
    reliability: 'HIGH',
    liquidity: 'ADEQUATE',
    compliance: ['AML_KYC'],
    finality: 'SAME_DAY',
    reversibility: 'REVERSIBLE_WITHIN_WINDOW',
    proof: 'RAIL_PROOF',
    capacity: fromMinorUnits(fromCurrency, 1_000_000n),
    provenance: { source: 'capability-catalog:connector-x', reference: 'edge/1', recordedAt: 1_000n },
    ...overrides,
  } as Omit<ConversionEdge, 'id'> & { readonly id: string });
}

/**
 * Test graph (deterministic):
 *
 *   MM:GHS ──e1──> BANK:GHS ──e2──> BANK:USD
 *      │                                 ▲
 *      └──────────e3──> PSP:USD ──e4─────┘
 *   WALLET:USD ──e5──> BANK:USD
 */
function graph(): ValueConversionGraph {
  return buildValueConversionGraph(
    [
      node('MM:GHS', 'mobile-money', GHS),
      node('BANK:GHS', 'bank-transfer', GHS),
      node('BANK:USD', 'bank-transfer', USD),
      node('PSP:USD', 'psp', USD),
      node('WALLET:USD', 'wallet', USD),
    ],
    [
      edge('e1', 'MM:GHS', 'BANK:GHS'),
      // cross-currency edge — must carry the exact provenanced quote (INV-F09)
      edge('e2', 'BANK:GHS', 'BANK:USD', { quote: ghsUsdQuote() }),
      edge('e3', 'MM:GHS', 'PSP:USD', { quote: ghsUsdQuote() }),
      edge('e4', 'PSP:USD', 'BANK:USD'),
      edge('e5', 'WALLET:USD', 'BANK:USD'),
    ],
  );
}

describe('buildValueConversionGraph (FROZEN §10 descriptors)', () => {
  it('assembles nodes and edges, retaining the full descriptor set per edge', () => {
    const g = graph();
    expect(g.nodes.length).toBe(5);
    expect(g.edges.length).toBe(5);
    const e2 = g.edges.find((candidate) => candidate.id === asConversionEdgeId('e2'));
    if (e2 === undefined) throw new Error('missing e2');
    expect(e2.quote?.rate.numerator).toBe(663n);
    expect(e2.fee.value).toBe(25n);
    expect(e2.fee.currency).toBe(GHS);
    expect(e2.capacity.currency).toBe(GHS);
    expect(e2.latencyMs).toBe(500n);
    expect(e2.reliability).toBe('HIGH');
    expect(e2.liquidity).toBe('ADEQUATE');
    expect(e2.compliance).toEqual(['AML_KYC']);
    expect(e2.finality).toBe('SAME_DAY');
    expect(e2.reversibility).toBe('REVERSIBLE_WITHIN_WINDOW');
    expect(e2.proof).toBe('RAIL_PROOF');
    expect(e2.capacity.value).toBe(1_000_000n);
    expect(e2.provenance.source).toBe('capability-catalog:connector-x');
  });

  it('rejects cross-currency edges without a quote and mismatched quote pairs (INV-F09)', () => {
    const nodes = [
      node('A:GHS', 'a', GHS),
      node('B:USD', 'b', USD),
    ];
    expect(() => buildValueConversionGraph(nodes, [edge('e', 'A:GHS', 'B:USD')])).toThrow(
      /must carry an exact provenanced FxQuote/,
    );
    const wrongPair = edge('e', 'A:GHS', 'B:USD', {
      quote: defineFxQuote({
        id: 'fxq-wrong',
        pair: { base: USD, quote: GHS },
        rate: { numerator: 1n, denominator: 1n },
        providerRef: 'p',
        quotedAt: 1_000n,
        expiresAt: 60_000n,
        provenance: { rateSource: 's', rateSourceRef: 'r', observedAt: 900n },
      }),
    });
    expect(() => buildValueConversionGraph(nodes, [wrongPair])).toThrow(
      /does not match the endpoint currencies/,
    );
  });

  it('rejects same-currency edges carrying quotes, loops, and unknown endpoints', () => {
    expect(() =>
      buildValueConversionGraph(
        [node('A:GHS', 'a', GHS)],
        [edge('e', 'A:GHS', 'A:GHS')],
      ),
    ).toThrow(/loop/);
    expect(() =>
      buildValueConversionGraph(
        [node('A:GHS', 'a', GHS), node('B:GHS', 'b', GHS)],
        [edge('e', 'A:GHS', 'B:GHS', { quote: ghsUsdQuote() })],
      ),
    ).toThrow(/same-currency edge must not carry/);
    expect(() =>
      buildValueConversionGraph(
        [node('A:GHS', 'a', GHS)],
        [edge('e', 'A:GHS', 'MISSING:GHS')],
      ),
    ).toThrow(/not a declared node/);
  });

  it('validates edge fee/capacity currency must match the from-node currency', () => {
    const nodes = [node('A:GHS', 'a', GHS), node('B:GHS', 'b', GHS)];
    expect(() =>
      buildValueConversionGraph(nodes, [
        edge('e', 'A:GHS', 'B:GHS', { fee: usd(1n) }),
      ]),
    ).toThrow(/fee must be denominated/);
    expect(() =>
      buildValueConversionGraph(nodes, [
        edge('e', 'A:GHS', 'B:GHS', { capacity: usd(1n) }),
      ]),
    ).toThrow(/capacity must be denominated/);
  });
});

describe('findRoutes (deterministic, bounded, injected limits)', () => {
  it('enumerates every bounded simple route, ordered by hops then edge ids', () => {
    const routes = findRoutes(
      graph(),
      asConversionNodeId('MM:GHS'),
      asConversionNodeId('BANK:USD'),
    );
    expect(routes.map((route) => [...route.edges])).toEqual([
      ['e1', 'e2'],
      ['e3', 'e4'],
    ]);
  });

  it('resolves routes back to full edge records with §10 descriptors', () => {
    const g = graph();
    const routes = findRoutes(g, asConversionNodeId('MM:GHS'), asConversionNodeId('BANK:USD'));
    const resolved = resolveRoute(g, routes[0]!);
    expect(resolved.length).toBe(2);
    expect(resolved[0]?.id).toBe(asConversionEdgeId('e1'));
    expect(resolved[1]?.id).toBe(asConversionEdgeId('e2'));
    expect(resolved[1]?.quote?.pair.base).toBe(GHS);
    expect(resolved[1]?.quote?.pair.quote).toBe(USD);
  });

  it('is deterministic: identical graph + limits → byte-identical output', () => {
    const render = (): string =>
      JSON.stringify(
        findRoutes(graph(), asConversionNodeId('MM:GHS'), asConversionNodeId('BANK:USD'), {
          maxHops: 4,
          maxRoutes: 16,
        }),
      );
    expect(render()).toBe(render());
    // and stable under edge input reordering (adjacency is sorted, not input order)
    const g = graph();
    const reordered = buildValueConversionGraph(g.nodes, [...g.edges].reverse());
    expect(
      JSON.stringify(
        findRoutes(reordered, asConversionNodeId('MM:GHS'), asConversionNodeId('BANK:USD')),
      ),
    ).toBe(JSON.stringify(findRoutes(g, asConversionNodeId('MM:GHS'), asConversionNodeId('BANK:USD'))));
  });

  it('honors injected bounds: maxHops and maxRoutes truncate deterministically', () => {
    const from = asConversionNodeId('MM:GHS');
    const to = asConversionNodeId('BANK:USD');
    const oneHop = findRoutes(graph(), from, to, { maxHops: 1, maxRoutes: 16 });
    expect(oneHop.length).toBe(0); // every route needs 2 hops
    const firstOnly = findRoutes(graph(), from, to, { maxHops: 4, maxRoutes: 1 });
    expect(firstOnly.length).toBe(1);
    expect(firstOnly[0]?.edges).toEqual(['e1', 'e2']);
  });

  it('returns the empty route for from === to and rejects unknown endpoints', () => {
    const from = asConversionNodeId('MM:GHS');
    expect(findRoutes(graph(), from, from)).toEqual([
      { from, to: from, edges: [] },
    ]);
    expect(() => findRoutes(graph(), asConversionNodeId('NOPE:GHS'), from)).toThrow(/from node/);
    expect(() => findRoutes(graph(), from, asConversionNodeId('NOPE:USD'))).toThrow(/to node/);
  });

  it('rejects malformed limits', () => {
    expect(() =>
      findRoutes(graph(), asConversionNodeId('MM:GHS'), asConversionNodeId('BANK:USD'), {
        maxHops: 0,
        maxRoutes: 1,
      }),
    ).toThrow(/limits/);
    expect(() =>
      findRoutes(graph(), asConversionNodeId('MM:GHS'), asConversionNodeId('BANK:USD'), {
        maxHops: 1,
        maxRoutes: 0,
      }),
    ).toThrow(/limits/);
  });
});
