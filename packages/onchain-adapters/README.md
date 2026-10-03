# @payswap/onchain-adapters — Multi-Chain Adapter SDK (P4-W2-001)

Chain-family adapters for PaySwap: **EVM**, **Solana** and **UTXO**, implemented behind the
provider-neutral contracts of `@payswap/onchain-domain` and feeding the authorization/security
kernel of `@payswap/onchain-security`. No vendor SDK is a dependency — providers (public JSON-RPC
nodes, esplora-style explorers) live behind injectable transport ports, and production transports
must configure endpoints from at least two distinct providers.

## The frozen adapter lifecycle (every family implements it explicitly)

```
observe → prepare → simulate → authorize → broadcast → observe → finality → reconcile → evidence
```

- **observe** — read-only rail state: chain heads (`ChainHeadObservation`) and external asset
  positions as `AssetObservation`s (mandatory freshness/provenance/observer — never custody,
  INV-C09). Unreachable rails surface availability UNKNOWN (INV-C01/C02) — never success/failure.
- **prepare** — a validated neutral `OnchainExecutionDirective` + `ConnectedChainInstance` +
  fresh head → the kernel-ready `OnchainWriteRequest` (content-digested) + the family execution
  plan. Chain identity is cross-checked per family (EVM `eth_chainId`, Solana `getGenesisHash`,
  UTXO genesis block hash). Stale heads invalidate preparation.
- **simulate** — an OBSERVATION, never authority. Solana simulation requires the
  trusted-surface-composed serialized transaction (fails closed otherwise); UTXO declares the
  stage structurally unsupported and throws `UnsupportedLifecycleStageError` (the kernel runs
  gate-only from PREPARED).
- **authorize** — drives the REAL onchain-security kernel: gates → diff → authorization request →
  trusted-surface artifact → pre-broadcast recheck → signing-request handoff. The adapter never
  authorizes; the kernel owns authority. EVM hands off REAL EIP-712 typed data (the kernel's own
  Eip712SignerAdapter with this adapter's chain-id resolver); Solana/UTXO hand off
  authorization signing envelopes (transaction composition + signing belong to the trusted
  surface — this SDK never signs, rule 25).
- **broadcast** — submits the trusted-surface-SIGNED payload with deterministic node-rejection
  classification per family. Submitted ≠ finality (rule 29). Transport ambiguity after submission
  is OUTCOME_UNKNOWN (INV-X01 — never a failure class).
- **observe (result)** — polls the external operation with reorg/fork detection (remembered
  containing-block anchors). Broadcast-then-reorg/fork → OUTCOME_UNKNOWN.
- **finality** — a CANDIDATE only (INV-F06): explicit family semantics (EVM confirmations +
  BLOCK_HASH observation; Solana slots + finalized commitment + signature-status observation;
  UTXO depth + BLOCK_HASH observation) against declared guidance targets.
- **reconcile** — deterministic plans for OUTCOME_UNKNOWN observations: `blindRetryForbidden: true`
  (INV-X02), resolver is settlement reconciliation authority only (INV-X03).
- **evidence** — append-only per-operation evidence log (INV-E01/E02).

## Structural hard constraints

| Constraint | Enforcement |
| --- | --- |
| No single RPC/indexer/simulation vendor as core dependency | Transport ports are injected; `src/**` imports only `@payswap/*` + relative modules; the manifest has zero third-party runtime deps; PRODUCTION transports require ≥2 distinct endpoint providers (adversarially scanned in `test/no-vendor.test.ts`) |
| Fee/finality/reorg semantics explicit per family | `FamilySemanticsProfile` (validated, frozen); inexpressible semantics carry `expressible: false` + explicit reason and fail closed (`SemanticNotExpressibleError`) — never approximated |
| UNKNOWN for ambiguous/unfinalized state | Every observation path returns `OUTCOME_UNKNOWN` with an explicit reason; the domain validator structurally forbids UNKNOWN+failure and BROADCAST+finality |
| Testnet/simulation never production financial execution | The environment discriminator is STRUCTURAL: chain identity classifies via the frozen `CHAIN_ENVIRONMENT_REGISTRY`; `RailEnvironment<"PRODUCTION">` is branded and runtime re-derived; the settlement gate accepts only production envelopes (`TestnetNeverProductionError`) |
| Canonical settlement mapping only | `settlement-gate.ts` reuses `onchainRailId` / `mapToRailOperation` / `settlementAttemptEventCandidate` from `@payswap/onchain-domain` — no parallel ledger, no duplicate vocabulary; finality stays protocol-owned (`adapterObservationPermitsFinalityDeclaration()` → always `false`) |
| Catalogue never authorizes | `prepare` asserts the execution scope (`assertOnchainExecutionScope` — INV-C05) |
| No secrets in agent-facing contracts | Every adapter output is secret-scanned (`assertNoSecretMaterial`); key-material-shaped signer handles are rejected by the domain validator |

## Family semantics summary

| Family | Fee model | Finality model | Reorg/fork detection | Chain identity check |
| --- | --- | --- | --- | --- |
| EVM | GAS_AUCTION (EIP-1559 baseFee+priority when expressible; fails closed without baseFee) | PROBABILISTIC, confirmation depth guidance | containing block hash re-observation | `eth_chainId` |
| SOLANA | SIGNATURE_FEE (`getFeeForMessage`, exact integer lamports) | PROBABILISTIC, slot depth + finalized commitment guidance | signature-status disappearance/slot change | `getGenesisHash` |
| UTXO | SATOSHI_PER_VBYTE (exact decimal text from the fee-estimates feed; declared MempoolPolicy BIP-125 RBF / CPFP) | PROBABILISTIC, depth guidance | containing block hash re-observation | genesis block hash (`/block-height/0`) |

## Test suites

- **Deterministic (default gate)**: `npm test` — every adapter path against scripted transport
  fixtures (no network). Contract/lifecycle completeness, explicit semantics, UNKNOWN paths,
  reorg/fork/stale/ambiguous reconciliation, environment discrimination, secrets boundary,
  no-vendor scans, canonical settlement compatibility.
- **Live (explicit, read-only)**: `npm run test:live` — public endpoints (Ethereum mainnet
  JSON-RPC, Solana mainnet-beta RPC, Bitcoin mainnet explorers). NO broadcast, NO signing.
  Machine-generated provenance: `evidence/live-capture.jsonl`; curated evidence:
  `evidence/real-network-provenance.md`.

## Package layout

```
src/index.ts          neutral SDK core barrel (contract, environment, transport, semantics, lifecycle, settlement gate)
src/contract.ts       the frozen family-adapter lifecycle contract
src/environment.ts    structural environment/rail discriminator + chain-environment registry
src/transport.ts      vendor-neutral transport ports + endpoint diversity law + HTTP transports
src/semantics.ts      explicit family fee/finality/reorg semantics profiles
src/lifecycle.ts      shared lifecycle machinery (kernel feed, evidence log, staleness guards)
src/settlement-gate.ts production-only settlement mapping (canonical vocabulary)
src/evm/index.ts      EVM family adapter (public JSON-RPC profiles, EIP-712 signer feed)
src/solana/index.ts   Solana family adapter (public RPC profiles, base58, fee-message builder)
src/utxo/index.ts     UTXO family adapter (esplora-style explorer profiles, genesis check)
```
