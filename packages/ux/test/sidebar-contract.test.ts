/**
 * UX-002 — object-model sidebar registry tests (contract 01 v1.1 §3/§6/§8):
 *
 * - the registry exposes EXACTLY the five persistent money-object rows, in the
 *   contract's order, with the contract's routes;
 * - the five workload groups carry the contract's items with STABLE
 *   `nav.group.<slug>` testids; "More" is the only group allowed to exceed
 *   7 items;
 * - route slugs are object-noun based — a segment-level verb-slug grep over
 *   the registry finds NONE (contract 01 §3 rule + §8);
 * - the create menu carries the five items with their chords (c p / c r /
 *   c i / c l / c v), each feeding the command grammar;
 * - roles become PROJECTIONS: every role's derived sidebar has the SAME rows,
 *   groups and order (a role NEVER re-axes the navigation); only emphasis,
 *   role-default visibility and projection labels change;
 * - the compatibility fold maps every existing ProductRole onto emphasized
 *   groups (additive; the legacy navigation API stays intact).
 */

import { describe, expect, it } from 'vitest';

import {
  COMMAND_VERBS,
  commandVerbChord,
  type CommandVerb,
} from '../src/command-center.js';
import {
  CONSUMER_ROW_LABELS,
  CREATE_MENU_ITEMS,
  emphasizedGroupsForRole,
  navGroupTestId,
  navItemTestId,
  PRODUCT_NAVIGATION,
  PRODUCT_NAV_GROUP_IDS,
  PRODUCT_ROLES,
  ROLE_NAV_CAPABILITIES,
  projectSidebar,
  ROLE_SIDEBAR_PROJECTIONS,
  SIDEBAR,
  SIDEBAR_GROUP_SLUGS,
  SIDEBAR_PERSISTENT_ROW_IDS,
  sidebarProjectionForRole,
  type SidebarGroupSlug,
  type SidebarPersistentRowId,
} from '../src/product-ia.js';

// ---------------------------------------------------------------------------
// The five persistent rows (contract 01 §3 table, exact order and routes)
// ---------------------------------------------------------------------------

describe('sidebar persistent rows (contract 01 §3)', () => {
  it('exposes EXACTLY five persistent rows, in the contract order, with the contract routes', () => {
    expect(SIDEBAR.rows.map((row) => row.id)).toEqual([
      'home',
      'balances',
      'transactions',
      'customers',
      'catalog',
    ]);
    expect(SIDEBAR.rows.map((row) => row.route)).toEqual([
      '/',
      '/balances',
      '/transactions',
      '/customers',
      '/catalog',
    ]);
    expect(SIDEBAR.rows).toHaveLength(5);
    expect(SIDEBAR_PERSISTENT_ROW_IDS).toHaveLength(5);
  });

  it('each row names its money object (object model, not a feature list)', () => {
    for (const row of SIDEBAR.rows) {
      expect(row.object.length).toBeGreaterThan(0);
      expect(row.label.length).toBeGreaterThan(0);
    }
    expect(SIDEBAR.rows.find((row) => row.id === 'balances')?.object).toContain('balances');
    expect(SIDEBAR.rows.find((row) => row.id === 'transactions')?.object).toContain('money movements');
  });

  it('every row carries the stable nav.item.<id> testid', () => {
    for (const row of SIDEBAR.rows) {
      expect(row.testId).toBe(navItemTestId(row.id));
    }
  });
});

// ---------------------------------------------------------------------------
// The workload groups (contract 01 §3)
// ---------------------------------------------------------------------------

describe('sidebar workload groups (contract 01 §3)', () => {
  it('carries exactly the five groups in the contract order', () => {
    expect(SIDEBAR.groups.map((group) => group.slug)).toEqual([
      'accept',
      'bill',
      'insights',
      'capabilities',
      'more',
    ]);
    expect([...SIDEBAR_GROUP_SLUGS]).toEqual(['accept', 'bill', 'insights', 'capabilities', 'more']);
  });

  it('carries the contract item lists per group (labels, in order)', () => {
    const labels = (slug: SidebarGroupSlug): readonly string[] => {
      const group = SIDEBAR.groups.find((candidate) => candidate.slug === slug);
      if (group === undefined) {
        throw new Error(`missing group ${slug}`);
      }
      return group.items.map((item) => item.label);
    };
    expect(labels('accept')).toEqual([
      'Analytics',
      'Checkout',
      'Disputes',
      'Risk',
      'In-person/QR',
      'Agentic/links',
    ]);
    expect(labels('bill')).toEqual([
      'Overview',
      'Subscriptions',
      'Invoices',
      'Usage-based',
      'Dunning/Recovery',
    ]);
    expect(labels('insights')).toEqual(['Reports', 'Custom metrics', 'Exports', 'Data pipeline']);
    expect(labels('capabilities')).toEqual(['Installed', 'Browse']);
    expect(labels('more')).toEqual([
      'Tax/Compliance',
      'Connect/marketplace-payouts',
      'Identity',
      'Issuing',
      'Workflows',
      'Projects',
    ]);
  });

  it('every group carries the STABLE nav.group.<slug> testid (nav regression hook)', () => {
    for (const group of SIDEBAR.groups) {
      expect(group.testId).toBe(`nav.group.${group.slug}`);
      expect(group.testId).toBe(navGroupTestId(group.slug));
    }
  });

  it('every group item carries the stable nav.item.<slug> testid', () => {
    for (const group of SIDEBAR.groups) {
      for (const item of group.items) {
        expect(item.testId).toBe(navItemTestId(item.slug));
      }
    }
  });

  it('"More" is the only group ALLOWED to exceed 7 items; no other group does', () => {
    for (const group of SIDEBAR.groups) {
      if (group.slug === 'more') {
        continue; // the pressure valve — the only group allowed > 7
      }
      expect(group.items.length).toBeLessThanOrEqual(7);
    }
  });

  it('every route in the registry is unique', () => {
    const routes = [
      ...SIDEBAR.rows.map((row) => row.route),
      ...SIDEBAR.groups.flatMap((group) => group.items.map((item) => item.route)),
    ];
    expect(new Set(routes).size).toBe(routes.length);
  });
});

// ---------------------------------------------------------------------------
// Object-noun route slugs only (contract 01 §3 rule + §8 acceptance)
// ---------------------------------------------------------------------------

describe('route slugs are object-noun based (verb-slug grep finds none)', () => {
  // The grammar verbs in singular form + the classic verb page slugs. Contract
  // 01 §8: a grep for `/pay`, `/send`, `/create-` in route definitions must
  // return only modals/command handlers — never pages. Segment-exact matching
  // keeps object-nouns (`/payments`, `/invoices`, `/payment-links`) legal.
  const VERB_SEGMENTS: readonly string[] = [
    'pay',
    'send',
    'create',
    'make',
    'request',
    'convert',
    'invoice',
    'link',
    'withdraw',
    'transfer',
    'receive',
    'move',
    'cancel',
    'refund',
  ];

  const registryRoutes: readonly string[] = [
    ...SIDEBAR.rows.map((row) => row.route),
    ...SIDEBAR.groups.flatMap((group) => group.items.map((item) => item.route)),
  ];

  it('no route segment is a verb slug', () => {
    for (const route of registryRoutes) {
      for (const segment of route.split('/').filter((part) => part.length > 0)) {
        expect(VERB_SEGMENTS).not.toContain(segment);
      }
    }
  });

  it('no route segment starts with "create-"', () => {
    for (const route of registryRoutes) {
      for (const segment of route.split('/').filter((part) => part.length > 0)) {
        expect(segment.startsWith('create-')).toBe(false);
      }
    }
  });
});

// ---------------------------------------------------------------------------
// Create split-button (contract 01 §6)
// ---------------------------------------------------------------------------

describe('create menu (contract 01 §6)', () => {
  it('carries exactly the five create items with their chords', () => {
    expect(CREATE_MENU_ITEMS.map((item) => item.label)).toEqual([
      'Pay',
      'Request',
      'Invoice',
      'Payment link',
      'Convert',
    ]);
    expect(CREATE_MENU_ITEMS.map((item) => item.chord)).toEqual([
      'c p',
      'c r',
      'c i',
      'c l',
      'c v',
    ]);
  });

  it('every create item feeds a command grammar verb; the chord mapping agrees', () => {
    expect(CREATE_MENU_ITEMS.length).toBe(5);
    for (const item of CREATE_MENU_ITEMS) {
      expect(COMMAND_VERBS).toContain(item.verb);
      expect(commandVerbChord(item.verb)).toBe(item.chord);
    }
  });

  it('withdraw is NOT a create-menu item (it routes to the Balances withdraw flow)', () => {
    expect(CREATE_MENU_ITEMS.map((item) => item.verb)).not.toContain('withdraw');
    expect(commandVerbChord('withdraw')).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// Roles become PROJECTIONS (never a navigation axis)
// ---------------------------------------------------------------------------

describe('roles become projections (a role NEVER re-axes the navigation)', () => {
  const canonicalRowIds = SIDEBAR.rows.map((row) => row.id);
  const canonicalRowRoutes = SIDEBAR.rows.map((row) => row.route);
  const canonicalGroupSlugs = SIDEBAR.groups.map((group) => group.slug);

  it('every role sees the SAME five rows (ids, routes, order) and the SAME groups (slugs, order)', () => {
    for (const role of PRODUCT_ROLES) {
      const view = projectSidebar(role);
      expect(view.rows.map((entry) => entry.row.id)).toEqual(canonicalRowIds);
      expect(view.rows.map((entry) => entry.row.route)).toEqual(canonicalRowRoutes);
      expect(view.groups.map((entry) => entry.group.slug)).toEqual(canonicalGroupSlugs);
      // Group content is the registry itself, never a per-role copy.
      expect(view.groups.map((entry) => entry.group)).toEqual([...SIDEBAR.groups]);
    }
  });

  it('persistent rows are NEVER hidden for any role; "More" (the pressure valve) is NEVER hidden', () => {
    for (const role of PRODUCT_ROLES) {
      const projection = sidebarProjectionForRole(role);
      expect(projection.hiddenGroups).not.toContain('more');
      for (const slug of projection.hiddenGroups) {
        expect(SIDEBAR_GROUP_SLUGS).toContain(slug); // only workload groups can hide
      }
      // rows are structural: the projected output always contains all five.
      expect(projectSidebar(role).rows).toHaveLength(5);
    }
  });

  it('hidden and emphasized groups are disjoint; at least one group stays visible', () => {
    for (const role of PRODUCT_ROLES) {
      const projection = sidebarProjectionForRole(role);
      for (const slug of projection.emphasizedGroups) {
        expect(projection.hiddenGroups).not.toContain(slug);
      }
      const view = projectSidebar(role);
      expect(view.groups.some((entry) => entry.visible)).toBe(true);
    }
  });

  it('the consumer projection re-labels the money objects per contract 10 §2; merchant keeps canonical labels', () => {
    const borrower = projectSidebar('borrower');
    expect(borrower.projection).toBe('consumer');
    expect(borrower.rows.map((entry) => entry.label)).toEqual(
      SIDEBAR.rows.map((row) => CONSUMER_ROW_LABELS[row.id as SidebarPersistentRowId]),
    );
    for (const role of PRODUCT_ROLES.filter((candidate) => candidate !== 'borrower')) {
      const view = projectSidebar(role);
      expect(view.projection).toBe('merchant');
      expect(view.rows.map((entry) => entry.label)).toEqual(SIDEBAR.rows.map((row) => row.label));
    }
  });

  it('a merchant CAN switch projections on the same account (contract 10 §6 — same rows, re-labeled)', () => {
    const merchantDefault = projectSidebar('merchant');
    const merchantAsConsumer = projectSidebar('merchant', { projection: 'consumer' });
    expect(merchantDefault.projection).toBe('merchant');
    expect(merchantAsConsumer.projection).toBe('consumer');
    // Same navigation, only the projection changed:
    expect(merchantAsConsumer.rows.map((entry) => entry.row.id)).toEqual(
      merchantDefault.rows.map((entry) => entry.row.id),
    );
    expect(merchantAsConsumer.rows.find((entry) => entry.row.id === 'balances')?.label).toBe(
      'My balances',
    );
  });

  it('emphasis is a projection annotation: the emphasized set per role matches the fold table', () => {
    for (const role of PRODUCT_ROLES) {
      const view = projectSidebar(role);
      const emphasized = view.groups
        .filter((entry) => entry.emphasized)
        .map((entry) => entry.group.slug);
      // Set equality: emphasis order is not semantic — group ORDER is the contract.
      expect([...emphasized].sort()).toEqual([...sidebarProjectionForRole(role).emphasizedGroups].sort());
    }
    expect(projectSidebar('merchant').groups.find((entry) => entry.group.slug === 'accept')?.emphasized).toBe(
      true,
    );
  });
});

// ---------------------------------------------------------------------------
// The compatibility fold (existing ProductRole consumers keep working)
// ---------------------------------------------------------------------------

describe('compatibility fold: ProductRole → emphasized groups (additive)', () => {
  it('maps every existing role onto emphasized groups', () => {
    expect(emphasizedGroupsForRole('merchant')).toEqual(['accept', 'bill']);
    expect(emphasizedGroupsForRole('supplier')).toEqual(['bill']);
    expect(emphasizedGroupsForRole('lp')).toEqual(['insights']);
    expect(emphasizedGroupsForRole('developer')).toEqual(['capabilities']);
    for (const role of PRODUCT_ROLES) {
      for (const slug of emphasizedGroupsForRole(role)) {
        expect(SIDEBAR_GROUP_SLUGS).toContain(slug);
      }
    }
  });

  it('the fold table covers exactly the eight roles and fails closed on unknown roles', () => {
    expect(Object.keys(ROLE_SIDEBAR_PROJECTIONS).sort()).toEqual([...PRODUCT_ROLES].sort());
    expect(() => emphasizedGroupsForRole('nope' as never)).toThrow(/unknown product role/);
    expect(() => sidebarProjectionForRole('nope' as never)).toThrow(/unknown product role/);
  });

  it('the LEGACY navigation API is intact alongside the registry (additive convergence)', () => {
    // The pre-UX-002 exports still exist with their shapes: the Command Center
    // navigation, its grouped ids, and the role capability table.
    expect(PRODUCT_NAVIGATION.groups.map((group) => group.id)).toEqual(PRODUCT_NAV_GROUP_IDS);
    expect(ROLE_NAV_CAPABILITIES.merchant).toContain('payments.send');
    const legacyMerchantNavIds = projectSidebar; // (type-level presence smoke)
    expect(typeof legacyMerchantNavIds).toBe('function');
  });
});

// ---------------------------------------------------------------------------
// Type-level: the create-menu verbs are grammar verbs
// ---------------------------------------------------------------------------

describe('typed vocabulary linkage', () => {
  it('every create-menu verb is one of the six grammar verbs', () => {
    const verbs: readonly CommandVerb[] = COMMAND_VERBS;
    for (const item of CREATE_MENU_ITEMS) {
      expect(verbs).toContain(item.verb);
    }
  });
});
