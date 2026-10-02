import { describe, expect, it } from "vitest";
import {
  AUTHORIZATION_MODES,
  CredentialBroker,
  CredentialBrokerError,
  SealedCredentialBundle,
  descriptorModeViolations,
  isAuthorizationArtifactRef,
  isBrowserSessionRef,
  isProviderCredentialConfigKey,
  isSealedHandleExpired,
  isVaultReference,
  mintAuthorizationArtifactRef,
  mintBrowserSessionRef,
  providerCredentialConfigKey,
  providerNameFromCredentialConfigKey,
  sanitizeForLogs,
  vaultReference,
} from "../src/credential-broker.js";
import type {
  AuthorizationArtifactRef,
  BrowserSessionRef,
  ConnectorRuntimeKey,
  CredentialBundleDescriptor,
  SealedCredentialHandle,
  VaultStore,
} from "../src/credential-broker.js";

// ---------------------------------------------------------------------------
// Synthetic fixtures ONLY (P2-W1-001 hard law: no real credential values in
// Git, agent context, logs or protocol events). Every "secret" below is a
// syntactically valid but SYNTHETIC marker.
// ---------------------------------------------------------------------------

const SYNTHETIC_API_KEY = "sk_test_SYNTHETICSTRIPE0000000000";
const SYNTHETIC_WEBHOOK_SECRET = "whsec_SYNTHETIC0000000000000000000000";
const SYNTHETIC_BROWSER_COOKIE = "SESSIONID=synthetic-cookie-value-000000";
const SYNTHETIC_BEARER = "Bearer eyJhbGciOiJub25lIn0.synthetic.payload0000";

const T0 = "2026-10-02T06:37:38Z";
const T1 = "2026-12-01T00:00:00Z";

function scopedDescriptor(
  overrides: Partial<CredentialBundleDescriptor> = {},
): CredentialBundleDescriptor {
  return {
    providerName: "STRIPE",
    authorizationMode: "SCOPED_API_CREDENTIAL",
    vaultReference: vaultReference("vault://payswap/providers/stripe/test-20261002"),
    issuedAt: T0,
    accountRef: "acct_SYNTHETIC",
    tenantRef: "tenant_SYNTHETIC",
    countries: ["FR"],
    currencies: ["EUR", "USD"],
    grantedPermissions: ["card_payments", "transfers"],
    ...overrides,
  } as CredentialBundleDescriptor;
}

/** An in-memory vault fixture: config keys → vault refs → sealed bundles. */
class FixtureVault implements VaultStore {
  readonly storeId = "fixture-vault";
  readonly #bindings = new Map<string, string>();
  readonly #bundles = new Map<string, SealedCredentialBundle>();

  bind(configKey: string, reference: string): this {
    this.#bindings.set(configKey, reference);
    return this;
  }

  seal(reference: string, descriptor: CredentialBundleDescriptor, material: unknown): this {
    this.#bundles.set(reference, new SealedCredentialBundle(descriptor, material));
    return this;
  }

  resolve(reference: string): SealedCredentialBundle | undefined {
    return this.#bundles.get(reference);
  }

  referenceBoundTo(configKey: string): string | undefined {
    return this.#bindings.get(configKey);
  }
}

function brokerWithStripe(): {
  readonly broker: CredentialBroker;
  readonly vault: FixtureVault;
} {
  const vault = new FixtureVault()
    .bind(
      "PROVIDER_STRIPE_CREDENTIAL_REF",
      "vault://payswap/providers/stripe/test-20261002",
    )
    .seal(
      "vault://payswap/providers/stripe/test-20261002",
      scopedDescriptor(),
      { apiKey: SYNTHETIC_API_KEY, webhookSecret: SYNTHETIC_WEBHOOK_SECRET },
    );
  return { broker: new CredentialBroker({ store: vault }), vault };
}

describe("authorization-mode vocabulary (P2-W1-001)", () => {
  it("is the explicit five-mode union from the phase-2 authorization spec", () => {
    expect([...AUTHORIZATION_MODES]).toEqual([
      "DELEGATED_OAUTH",
      "CONNECTED_ACCOUNT",
      "SCOPED_API_CREDENTIAL",
      "INTERACTIVE_BROWSER_SESSION",
      "PROVIDERLESS_RAIL",
    ]);
  });

  it("config keys follow the PROVIDER_<NAME>_CREDENTIAL_REF template", () => {
    expect(providerCredentialConfigKey("stripe")).toBe("PROVIDER_STRIPE_CREDENTIAL_REF");
    expect(providerCredentialConfigKey("MTN_MOMO")).toBe("PROVIDER_MTN_MOMO_CREDENTIAL_REF");
    expect(providerCredentialConfigKey("stellar-testnet")).toBe(
      "PROVIDER_STELLAR_TESTNET_CREDENTIAL_REF",
    );
    expect(providerNameFromCredentialConfigKey("PROVIDER_PAYSTACK_CREDENTIAL_REF")).toBe(
      "PAYSTACK",
    );
    expect(providerNameFromCredentialConfigKey("STRIPE_API_KEY")).toBeUndefined();
    expect(isProviderCredentialConfigKey("PROVIDER_FLUTTERWAVE_CREDENTIAL_REF")).toBe(true);
    expect(isProviderCredentialConfigKey("STRIPE_KEY")).toBe(false);
    expect(() => providerCredentialConfigKey("stripe_prod!!")).toThrow();
  });
});

describe("opaque branded references", () => {
  it("mints AuthorizationArtifactRef only in the authorization:// shape", () => {
    const ref = mintAuthorizationArtifactRef(
      "authorization://stripe/grant-20261002-0001",
    );
    expect(isAuthorizationArtifactRef(ref)).toBe(true);
    expect(isAuthorizationArtifactRef("not-a-ref")).toBe(false);
    expect(() =>
      mintAuthorizationArtifactRef("authorization://stripe/grant with spaces"),
    ).toThrow();
    expect(() => mintAuthorizationArtifactRef("")).toThrow();
  });

  it("mints BrowserSessionRef only in the browser-session:// shape", () => {
    const ref = mintBrowserSessionRef(
      "browser-session://secure-browser-eu-1/sess-0001",
    );
    expect(isBrowserSessionRef(ref)).toBe(true);
    expect(isBrowserSessionRef("cookie-value-should-never-be-a-ref")).toBe(false);
    expect(() =>
      mintBrowserSessionRef("browser-session://runtime/illegal/slashes"),
    ).toThrow();
  });

  it("brands vault references and rejects non-vault shapes", () => {
    expect(
      isVaultReference(vaultReference("vault://payswap/providers/stripe/test-20261002")),
    ).toBe(true);
    expect(() => vaultReference("sk_live_should_not_be_a_vault_ref")).toThrow();
    expect(isVaultReference("file:///etc/passwd")).toBe(false);
  });

  it("exposes NO accessor from a ref to underlying material (type-level opacity)", () => {
    // The branded types are strings with unnameable phantom brands: the only
    // things an agent can do with an AuthorizationArtifactRef is carry it and
    // compare it. There is deliberately no `artifact()`, `value()` or
    // `material()` anywhere on the agent-visible surface.
    const artifact: AuthorizationArtifactRef = mintAuthorizationArtifactRef(
      "authorization://stripe/grant-20261002-0001",
    );
    const session: BrowserSessionRef = mintBrowserSessionRef(
      "browser-session://secure-browser-eu-1/sess-0001",
    );
    // String primitives inherently enumerate their character indices; the
    // opacity contract is that NO accessor/extra property exists beyond that.
    const nonIndexKeys = (value: string): readonly string[] =>
      Object.keys(value).filter((key) => !/^\d+$/.test(key));
    expect(nonIndexKeys(artifact)).toEqual([]);
    expect(nonIndexKeys(session)).toEqual([]);
  });
});

describe("bundle descriptor mode consistency (fail-closed)", () => {
  it("accepts a consistent SCOPED_API_CREDENTIAL descriptor", () => {
    expect(descriptorModeViolations(scopedDescriptor())).toEqual([]);
  });

  it("requires the delegated artifact reference for DELEGATED_OAUTH", () => {
    const violations = descriptorModeViolations(
      scopedDescriptor({
        authorizationMode: "DELEGATED_OAUTH",
      }),
    );
    expect(violations.join(" ")).toContain("authorizationArtifactRef");
  });

  it("requires artifact + account for CONNECTED_ACCOUNT", () => {
    const violations = descriptorModeViolations(
      scopedDescriptor({
        authorizationMode: "CONNECTED_ACCOUNT",
        authorizationArtifactRef: mintAuthorizationArtifactRef(
          "authorization://paystack/connected-acct-0001",
        ),
      }),
    );
    expect(violations).toEqual([]);
  });

  it("requires the browser-session reference for INTERACTIVE_BROWSER_SESSION", () => {
    const violations = descriptorModeViolations(
      scopedDescriptor({
        authorizationMode: "INTERACTIVE_BROWSER_SESSION",
        accountRef: "mtn-momo-wallet-0001",
        browserSessionRef: mintBrowserSessionRef(
          "browser-session://secure-browser-af-1/sess-0007",
        ),
      }),
    );
    expect(violations).toEqual([]);
    const withoutSession = descriptorModeViolations(
      scopedDescriptor({
        authorizationMode: "INTERACTIVE_BROWSER_SESSION",
        accountRef: "mtn-momo-wallet-0001",
      }),
    );
    expect(withoutSession.join(" ")).toContain("browserSessionRef");
  });

  it("forbids artifact/session references on PROVIDERLESS_RAIL (no provider credential)", () => {
    const violations = descriptorModeViolations(
      scopedDescriptor({
        providerName: "STELLAR_TESTNET",
        authorizationMode: "PROVIDERLESS_RAIL",
        vaultReference: vaultReference("vault://payswap/rails/stellar/testnet-20261002"),
        authorizationArtifactRef: mintAuthorizationArtifactRef(
          "authorization://stellar/grant-0001",
        ),
      }),
    );
    expect(violations.join(" ")).toContain("PROVIDERLESS_RAIL");
  });

  it("rejects unknown modes and malformed vault references", () => {
    expect(
      descriptorModeViolations(scopedDescriptor({ authorizationMode: "PASSWORD" as never })),
    ).not.toEqual([]);
    expect(
      descriptorModeViolations(
        scopedDescriptor({ vaultReference: "not-a-vault-ref" as never }),
      ),
    ).not.toEqual([]);
  });
});

describe("CredentialBroker resolution (one vault reference → one sealed bundle)", () => {
  it("resolves a PROVIDER_<NAME>_CREDENTIAL_REF key to a sealed handle with scope metadata only", () => {
    const { broker } = brokerWithStripe();
    const handle = broker.resolveProviderCredential("PROVIDER_STRIPE_CREDENTIAL_REF");
    expect(handle.providerName).toBe("STRIPE");
    expect(handle.authorizationMode).toBe("SCOPED_API_CREDENTIAL");
    expect(handle.descriptor.accountRef).toBe("acct_SYNTHETIC");
    expect(handle.descriptor.currencies).toEqual(["EUR", "USD"]);
  });

  it("fails closed on an unbound configuration key", () => {
    const { broker } = brokerWithStripe();
    expect(() =>
      broker.resolveProviderCredential("PROVIDER_ADYEN_CREDENTIAL_REF"),
    ).toThrow(CredentialBrokerError);
  });

  it("fails closed on a non-template configuration key", () => {
    const { broker } = brokerWithStripe();
    expect(() => broker.resolveProviderCredential("STRIPE_API_KEY")).toThrow(
      CredentialBrokerError,
    );
  });

  it("fails closed on an unresolvable vault reference", () => {
    const vault = new FixtureVault();
    const broker = new CredentialBroker({ store: vault });
    expect(() =>
      broker.resolveVaultReference("vault://payswap/providers/stripe/test-20261002"),
    ).toThrow(/does not resolve/);
  });

  it("fails closed when the vault returns something that is not sealed", () => {
    class LeakyVault {
      readonly storeId = "leaky-vault";
      resolve(): unknown {
        return { apiKey: SYNTHETIC_API_KEY };
      }
      referenceBoundTo(): string | undefined {
        return undefined;
      }
    }
    const broker = new CredentialBroker({
      store: new LeakyVault() as unknown as VaultStore,
    });
    expect(() =>
      broker.resolveVaultReference("vault://payswap/providers/stripe/leak-0001"),
    ).toThrow(/must seal material at the source/);
  });

  it("rejects a mode-inconsistent bundle even when the vault resolves it", () => {
    const vault = new FixtureVault().seal(
      "vault://payswap/providers/stripe/badmode-0001",
      scopedDescriptor({
        authorizationMode: "DELEGATED_OAUTH" as never,
        vaultReference: vaultReference("vault://payswap/providers/stripe/badmode-0001"),
      }),
      { apiKey: SYNTHETIC_API_KEY },
    );
    const broker = new CredentialBroker({ store: vault });
    expect(() =>
      broker.resolveVaultReference("vault://payswap/providers/stripe/badmode-0001"),
    ).toThrow(/violates its authorization mode/);
  });

  it("mints deterministic, distinct handle ids per resolution", () => {
    const { broker } = brokerWithStripe();
    const first = broker.resolveProviderCredential("PROVIDER_STRIPE_CREDENTIAL_REF");
    const second = broker.resolveProviderCredential("PROVIDER_STRIPE_CREDENTIAL_REF");
    expect(first.handleId).toBe("sealed:STRIPE:1");
    expect(second.handleId).toBe("sealed:STRIPE:2");
  });

  it("reports handle expiry from the descriptor (explicit instant, no ambient clock)", () => {
    const vault = new FixtureVault().seal(
      "vault://payswap/providers/stripe/expiring-0001",
      scopedDescriptor({
        vaultReference: vaultReference("vault://payswap/providers/stripe/expiring-0001"),
        validUntil: T1,
      }),
      { apiKey: SYNTHETIC_API_KEY },
    );
    const broker = new CredentialBroker({ store: vault });
    const handle = broker.resolveVaultReference(
      "vault://payswap/providers/stripe/expiring-0001",
    );
    expect(isSealedHandleExpired(handle, "2026-11-01T00:00:00Z")).toBe(false);
    expect(isSealedHandleExpired(handle, T1)).toBe(true);
    expect(isSealedHandleExpired(handle, "2027-01-01T00:00:00Z")).toBe(true);
  });
});

describe("structural opacity of sealed material", () => {
  it("a sealed handle carries NO material — not by JSON, spread or enumeration", () => {
    const { broker } = brokerWithStripe();
    const handle = broker.resolveProviderCredential("PROVIDER_STRIPE_CREDENTIAL_REF");
    const serialized = JSON.stringify(handle);
    expect(serialized).not.toContain(SYNTHETIC_API_KEY);
    expect(serialized).not.toContain(SYNTHETIC_WEBHOOK_SECRET);
    const spread: Record<string, unknown> = { ...handle };
    expect(Object.keys(spread).sort()).toEqual([
      "authorizationMode",
      "descriptor",
      "handleId",
      "providerName",
    ]);
    const descriptorRecord = handle.descriptor as unknown as Record<string, unknown>;
    for (const value of Object.values(descriptorRecord)) {
      expect(String(value)).not.toContain(SYNTHETIC_API_KEY);
    }
  });

  it("a sealed bundle has no material getter and does not serialize material", () => {
    const bundle = new SealedCredentialBundle(scopedDescriptor(), {
      apiKey: SYNTHETIC_API_KEY,
    });
    expect(JSON.stringify(bundle)).not.toContain(SYNTHETIC_API_KEY);
    const record = bundle as unknown as Record<string, unknown>;
    for (const value of Object.values(record)) {
      expect(String(value)).not.toContain(SYNTHETIC_API_KEY);
    }
    expect(Object.keys(record)).not.toContain("material");
  });

  it("the broker itself serializes without material (private registry)", () => {
    const { broker } = brokerWithStripe();
    broker.resolveProviderCredential("PROVIDER_STRIPE_CREDENTIAL_REF");
    expect(JSON.stringify(broker)).not.toContain(SYNTHETIC_API_KEY);
  });

  it("material opens ONLY for the registered connector runtime key", () => {
    const { broker } = brokerWithStripe();
    const handle = broker.resolveProviderCredential("PROVIDER_STRIPE_CREDENTIAL_REF");
    const runtimeKey = broker.registerConnectorRuntime("connector-runtime-1");

    const seen: unknown[] = [];
    const result = broker.withSealedBundle(handle, runtimeKey, (opened) => {
      seen.push(opened.material);
      return "invoked";
    });
    expect(result).toBe("invoked");
    expect(JSON.stringify(seen)).toContain(SYNTHETIC_API_KEY);

    // A forged key (no runtime stamp) cannot open the bundle.
    const forged = { runtimeId: "connector-runtime-1" } as unknown as ConnectorRuntimeKey;
    expect(() =>
      broker.withSealedBundle(handle, forged, () => "should not run"),
    ).toThrow(CredentialBrokerError);

    // A key registered with a DIFFERENT broker cannot open this one's bundles.
    const otherBroker = new CredentialBroker({
      store: new FixtureVault(),
    });
    const foreignKey = otherBroker.registerConnectorRuntime("connector-runtime-1");
    expect(() =>
      broker.withSealedBundle(handle, foreignKey, () => "should not run"),
    ).toThrow(CredentialBrokerError);
  });

  it("a released (revoked) handle can no longer open material", () => {
    const { broker } = brokerWithStripe();
    const handle = broker.resolveProviderCredential("PROVIDER_STRIPE_CREDENTIAL_REF");
    const runtimeKey = broker.registerConnectorRuntime("connector-runtime-1");
    broker.releaseSealedHandle(handle);
    expect(() =>
      broker.withSealedBundle(handle, runtimeKey, () => "should not run"),
    ).toThrow(/not held by this broker/);
  });

  it("runtime ids are single-registration (no key confusion)", () => {
    const { broker } = brokerWithStripe();
    broker.registerConnectorRuntime("connector-runtime-1");
    expect(() => broker.registerConnectorRuntime("connector-runtime-1")).toThrow(
      CredentialBrokerError,
    );
    expect(() => broker.registerConnectorRuntime("")).toThrow();
  });

  it("material handed to the runtime never appears on the handle afterwards", () => {
    const { broker } = brokerWithStripe();
    const handle: SealedCredentialHandle =
      broker.resolveProviderCredential("PROVIDER_STRIPE_CREDENTIAL_REF");
    const runtimeKey = broker.registerConnectorRuntime("connector-runtime-1");
    broker.withSealedBundle(handle, runtimeKey, () => {
      // even after opening, the handle stays material-free
      expect(JSON.stringify(handle)).not.toContain(SYNTHETIC_API_KEY);
    });
    expect(JSON.stringify(handle)).not.toContain(SYNTHETIC_API_KEY);
  });
});

describe("sanitizeForLogs (logs AND agent context)", () => {
  it("strips secret-shaped values wherever they hide", () => {
    const dirty = {
      provider: "STRIPE",
      mode: "SCOPED_API_CREDENTIAL",
      credentialRef: "PROVIDER_STRIPE_CREDENTIAL_REF",
      vaultReference: "vault://payswap/providers/stripe/test-20261002",
      headers: {
        authorization: SYNTHETIC_BEARER,
        "user-agent": "payswap-connector/1.0",
        "x-api-key": SYNTHETIC_API_KEY,
        cookie: SYNTHETIC_BROWSER_COOKIE,
      },
      nested: {
        deep: {
          privateKey: "-----BEGIN RSA PRIVATE KEY-----\nSYNTHETIC\n",
          password: "hunter2-synthetic",
        },
      },
      note: `request failed with ${SYNTHETIC_API_KEY} rejected`,
    };
    const clean = JSON.stringify(sanitizeForLogs(dirty));
    expect(clean).not.toContain(SYNTHETIC_API_KEY);
    expect(clean).not.toContain(SYNTHETIC_BEARER);
    expect(clean).not.toContain("-----BEGIN RSA PRIVATE KEY-----");
    expect(clean).not.toContain("hunter2-synthetic");
    // reference and scope fields survive (they are the agent-visible design)
    expect(clean).toContain("PROVIDER_STRIPE_CREDENTIAL_REF");
    expect(clean).toContain("vault://payswap/providers/stripe/test-20261002");
    expect(clean).toContain("SCOPED_API_CREDENTIAL");
    expect(clean).toContain("payswap-connector/1.0");
  });

  it("redacts secret-named leaf keys even when the value is not string-shaped", () => {
    const clean = sanitizeForLogs({
      clientSecret: 123456789012345,
      accessToken: true,
      authorizationRef: "authorization://stripe/grant-20261002-0001",
    }) as Record<string, unknown>;
    expect(clean["clientSecret"]).toBe("[REDACTED:key:clientSecret]");
    expect(clean["accessToken"]).toBe("[REDACTED:key:accessToken]");
    // reference fields are exempt by design
    expect(clean["authorizationRef"]).toBe("authorization://stripe/grant-20261002-0001");
  });

  it("walks objects under secret-named keys instead of dropping them (leaf-level redaction)", () => {
    const clean = sanitizeForLogs({
      authorization: {
        status: "ACTIVE",
        grantedAt: T0,
        token: "synthetic-token-value-000000",
      },
    }) as Record<string, unknown>;
    const inner = clean["authorization"] as Record<string, unknown>;
    expect(inner["status"]).toBe("ACTIVE");
    expect(inner["grantedAt"]).toBe(T0);
    expect(inner["token"]).toBe("[REDACTED:key:token]");
  });

  it("redacts a raw secret smuggled into a reference-named field (shape check still runs)", () => {
    const clean = sanitizeForLogs({
      someRef: SYNTHETIC_API_KEY,
    }) as Record<string, unknown>;
    expect(clean["someRef"]).toBe("[REDACTED:value:test-secret-key]");
  });

  it("handles arrays, maps, sets, cycles and non-loggable values deterministically", () => {
    const cyclic: Record<string, unknown> = { name: "cycle" };
    cyclic["self"] = cyclic;
    const clean = sanitizeForLogs({
      list: [SYNTHETIC_API_KEY, "plain-value"],
      cookieJar: new Map([["session", SYNTHETIC_BROWSER_COOKIE]]),
      tags: new Set(["a", "b"]),
      cyclic,
      fn: () => "never logged",
    }) as Record<string, unknown>;
    const serialized = JSON.stringify(clean);
    expect(serialized).not.toContain(SYNTHETIC_API_KEY);
    expect(serialized).not.toContain(SYNTHETIC_BROWSER_COOKIE);
    expect(serialized).toContain("[CYCLIC]");
    expect(serialized).toContain("[NON-LOGGABLE]");
    expect(serialized).toContain("plain-value");
  });

  it("never passes synthetic bundle material through, end to end", () => {
    const { broker } = brokerWithStripe();
    const handle = broker.resolveProviderCredential("PROVIDER_STRIPE_CREDENTIAL_REF");
    const runtimeKey = broker.registerConnectorRuntime("connector-runtime-1");
    let leakedThroughLog = false;
    broker.withSealedBundle(handle, runtimeKey, (opened) => {
      // the runtime MUST sanitize anything it logs about the invocation
      const sanitized = JSON.stringify(
        sanitizeForLogs({
          handleId: handle.handleId,
          descriptor: opened.descriptor,
          material: opened.material,
        }),
      );
      leakedThroughLog =
        sanitized.includes(SYNTHETIC_API_KEY) ||
        sanitized.includes(SYNTHETIC_WEBHOOK_SECRET);
    });
    expect(leakedThroughLog).toBe(false);
  });
});
