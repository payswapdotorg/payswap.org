/**
 * @payswap/ux — the product information architecture (P3-W3-001).
 *
 * FRONTEND-UX-DEPLOYMENT ("PaySwap information architecture" / "Role-sensitive
 * navigation"): the product has EXPLICIT public and authenticated surfaces,
 * one grouped navigation model for the Command Center, and role-sensitive
 * navigation that DERIVES each of the eight roles' view of the SAME navigation
 * — never a separate product per role.
 *
 * This module is PURE data + derivation functions (package law: no DOM, no
 * network, no rendering, no ambient time, no entropy):
 *
 * - the SURFACE MAP (public vs authenticated) is explicit and total: every
 *   surface declares its kind, route and the honest-state contract that holds
 *   when data or authentication is absent (INV-X01: UNKNOWN renders
 *   reconciling on every surface; an absent dataset renders an honest EMPTY
 *   state, never an exception);
 * - the NAVIGATION MODEL is GROUPED (Overview / MONEY MOVEMENT / CAPABILITIES
 *   / TRUST / DEVELOP / ACCOUNT) and every item declares the CAPABILITY it
 *   requires as DATA — no hardcoded per-role booleans;
 * - ROLE-SENSITIVE NAVIGATION is a derivation: `deriveNavigationForRole`
 *   filters and annotates the same navigation by the role's capability set
 *   (visible / enabled / requires-attention), so no role ever sees another
 *   role's exclusive controls and adding a role or capability is a data edit;
 * - the ROUTE MODEL is typed with a pure resolver: route → surface, required
 *   access and required capabilities, plus deep-link validation
 *   (`resolveRouteAccess`) for every route and every viewer state.
 *
 * Consumed contracts (never duplicated): `CommandCenterDomain` from
 * command-center.ts binds each money/capability/trust surface to the
 * authority domain the Command Center already renders; product-journeys.ts
 * binds the seven journey contracts to the navigation ids defined here.
 */

import type { CommandCenterDomain } from './command-center.js';
import { ViewContractError } from './command-center.js';

// ---------------------------------------------------------------------------
// Roles and navigation capabilities
// ---------------------------------------------------------------------------

/**
 * The eight product roles (FRONTEND-UX-DEPLOYMENT "Role-sensitive navigation":
 * merchant, LP, lender, borrower, developer, expert and network-operator
 * workflows — plus supplier, the invoice-side participant). One navigation,
 * derived views per role; never separate products.
 */
export const PRODUCT_ROLES = [
  'merchant',
  'supplier',
  'lp',
  'lender',
  'borrower',
  'developer',
  'expert',
  'network-operator',
] as const;

export type ProductRole = (typeof PRODUCT_ROLES)[number];

/**
 * Product-level navigation capability tokens. These are INFORMATION-ARCHITECTURE
 * tokens (what a role may see in the navigation) — they carry NO financial
 * authority: financial authority remains exclusively in the protocol/API
 * authorization path (mandates, grants, approval artifacts).
 */
export const NAV_CAPABILITIES = [
  'payments.send',
  'payments.collect',
  'payouts.request',
  'billing.manage',
  'credit.manage',
  'liquidity.provide',
  'capabilities.manage',
  'agents.manage',
  'opportunities.view',
  'programs.manage',
  'disputes.manage',
  'evidence.view',
  'developers.manage',
  'settings.manage',
  'network.operate',
] as const;

export type NavCapabilityId = (typeof NAV_CAPABILITIES)[number];

/**
 * The capability set of each role, as DATA. The derivation below never
 * hardcodes a role-to-item decision: it joins this table with the nav items'
 * declared requirements. A role's exclusive controls are therefore exactly the
 * items whose requirements only that role's capabilities satisfy.
 */
const ROLE_CAPS_TABLE: Readonly<Record<ProductRole, readonly NavCapabilityId[]>> = {
  merchant: [
    'payments.send',
    'payments.collect',
    'payouts.request',
    'billing.manage',
    'credit.manage',
    'capabilities.manage',
    'agents.manage',
    'programs.manage',
    'disputes.manage',
    'evidence.view',
    'settings.manage',
  ],
  supplier: [
    'payments.send',
    'payments.collect',
    'disputes.manage',
    'evidence.view',
    'settings.manage',
  ],
  lp: [
    'liquidity.provide',
    'payouts.request',
    'opportunities.view',
    'evidence.view',
    'settings.manage',
  ],
  lender: [
    'credit.manage',
    'payments.collect',
    'payouts.request',
    'evidence.view',
    'settings.manage',
  ],
  borrower: [
    'credit.manage',
    'payments.send',
    'billing.manage',
    'evidence.view',
    'settings.manage',
  ],
  developer: [
    'developers.manage',
    'capabilities.manage',
    'payments.send',
    'evidence.view',
    'settings.manage',
  ],
  expert: [
    'opportunities.view',
    'disputes.manage',
    'evidence.view',
    'settings.manage',
  ],
  'network-operator': [
    'network.operate',
    'capabilities.manage',
    'disputes.manage',
    'evidence.view',
    'settings.manage',
  ],
};

export const ROLE_NAV_CAPABILITIES: Readonly<Record<ProductRole, readonly NavCapabilityId[]>> =
  Object.freeze(ROLE_CAPS_TABLE);

/** The capability set a role holds (pure lookup, fail-closed on unknown roles). */
export function roleCapabilities(role: ProductRole): readonly NavCapabilityId[] {
  const capabilities = ROLE_NAV_CAPABILITIES[role];
  if (capabilities === undefined) {
    throw new ViewContractError(`unknown product role: ${String(role)}`);
  }
  return capabilities;
}

// ---------------------------------------------------------------------------
// The surface map — public vs authenticated, with honest-state contracts
// ---------------------------------------------------------------------------

export const PRODUCT_SURFACE_IDS = [
  'home',
  'capabilities-explorer',
  'security',
  'developers',
  'demo-sandbox',
  'command-center',
] as const;

export type ProductSurfaceId = (typeof PRODUCT_SURFACE_IDS)[number];

export type ProductSurfaceKind = 'public' | 'authenticated';

/**
 * The honest-state contract of a surface (FRONTEND-UX-DEPLOYMENT "State
 * rendering" + INV-X01): what the surface renders when its data is absent and
 * when authentication is absent. Absent data is an EMPTY STATE derived from
 * the absent dataset — never an exception and never a fabricated state; an
 * absent authentication is an explicit AUTHENTICATION_REQUIRED treatment on
 * authenticated surfaces (public surfaces require none); UNKNOWN is rendered
 * `reconciling` on every surface — never failure.
 */
export interface SurfaceHonestStateContract {
  readonly dataAbsent: 'EMPTY_STATE';
  readonly authAbsent: 'AUTHENTICATION_REQUIRED' | 'NOT_REQUIRED';
  readonly unknownRenders: 'RECONCILING_NEVER_FAILURE';
  readonly emptyStateGuidance: string;
}

export interface ProductSurface {
  readonly id: ProductSurfaceId;
  readonly kind: ProductSurfaceKind;
  readonly route: string;
  readonly title: string;
  readonly summary: string;
  readonly honestState: SurfaceHonestStateContract;
  /** Demo/sandbox surfaces are explicitly MARKED (never silently substituted). */
  readonly markedDemo?: boolean;
}

function publicHonestState(guidance: string): SurfaceHonestStateContract {
  return Object.freeze({
    dataAbsent: 'EMPTY_STATE',
    authAbsent: 'NOT_REQUIRED',
    unknownRenders: 'RECONCILING_NEVER_FAILURE',
    emptyStateGuidance: guidance,
  });
}

function authenticatedHonestState(guidance: string): SurfaceHonestStateContract {
  return Object.freeze({
    dataAbsent: 'EMPTY_STATE',
    authAbsent: 'AUTHENTICATION_REQUIRED',
    unknownRenders: 'RECONCILING_NEVER_FAILURE',
    emptyStateGuidance: guidance,
  });
}

/**
 * The explicit surface map. PUBLIC: home, capabilities/coverage explorer,
 * security/non-custody explanation, developers, demo/sandbox (marked).
 * AUTHENTICATED: the Command Center — the single authenticated product
 * surface (W3-006): one view-model layer, one navigation, role-derived views.
 */
export const PRODUCT_SURFACES: readonly ProductSurface[] = Object.freeze([
  Object.freeze({
    id: 'home',
    kind: 'public',
    route: '/',
    title: 'PaySwap',
    summary:
      'The public entry surface: what PaySwap does, who it is for, and the paths into capabilities, security and developer material.',
    honestState: publicHonestState(
      'with no published content the home surface renders an honest empty hero — never placeholder financial claims',
    ),
  }),
  Object.freeze({
    id: 'capabilities-explorer',
    kind: 'public',
    route: '/capabilities',
    title: 'Capabilities and coverage',
    summary:
      'The public coverage explorer: which providers, corridors, currencies and methods the network covers, with HONEST verdicts (catalogue availability is clearly not connected capability).',
    honestState: publicHonestState(
      'with no coverage observations the explorer renders an honest empty coverage matrix with UNKNOWN verdicts — absence of knowledge is not absence of coverage, and neither is failure',
    ),
  }),
  Object.freeze({
    id: 'security',
    kind: 'public',
    route: '/security',
    title: 'Security and non-custody',
    summary:
      'The public security/non-custody explanation: how authorization, evidence and non-custodial money movement work.',
    honestState: publicHonestState(
      'static explanation surface; no dataset is expected and none is fabricated',
    ),
  }),
  Object.freeze({
    id: 'developers',
    kind: 'public',
    route: '/developers',
    title: 'Developers',
    summary:
      'The public developer surface: API reference, contract conformance, sandbox onboarding. No credential material ever renders here — only opaque references.',
    honestState: publicHonestState(
      'with no published reference material the developer surface states exactly that — an honest empty index',
    ),
  }),
  Object.freeze({
    id: 'demo-sandbox',
    kind: 'public',
    route: '/demo',
    title: 'Demo and sandbox',
    summary:
      'The MARKED demo/sandbox surface. It shares the one protocol pipeline; it never silently substitutes fake financial state behind production UI.',
    markedDemo: true,
    honestState: publicHonestState(
      'an unreachable sandbox renders an honest unavailable state — demo unavailability is never presented as a financial outcome',
    ),
  }),
  Object.freeze({
    id: 'command-center',
    kind: 'authenticated',
    route: '/command-center',
    title: 'Command Center',
    summary:
      'The single authenticated product surface: the universal Command Center (search, universal inbox, Work-Graph context, economic controls) with role-derived navigation.',
    honestState: authenticatedHonestState(
      'without authentication the surface asks for authentication; with authentication and no authority records it renders honest empty states (an empty snapshot is still an honest snapshot)',
    ),
  }),
]);

/** Every public surface (ordered as declared). */
export function publicSurfaces(): readonly ProductSurface[] {
  return Object.freeze(PRODUCT_SURFACES.filter((surface) => surface.kind === 'public'));
}

/** Every authenticated surface (the Command Center). */
export function authenticatedSurfaces(): readonly ProductSurface[] {
  return Object.freeze(PRODUCT_SURFACES.filter((surface) => surface.kind === 'authenticated'));
}

/** Look up one surface by id (fail-closed on unknown ids). */
export function surfaceById(id: ProductSurfaceId): ProductSurface {
  const surface = PRODUCT_SURFACES.find((candidate) => candidate.id === id);
  if (surface === undefined) {
    throw new ViewContractError(`unknown product surface: ${String(id)}`);
  }
  return surface;
}

// ---------------------------------------------------------------------------
// The grouped navigation model
// ---------------------------------------------------------------------------

export const PRODUCT_NAV_GROUP_IDS = [
  'OVERVIEW',
  'MONEY_MOVEMENT',
  'CAPABILITIES',
  'TRUST',
  'DEVELOP',
  'ACCOUNT',
] as const;

export type ProductNavGroupId = (typeof PRODUCT_NAV_GROUP_IDS)[number];

export const PRODUCT_NAV_ITEM_IDS = [
  'overview',
  'activity',
  'payments',
  'collections',
  'payouts',
  'billing',
  'credit',
  'liquidity',
  'capabilities',
  'agents',
  'opportunities',
  'programs',
  'disputes',
  'evidence',
  'developers',
  'settings',
] as const;

export type ProductNavItemId = (typeof PRODUCT_NAV_ITEM_IDS)[number];

/**
 * One navigation item. `requiresCapabilities` is the DERIVED requirement
 * (any-of semantics): the item is visible to a role that holds at least one
 * of these capability tokens. An empty list means every authenticated role
 * sees the item. `commandCenterDomain` binds the item to the authority domain
 * the Command Center already renders for it (consumed from command-center.ts;
 * undefined means the surface is an aggregate or has no single domain).
 */
export interface ProductNavItem {
  readonly id: ProductNavItemId;
  readonly label: string;
  readonly group: ProductNavGroupId;
  readonly route: string;
  readonly requiresCapabilities: readonly NavCapabilityId[];
  readonly commandCenterDomain?: CommandCenterDomain;
  readonly summary: string;
}

export interface ProductNavGroup {
  readonly id: ProductNavGroupId;
  readonly label: string;
  readonly items: readonly ProductNavItem[];
}

export interface ProductNavigation {
  readonly groups: readonly ProductNavGroup[];
}

function navItem(
  item: Omit<ProductNavItem, 'commandCenterDomain'> & { readonly commandCenterDomain?: CommandCenterDomain },
): ProductNavItem {
  return Object.freeze({
    ...item,
    requiresCapabilities: Object.freeze([...item.requiresCapabilities]),
    ...(item.commandCenterDomain === undefined ? {} : { commandCenterDomain: item.commandCenterDomain }),
  });
}

const OVERVIEW_ITEMS: readonly ProductNavItem[] = Object.freeze([
  navItem({
    id: 'overview',
    label: 'Overview',
    group: 'OVERVIEW',
    route: '/command-center',
    requiresCapabilities: [],
    summary: 'The Command Center home: derived inbox, approvals, executions and provider plane at a glance.',
  }),
  navItem({
    id: 'activity',
    label: 'Activity',
    group: 'OVERVIEW',
    route: '/command-center/activity',
    requiresCapabilities: [],
    summary: 'All authority activity for the viewer, searchable across domains.',
  }),
]);

const MONEY_MOVEMENT_ITEMS: readonly ProductNavItem[] = Object.freeze([
  navItem({
    id: 'payments',
    label: 'Payments',
    group: 'MONEY_MOVEMENT',
    route: '/command-center/payments',
    requiresCapabilities: ['payments.send', 'payments.collect'],
    commandCenterDomain: 'EXECUTION',
    summary: 'Pay recipients: capability selection from connected instances only, route review, approvals, tracking.',
  }),
  navItem({
    id: 'collections',
    label: 'Collections',
    group: 'MONEY_MOVEMENT',
    route: '/command-center/collections',
    requiresCapabilities: ['payments.collect'],
    commandCenterDomain: 'INTENT',
    summary: 'Request payments where a connected capability permits, share the request, track fulfillment.',
  }),
  navItem({
    id: 'payouts',
    label: 'Payouts',
    group: 'MONEY_MOVEMENT',
    route: '/command-center/payouts',
    requiresCapabilities: ['payouts.request'],
    commandCenterDomain: 'EXECUTION',
    summary: 'Request payouts to an EXPLICIT external destination under withdrawal-scoped authorization.',
  }),
  navItem({
    id: 'billing',
    label: 'Billing',
    group: 'MONEY_MOVEMENT',
    route: '/command-center/billing',
    requiresCapabilities: ['billing.manage'],
    commandCenterDomain: 'REMITTANCE',
    summary: 'Billing documents and their remittance allocations.',
  }),
  navItem({
    id: 'credit',
    label: 'Credit',
    group: 'MONEY_MOVEMENT',
    route: '/command-center/credit',
    requiresCapabilities: ['credit.manage'],
    commandCenterDomain: 'INTENT',
    summary: 'Financing intents: borrowing and lending workflows on the same intent/approval machinery.',
  }),
  navItem({
    id: 'liquidity',
    label: 'Liquidity',
    group: 'MONEY_MOVEMENT',
    route: '/command-center/liquidity',
    requiresCapabilities: ['liquidity.provide'],
    commandCenterDomain: 'INTENT',
    summary: 'Liquidity provision positions — observations of external positions, never PaySwap custody.',
  }),
]);

const CAPABILITY_ITEMS: readonly ProductNavItem[] = Object.freeze([
  navItem({
    id: 'capabilities',
    label: 'Capabilities',
    group: 'CAPABILITIES',
    route: '/command-center/capabilities',
    requiresCapabilities: ['capabilities.manage', 'network.operate'],
    commandCenterDomain: 'CAPABILITY',
    summary: 'Connect existing providers/rails: catalogue browsing, connection lifecycle, honest health and coverage.',
  }),
  navItem({
    id: 'agents',
    label: 'Agents',
    group: 'CAPABILITIES',
    route: '/command-center/agents',
    requiresCapabilities: ['agents.manage'],
    commandCenterDomain: 'PARTICIPATION',
    summary: 'Agents as visible collaborators: what they propose, their authority, and which actions need approval.',
  }),
  navItem({
    id: 'opportunities',
    label: 'Opportunities',
    group: 'CAPABILITIES',
    route: '/command-center/opportunities',
    requiresCapabilities: ['opportunities.view'],
    commandCenterDomain: 'PARTICIPATION',
    summary: 'Work opportunities and participation surfaces.',
  }),
  navItem({
    id: 'programs',
    label: 'Programs and incentives',
    group: 'CAPABILITIES',
    route: '/command-center/programs',
    requiresCapabilities: ['programs.manage'],
    commandCenterDomain: 'INCENTIVE',
    summary: 'Incentive programs (versioned, budget-reserved obligations).',
  }),
]);

const TRUST_ITEMS: readonly ProductNavItem[] = Object.freeze([
  navItem({
    id: 'disputes',
    label: 'Disputes',
    group: 'TRUST',
    route: '/command-center/disputes',
    requiresCapabilities: ['disputes.manage'],
    commandCenterDomain: 'DISPUTE',
    summary: 'Disputes with provider lifecycle states preserved verbatim (INV-C06).',
  }),
  navItem({
    id: 'evidence',
    label: 'Evidence',
    group: 'TRUST',
    route: '/command-center/evidence',
    requiresCapabilities: ['evidence.view'],
    commandCenterDomain: 'EVIDENCE',
    summary: 'Evidence for external financial actions with provenance strength (INV-E04).',
  }),
]);

const DEVELOP_ITEMS: readonly ProductNavItem[] = Object.freeze([
  navItem({
    id: 'developers',
    label: 'Developers',
    group: 'DEVELOP',
    route: '/command-center/developers',
    requiresCapabilities: ['developers.manage'],
    summary: 'Keys (opaque references only), webhooks, sandbox — the authenticated developer surface.',
  }),
]);

const ACCOUNT_ITEMS: readonly ProductNavItem[] = Object.freeze([
  navItem({
    id: 'settings',
    label: 'Settings',
    group: 'ACCOUNT',
    route: '/command-center/settings',
    requiresCapabilities: ['settings.manage'],
    summary: 'Account, roles and authorization surface settings.',
  }),
]);

/**
 * The Command Center navigation model — GROUPED sections, one navigation for
 * all roles (FRONTEND-UX-DEPLOYMENT initial top-level surfaces, grouped).
 */
export const PRODUCT_NAVIGATION: ProductNavigation = Object.freeze({
  groups: Object.freeze([
    Object.freeze({ id: 'OVERVIEW', label: 'Overview', items: OVERVIEW_ITEMS }),
    Object.freeze({ id: 'MONEY_MOVEMENT', label: 'Money movement', items: MONEY_MOVEMENT_ITEMS }),
    Object.freeze({ id: 'CAPABILITIES', label: 'Capabilities', items: CAPABILITY_ITEMS }),
    Object.freeze({ id: 'TRUST', label: 'Trust', items: TRUST_ITEMS }),
    Object.freeze({ id: 'DEVELOP', label: 'Develop', items: DEVELOP_ITEMS }),
    Object.freeze({ id: 'ACCOUNT', label: 'Account', items: ACCOUNT_ITEMS }),
  ]),
});

/** Every navigation item, flat, in navigation order. */
export function navigationItems(navigation: ProductNavigation = PRODUCT_NAVIGATION): readonly ProductNavItem[] {
  return Object.freeze(navigation.groups.flatMap((group) => group.items));
}

/** Look up one navigation item by id (fail-closed on unknown ids). */
export function navItemById(id: ProductNavItemId, navigation: ProductNavigation = PRODUCT_NAVIGATION): ProductNavItem {
  const item = navigationItems(navigation).find((candidate) => candidate.id === id);
  if (item === undefined) {
    throw new ViewContractError(`unknown navigation item: ${String(id)}`);
  }
  return item;
}

// ---------------------------------------------------------------------------
// Role-sensitive navigation — the DERIVED view of the same navigation
// ---------------------------------------------------------------------------

/**
 * Authority-derived context for one navigation derivation:
 * - `attentionNavIds` marks items the AUTHORITY flagged as requiring
 *   attention (e.g. derived from the universal inbox: an awaiting approval or
 *   an UNKNOWN-outcome execution maps to its surface);
 * - `disabledNavIds` marks items the AUTHORITY currently disables with an
 *   honest reason (e.g. no connected capability instance permits payouts yet).
 *   Both are inputs — the derivation never invents them.
 */
export interface RoleNavigationAuthorityContext {
  readonly attentionNavIds?: readonly ProductNavItemId[];
  readonly disabledNavIds?: readonly ProductNavItemId[];
  readonly disabledReason?: string;
}

export interface RoleNavItemView {
  readonly item: ProductNavItem;
  readonly visible: boolean;
  readonly enabled: boolean;
  readonly requiresAttention: boolean;
  /** The capability that granted visibility (present when visible and the item requires one). */
  readonly viaCapability?: NavCapabilityId;
  /** Honest reason whenever the item is visible but disabled. */
  readonly disabledReason?: string;
}

export interface RoleNavGroupView {
  readonly group: ProductNavGroup;
  readonly items: readonly RoleNavItemView[];
}

export interface RoleNavigationView {
  readonly role: ProductRole;
  readonly groups: readonly RoleNavGroupView[];
  /** Flat visible items in navigation order (the enabled subset is derivable). */
  readonly items: readonly RoleNavItemView[];
}

/**
 * Derive one role's view of the SAME navigation. Visibility is a pure join:
 * the item is visible iff the role holds at least one of the item's required
 * capability tokens (items with no requirement are visible to every
 * authenticated role). Enabled refines visible with the authority-provided
 * disable flags; requires-attention comes from the authority-provided
 * attention flags. Nothing here is a hardcoded role-to-item boolean.
 */
export function deriveNavigationForRole(
  navigation: ProductNavigation,
  role: ProductRole,
  authority?: RoleNavigationAuthorityContext,
): RoleNavigationView {
  const capabilities = roleCapabilities(role);
  const attention = new Set<ProductNavItemId>(authority?.attentionNavIds ?? []);
  const disabled = new Set<ProductNavItemId>(authority?.disabledNavIds ?? []);

  const groupViews: RoleNavGroupView[] = [];
  const flat: RoleNavItemView[] = [];
  for (const group of navigation.groups) {
    const itemViews: RoleNavItemView[] = [];
    for (const item of group.items) {
      const grantedBy = item.requiresCapabilities.find((capability) => capabilities.includes(capability));
      const visible = item.requiresCapabilities.length === 0 || grantedBy !== undefined;
      if (!visible) {
        continue;
      }
      const enabled = !disabled.has(item.id);
      const view: RoleNavItemView = Object.freeze({
        item,
        visible: true,
        enabled,
        requiresAttention: attention.has(item.id),
        ...(grantedBy === undefined ? {} : { viaCapability: grantedBy }),
        ...(enabled ? {} : { disabledReason: authority?.disabledReason ?? 'currently unavailable per authority state' }),
      });
      itemViews.push(view);
      flat.push(view);
    }
    groupViews.push(Object.freeze({ group, items: Object.freeze(itemViews) }));
  }
  return Object.freeze({
    role,
    groups: Object.freeze(groupViews),
    items: Object.freeze(flat),
  });
}

/** The nav items a role can see (ids only, in navigation order). */
export function visibleNavIds(
  navigation: ProductNavigation,
  role: ProductRole,
  authority?: RoleNavigationAuthorityContext,
): readonly ProductNavItemId[] {
  return Object.freeze(deriveNavigationForRole(navigation, role, authority).items.map((view) => view.item.id));
}

// ---------------------------------------------------------------------------
// The typed route model + the pure resolver
// ---------------------------------------------------------------------------

export type RouteAccessLevel = 'PUBLIC' | 'AUTHENTICATED';

export interface ProductRoute {
  readonly id: string;
  readonly path: string;
  readonly surface: ProductSurfaceId;
  readonly access: RouteAccessLevel;
  /** Required navigation capabilities (any-of); empty means no capability requirement. */
  readonly requiredCapabilities: readonly NavCapabilityId[];
  /** The navigation item owning this route, when there is one. */
  readonly navItem?: ProductNavItemId;
  readonly markedDemo?: boolean;
}

function surfaceRoutes(): ProductRoute[] {
  return PRODUCT_SURFACES.map((surface) => ({
    id: `surface.${surface.id}`,
    path: surface.route,
    surface: surface.id,
    access: surface.kind === 'public' ? ('PUBLIC' as const) : ('AUTHENTICATED' as const),
    requiredCapabilities: Object.freeze([]),
    ...(surface.id === 'command-center' ? { navItem: 'overview' as const } : {}),
    ...(surface.markedDemo === undefined ? {} : { markedDemo: surface.markedDemo }),
  }));
}

function navRoutes(navigation: ProductNavigation): ProductRoute[] {
  const routes: ProductRoute[] = [];
  for (const item of navigationItems(navigation)) {
    if (item.route === '/command-center') {
      // The Command Center root is already the overview surface route.
      continue;
    }
    routes.push({
      id: `command-center.${item.id}`,
      path: item.route,
      surface: 'command-center',
      access: 'AUTHENTICATED',
      requiredCapabilities: Object.freeze([...item.requiresCapabilities]),
      navItem: item.id,
    });
  }
  return routes;
}

/**
 * The typed route model: one route per public surface plus one route per
 * Command Center navigation item. Paths are unique; the surface partition is
 * total (every route's access level matches its surface kind).
 */
export function productRoutes(navigation: ProductNavigation = PRODUCT_NAVIGATION): readonly ProductRoute[] {
  return Object.freeze([...surfaceRoutes(), ...navRoutes(navigation)].map((route) => Object.freeze(route)));
}

export type RouteResolution =
  | { readonly kind: 'RESOLVED'; readonly route: ProductRoute }
  | { readonly kind: 'UNKNOWN_ROUTE'; readonly path: string };

/** Resolve a route path to its typed route definition (pure, exact match). */
export function resolveProductRoute(
  path: string,
  navigation: ProductNavigation = PRODUCT_NAVIGATION,
): RouteResolution {
  const route = productRoutes(navigation).find((candidate) => candidate.path === path);
  if (route === undefined) {
    return Object.freeze({ kind: 'UNKNOWN_ROUTE', path });
  }
  return Object.freeze({ kind: 'RESOLVED', route });
}

/** The viewer a deep-link access decision is derived for. */
export interface RouteViewer {
  readonly authenticated: boolean;
  readonly role?: ProductRole;
}

export type RouteAccessDecision =
  | { readonly kind: 'PUBLIC_ACCESS'; readonly route: ProductRoute }
  | {
      readonly kind: 'GRANTED';
      readonly route: ProductRoute;
      readonly viaCapabilities: readonly NavCapabilityId[];
    }
  | { readonly kind: 'AUTHENTICATION_REQUIRED'; readonly route: ProductRoute }
  | {
      readonly kind: 'CAPABILITY_REQUIRED';
      readonly route: ProductRoute;
      readonly missing: readonly NavCapabilityId[];
      /** The viewer's established role, when one is known. */
      readonly role?: ProductRole;
    };

/**
 * Pure deep-link validation: resolve the route, then derive the access
 * decision for the viewer. Public routes are PUBLIC_ACCESS for everyone;
 * authenticated routes require authentication first, then the role must hold
 * at least one required capability (the derivation joins the SAME capability
 * data the navigation uses — one source of truth).
 */
export function resolveRouteAccess(
  path: string,
  viewer: RouteViewer,
  navigation: ProductNavigation = PRODUCT_NAVIGATION,
): RouteAccessDecision {
  const resolution = resolveProductRoute(path, navigation);
  if (resolution.kind === 'UNKNOWN_ROUTE') {
    throw new ViewContractError(`no route resolves for path '${path}' (deep link rejected, fail closed)`);
  }
  const route = resolution.route;
  if (route.access === 'PUBLIC') {
    return Object.freeze({ kind: 'PUBLIC_ACCESS', route });
  }
  if (!viewer.authenticated) {
    return Object.freeze({ kind: 'AUTHENTICATION_REQUIRED', route });
  }
  if (route.requiredCapabilities.length === 0) {
    return Object.freeze({ kind: 'GRANTED', route, viaCapabilities: Object.freeze([]) });
  }
  const role = viewer.role;
  if (role === undefined) {
    return Object.freeze({
      kind: 'CAPABILITY_REQUIRED',
      route,
      missing: Object.freeze([...route.requiredCapabilities]),
    });
  }
  const capabilities = roleCapabilities(role);
  const via = route.requiredCapabilities.filter((capability) => capabilities.includes(capability));
  if (via.length === 0) {
    return Object.freeze({
      kind: 'CAPABILITY_REQUIRED',
      route,
      missing: Object.freeze([...route.requiredCapabilities]),
      role,
    });
  }
  return Object.freeze({ kind: 'GRANTED', route, viaCapabilities: Object.freeze(via) });
}

/**
 * Deep-link validation result for UI consumption: a deep link is VALID when
 * the route resolves AND the viewer is granted access; otherwise the decision
 * carries the honest guidance (never an exception — absent access is a
 * derived state).
 */
export interface DeepLinkValidation {
  readonly valid: boolean;
  readonly decision: RouteAccessDecision;
  readonly guidance: string;
}

export function validateDeepLink(
  path: string,
  viewer: RouteViewer,
  navigation: ProductNavigation = PRODUCT_NAVIGATION,
): DeepLinkValidation {
  const decision = resolveRouteAccess(path, viewer, navigation);
  switch (decision.kind) {
    case 'PUBLIC_ACCESS':
      return {
        valid: true,
        decision,
        guidance: 'public surface — no authentication required',
      };
    case 'GRANTED':
      return {
        valid: true,
        decision,
        guidance:
          decision.viaCapabilities.length === 0
            ? 'authenticated surface — visible to every authenticated role'
            : `authenticated surface — granted via ${decision.viaCapabilities.join(', ')}`,
      };
    case 'AUTHENTICATION_REQUIRED':
      return {
        valid: false,
        decision,
        guidance: 'this surface requires authentication; sign in to continue (the deep link stays valid)',
      };
    case 'CAPABILITY_REQUIRED':
      return {
        valid: false,
        decision,
        guidance:
          decision.role === undefined
            ? `no role is established for this viewer; the surface requires one of: ${decision.missing.join(', ')}`
            : `the '${decision.role}' role does not hold any of: ${decision.missing.join(', ')}`,
      };
    default: {
      const exhaustive: never = decision;
      throw new ViewContractError(`unhandled route access decision: ${String(exhaustive)}`);
    }
  }
}
