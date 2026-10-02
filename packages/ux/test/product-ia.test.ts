import { describe, expect, it } from 'vitest';

import {
  authenticatedSurfaces,
  deriveNavigationForRole,
  navigationItems,
  navItemById,
  PRODUCT_NAVIGATION,
  PRODUCT_NAV_GROUP_IDS,
  PRODUCT_NAV_ITEM_IDS,
  PRODUCT_ROLES,
  PRODUCT_SURFACES,
  productRoutes,
  publicSurfaces,
  resolveProductRoute,
  resolveRouteAccess,
  ROLE_NAV_CAPABILITIES,
  roleCapabilities,
  surfaceById,
  validateDeepLink,
  visibleNavIds,
} from '../src/product-ia.js';
import type { ProductNavItemId, ProductRole, RoleNavigationView } from '../src/product-ia.js';

// ---------------------------------------------------------------------------
// The surface map — public vs authenticated is explicit and total
// ---------------------------------------------------------------------------

describe('product surface map', () => {
  it('declares the five public surfaces (home, capabilities explorer, security, developers, marked demo) and the single authenticated surface', () => {
    expect(publicSurfaces().map((surface) => surface.id)).toEqual([
      'home',
      'capabilities-explorer',
      'security',
      'developers',
      'demo-sandbox',
    ]);
    expect(authenticatedSurfaces().map((surface) => surface.id)).toEqual(['command-center']);
  });

  it('the demo/sandbox surface is MARKED; no other surface is', () => {
    for (const surface of PRODUCT_SURFACES) {
      expect(surface.markedDemo === true).toBe(surface.id === 'demo-sandbox');
    }
  });

  it('every surface carries an honest-state contract: empty data is an EMPTY STATE, UNKNOWN never renders as failure', () => {
    for (const surface of PRODUCT_SURFACES) {
      expect(surface.honestState.dataAbsent).toBe('EMPTY_STATE');
      expect(surface.honestState.unknownRenders).toBe('RECONCILING_NEVER_FAILURE');
      expect(surface.honestState.emptyStateGuidance.length).toBeGreaterThan(0);
      expect(surface.honestState.authAbsent).toBe(
        surface.kind === 'authenticated' ? 'AUTHENTICATION_REQUIRED' : 'NOT_REQUIRED',
      );
    }
  });

  it('surfaceById fails closed on unknown ids', () => {
    expect(() => surfaceById('nope' as never)).toThrow(/unknown product surface/);
  });
});

// ---------------------------------------------------------------------------
// The route model — every route resolves; the partition is total
// ---------------------------------------------------------------------------

describe('product route model', () => {
  it('covers every public surface route and every navigation route exactly once (unique paths)', () => {
    const routes = productRoutes();
    const paths = routes.map((route) => route.path);
    expect(new Set(paths).size).toBe(paths.length);
    for (const surface of PRODUCT_SURFACES) {
      expect(paths).toContain(surface.route);
    }
    for (const item of navigationItems()) {
      expect(paths).toContain(item.route);
    }
  });

  it('the public/authenticated partition is total: route access matches surface kind', () => {
    for (const route of productRoutes()) {
      const surface = surfaceById(route.surface);
      expect(route.access).toBe(surface.kind === 'public' ? 'PUBLIC' : 'AUTHENTICATED');
    }
  });

  it('every navigation route requires exactly its item capabilities and binds to the command-center surface', () => {
    for (const route of productRoutes()) {
      if (route.navItem === undefined) {
        continue;
      }
      const item = navItemById(route.navItem);
      expect(route.requiredCapabilities).toEqual(item.requiresCapabilities);
      expect(route.surface).toBe('command-center');
      expect(route.access).toBe('AUTHENTICATED');
    }
  });

  it('resolveProductRoute resolves every declared path and rejects unknown paths without throwing', () => {
    for (const route of productRoutes()) {
      const resolution = resolveProductRoute(route.path);
      expect(resolution.kind).toBe('RESOLVED');
      if (resolution.kind === 'RESOLVED') {
        expect(resolution.route.id).toBe(route.id);
      }
    }
    const unknown = resolveProductRoute('/command-center/no-such-surface');
    expect(unknown.kind).toBe('UNKNOWN_ROUTE');
    if (unknown.kind === 'UNKNOWN_ROUTE') {
      expect(unknown.path).toBe('/command-center/no-such-surface');
    }
  });

  it('the demo route is marked, and marking is inherited from the marked surface only', () => {
    for (const route of productRoutes()) {
      expect(route.markedDemo === true).toBe(route.surface === 'demo-sandbox');
    }
  });
});

// ---------------------------------------------------------------------------
// Deep-link validation (pure resolver: route → access/capability)
// ---------------------------------------------------------------------------

describe('deep-link access validation', () => {
  it('public routes are PUBLIC_ACCESS for anonymous and authenticated viewers alike', () => {
    for (const path of ['/', '/capabilities', '/security', '/developers', '/demo']) {
      expect(resolveRouteAccess(path, { authenticated: false }).kind).toBe('PUBLIC_ACCESS');
      expect(resolveRouteAccess(path, { authenticated: true, role: 'merchant' }).kind).toBe('PUBLIC_ACCESS');
    }
  });

  it('authenticated routes demand authentication before capability', () => {
    const decision = resolveRouteAccess('/command-center/payments', { authenticated: false, role: 'merchant' });
    expect(decision.kind).toBe('AUTHENTICATION_REQUIRED');
  });

  it('GRANTED carries the via-capability that authorized the deep link', () => {
    const decision = resolveRouteAccess('/command-center/payments', { authenticated: true, role: 'supplier' });
    expect(decision.kind).toBe('GRANTED');
    if (decision.kind === 'GRANTED') {
      expect(decision.viaCapabilities).toContain('payments.collect');
    }
  });

  it('CAPABILITY_REQUIRED names the missing capabilities honestly (no exception)', () => {
    const decision = resolveRouteAccess('/command-center/developers', { authenticated: true, role: 'merchant' });
    expect(decision.kind).toBe('CAPABILITY_REQUIRED');
    if (decision.kind === 'CAPABILITY_REQUIRED') {
      expect(decision.missing).toEqual(['developers.manage']);
      expect(decision.role).toBe('merchant');
    }
  });

  it('an authenticated viewer with no established role gets an honest capability-required decision', () => {
    const decision = resolveRouteAccess('/command-center/payments', { authenticated: true });
    expect(decision.kind).toBe('CAPABILITY_REQUIRED');
  });

  it('unknown paths fail closed (the resolver throws rather than guessing)', () => {
    expect(() => resolveRouteAccess('/nope', { authenticated: true, role: 'merchant' })).toThrow(/no route resolves/);
  });

  it('validateDeepLink: valid carries guidance; invalid carries honest guidance, never an exception', () => {
    const valid = validateDeepLink('/command-center/settings', { authenticated: true, role: 'lp' });
    expect(valid.valid).toBe(true);
    expect(valid.guidance).toContain('settings.manage');
    const unauthenticated = validateDeepLink('/command-center', { authenticated: false });
    expect(unauthenticated.valid).toBe(false);
    expect(unauthenticated.guidance).toContain('authentication');
    const wrongRole = validateDeepLink('/command-center/liquidity', { authenticated: true, role: 'borrower' });
    expect(wrongRole.valid).toBe(false);
    expect(wrongRole.guidance).toContain("'borrower'");
  });
});

// ---------------------------------------------------------------------------
// The grouped navigation model
// ---------------------------------------------------------------------------

describe('grouped navigation model', () => {
  it('has the six grouped sections in the ordered grouping', () => {
    expect(PRODUCT_NAVIGATION.groups.map((group) => group.id)).toEqual(PRODUCT_NAV_GROUP_IDS);
  });

  it('places every item in its group with the product-mandated grouping', () => {
    const expected: Readonly<Record<ProductNavItemId, string>> = {
      overview: 'OVERVIEW',
      activity: 'OVERVIEW',
      payments: 'MONEY_MOVEMENT',
      collections: 'MONEY_MOVEMENT',
      payouts: 'MONEY_MOVEMENT',
      billing: 'MONEY_MOVEMENT',
      credit: 'MONEY_MOVEMENT',
      liquidity: 'MONEY_MOVEMENT',
      capabilities: 'CAPABILITIES',
      agents: 'CAPABILITIES',
      opportunities: 'CAPABILITIES',
      programs: 'CAPABILITIES',
      disputes: 'TRUST',
      evidence: 'TRUST',
      developers: 'DEVELOP',
      settings: 'ACCOUNT',
    };
    for (const item of navigationItems()) {
      expect(item.group).toBe(expected[item.id]);
    }
  });

  it('every declared nav id has exactly one item and vice versa', () => {
    const items = navigationItems();
    expect(items.map((item) => item.id).sort()).toEqual([...PRODUCT_NAV_ITEM_IDS].sort());
    expect(() => navItemById('nope' as never)).toThrow(/unknown navigation item/);
  });

  it('each item declares its required capability as DATA (no role-hardcoded booleans anywhere in the module)', () => {
    const withRequirements = navigationItems().filter((item) => item.requiresCapabilities.length > 0);
    // 14 of 16 items carry an explicit capability requirement (Overview and
    // Activity are visible to every authenticated role).
    expect(withRequirements.length).toBe(14);
    for (const item of withRequirements) {
      expect(item.requiresCapabilities.length).toBeGreaterThan(0);
    }
  });

  it('money-movement/trust/capability items bind to the Command Center domain that renders them (consumed binding)', () => {
    expect(navItemById('payments').commandCenterDomain).toBe('EXECUTION');
    expect(navItemById('capabilities').commandCenterDomain).toBe('CAPABILITY');
    expect(navItemById('disputes').commandCenterDomain).toBe('DISPUTE');
    expect(navItemById('evidence').commandCenterDomain).toBe('EVIDENCE');
    expect(navItemById('programs').commandCenterDomain).toBe('INCENTIVE');
  });
});

// ---------------------------------------------------------------------------
// Role-sensitive navigation — every one of the eight roles
// ---------------------------------------------------------------------------

describe('role-sensitive navigation derivation (all eight roles)', () => {
  it('every role gets a DERIVED view of the SAME navigation (no separate products)', () => {
    for (const role of PRODUCT_ROLES) {
      const view: RoleNavigationView = deriveNavigationForRole(PRODUCT_NAVIGATION, role);
      expect(view.role).toBe(role);
      // The groups are the same groups; only membership is derived.
      expect(view.groups.map((group) => group.group.id)).toEqual(PRODUCT_NAV_GROUP_IDS);
      // Flat items are exactly the visible ones, in navigation order.
      expect(view.items.every((item) => item.visible)).toBe(true);
      expect(view.groups.flatMap((group) => group.items)).toEqual(view.items);
    }
  });

  it('every role sees Overview, Activity, Evidence and Settings (common surfaces)', () => {
    for (const role of PRODUCT_ROLES) {
      const ids = visibleNavIds(PRODUCT_NAVIGATION, role);
      for (const common of ['overview', 'activity', 'evidence', 'settings'] as const) {
        expect(ids).toContain(common);
      }
    }
  });

  it('merchant sees the full money-movement + capability program', () => {
    expect(visibleNavIds(PRODUCT_NAVIGATION, 'merchant')).toEqual([
      'overview',
      'activity',
      'payments',
      'collections',
      'payouts',
      'billing',
      'credit',
      'capabilities',
      'agents',
      'programs',
      'disputes',
      'evidence',
      'settings',
    ]);
  });

  it('no role sees another role\u2019s exclusive controls', () => {
    const expectations: Readonly<Record<ProductRole, readonly ProductNavItemId[]>> = {
      merchant: ['liquidity', 'opportunities', 'developers'],
      supplier: ['payouts', 'billing', 'credit', 'liquidity', 'capabilities', 'agents', 'opportunities', 'programs', 'developers'],
      lp: ['payments', 'collections', 'billing', 'credit', 'capabilities', 'agents', 'programs', 'disputes', 'developers'],
      lender: ['billing', 'liquidity', 'capabilities', 'agents', 'opportunities', 'programs', 'developers'],
      borrower: ['collections', 'payouts', 'liquidity', 'capabilities', 'agents', 'opportunities', 'programs', 'disputes', 'developers'],
      developer: ['collections', 'payouts', 'billing', 'credit', 'liquidity', 'agents', 'opportunities', 'programs', 'disputes'],
      expert: ['payments', 'collections', 'payouts', 'billing', 'credit', 'liquidity', 'capabilities', 'agents', 'programs', 'developers'],
      'network-operator': ['payments', 'collections', 'payouts', 'billing', 'credit', 'liquidity', 'agents', 'opportunities', 'programs', 'developers'],
    };
    for (const role of PRODUCT_ROLES) {
      const ids = visibleNavIds(PRODUCT_NAVIGATION, role);
      for (const forbidden of expectations[role]) {
        expect(ids).not.toContain(forbidden);
      }
    }
  });

  it('the developer role sees Developers; no other role does', () => {
    for (const role of PRODUCT_ROLES) {
      const sees = visibleNavIds(PRODUCT_NAVIGATION, role).includes('developers');
      expect(sees).toBe(role === 'developer');
    }
  });

  it('only the LP sees Liquidity; the network-operator sees Capabilities and Disputes but no money-movement role surface', () => {
    expect(visibleNavIds(PRODUCT_NAVIGATION, 'lp')).toContain('liquidity');
    for (const role of PRODUCT_ROLES.filter((candidate) => candidate !== 'lp')) {
      expect(visibleNavIds(PRODUCT_NAVIGATION, role)).not.toContain('liquidity');
    }
    const operator = visibleNavIds(PRODUCT_NAVIGATION, 'network-operator');
    expect(operator).toContain('capabilities');
    expect(operator).toContain('disputes');
    for (const moneySurface of ['payments', 'collections', 'payouts', 'billing', 'credit'] as const) {
      expect(operator).not.toContain(moneySurface);
    }
  });

  it('the via-capability names the joined capability token (derivation, not hardcoding)', () => {
    const supplier = deriveNavigationForRole(PRODUCT_NAVIGATION, 'supplier');
    const payments = supplier.items.find((view) => view.item.id === 'payments');
    // The join is deterministic: the FIRST required capability the role holds.
    expect(payments?.viaCapability).toBe('payments.send');
    const developer = deriveNavigationForRole(PRODUCT_NAVIGATION, 'developer');
    const capabilities = developer.items.find((view) => view.item.id === 'capabilities');
    expect(capabilities?.viaCapability).toBe('capabilities.manage');
  });

  it('roleCapabilities mirrors the role capability table and fails closed on unknown roles', () => {
    for (const role of PRODUCT_ROLES) {
      expect(roleCapabilities(role)).toEqual(ROLE_NAV_CAPABILITIES[role]);
    }
    expect(() => roleCapabilities('nope' as never)).toThrow(/unknown product role/);
  });
});

// ---------------------------------------------------------------------------
// Authority-derived attention/disable annotations
// ---------------------------------------------------------------------------

describe('navigation annotations derive from AUTHORITY inputs only', () => {
  it('requires-attention marks come exclusively from the authority context', () => {
    const view = deriveNavigationForRole(PRODUCT_NAVIGATION, 'merchant', {
      attentionNavIds: ['payouts', 'disputes'],
    });
    const flagged = view.items.filter((item) => item.requiresAttention).map((item) => item.item.id);
    expect(flagged).toEqual(['payouts', 'disputes']);
    // Without the authority context nothing is flagged.
    expect(
      deriveNavigationForRole(PRODUCT_NAVIGATION, 'merchant').items.filter((item) => item.requiresAttention),
    ).toEqual([]);
  });

  it('an authority-disabled item stays VISIBLE but disabled with an honest reason (no dead removal)', () => {
    const view = deriveNavigationForRole(PRODUCT_NAVIGATION, 'merchant', {
      disabledNavIds: ['payouts'],
      disabledReason: 'no connected capability instance permits payouts yet',
    });
    const payouts = view.items.find((item) => item.item.id === 'payouts');
    expect(payouts?.visible).toBe(true);
    expect(payouts?.enabled).toBe(false);
    expect(payouts?.disabledReason).toBe('no connected capability instance permits payouts yet');
    const untouched = view.items.find((item) => item.item.id === 'payments');
    expect(untouched?.enabled).toBe(true);
    expect(untouched?.disabledReason).toBeUndefined();
  });

  it('an invisible item can never be flagged or disabled into visibility (capability gate first)', () => {
    const view = deriveNavigationForRole(PRODUCT_NAVIGATION, 'lp', {
      attentionNavIds: ['payments', 'agents'],
      disabledNavIds: ['payments'],
    });
    expect(view.items.map((item) => item.item.id)).not.toContain('payments');
    expect(view.items.map((item) => item.item.id)).not.toContain('agents');
  });
});
