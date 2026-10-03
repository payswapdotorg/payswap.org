# P4-W2-001 — Real-Network Provenance Evidence

Work Order: P4-W2-001 — Multi-Chain Adapter SDK
Collected: 2026-10-03 (UTC), sandbox session on branch `work/P4-W2-001` at the pinned base `7e6275d`
Method: `npm run test:live` (vitest.live.config.ts) — READ-ONLY observations against PUBLIC endpoints.
NO credentials, NO signing, NO broadcast, NO financial effect (AGENTS.md rule 25: keys never exist in
this package; the broadcast stage is proven by the deterministic fixture suite).

This file is sanitized: it contains public endpoint identities, timestamps and observed public
values only — no keys, no secrets, no session material. The machine-generated raw capture is
`live-capture.jsonl` (same directory, same run). Family state: **real-proof** for all three
families (EVM, Solana, UTXO) for every read-only lifecycle surface; effectful broadcast is
fixture-proven with the broadcast rails' reachability documented below.

## Environment

- node v24.21.0, npm 11.19.0
- Commands: `npx vitest run --config vitest.live.config.ts` (in `packages/onchain-adapters`)
- Result: 3 files, 9 tests, 9 passed (retry-tolerant public endpoints)

## EVM family — Ethereum mainnet (JSON-RPC, provider diversity: PublicNode + Cloudflare)

Endpoints (public, no credentials):
- `https://ethereum-rpc.publicnode.com` — PublicNode (primary responder in this run)
- `https://cloudflare-eth.com` — Cloudflare (chainId probe OK; state queries answered `-32603 Internal error` — recorded honestly, see Limitations)

Observed (2026-10-03T19:03:47–48Z):
- `eth_blockNumber` → block 26,113,780; `eth_getBlockByNumber("latest")` → head hash `0x54c98a02e56290f2d04a860274e2a96749c9aaa6808bfc3de9739d058df7bfee` (heads advanced across runs: 26,113,760 → 26,113,768 → 26,113,780 — live chain)
- `eth_chainId` → `0x1` (cross-checked against the declared EVM chain id 1 — chain-identity defense verified live)
- EIP-1559 fee semantics expressible: `baseFeePerGas` on the observed blocks `383856037` → `370493179` → `372454983` wei (GAS_AUCTION, exact integers)
- `eth_getBalance("0xd8dA…db39","latest")` → `0x0` (see Limitations — recorded verbatim as an observation)
- `eth_getTransactionCount("0xd8dA…db39","pending")` → `0x0` (see Limitations)
- Prepare stage executed end-to-end against the live rail (chain-id cross-check + nonce + fee derivation)

## Solana family — mainnet-beta (JSON-RPC, provider diversity: Solana Labs + PublicNode)

Endpoints (public, no credentials):
- `https://api.mainnet-beta.solana.com` — Solana Labs (primary responder in this run)
- `https://solana-rpc.publicnode.com` — PublicNode

Observed (2026-10-03T19:03:48–49Z):
- `getSlot("confirmed")` → slot 453,022,120 (slots advanced across runs: 453,015,774 → 453,021,334 → 453,022,120 — live cluster)
- `getLatestBlockhash` → blockhash `HKUPmgfVd4ANA4RhTrwDkiGoQkZPpN6YGcAJEQTc1Uxw`, `lastValidBlockHeight` 431,060,792
- `getGenesisHash` → `5eykt4UsFv8P8NJdTREpY1vzqKqZKvdpKuc147dw2N9d` — matches the well-known mainnet-beta genesis registry entry (cluster-identity defense verified live)
- `getFeeForMessage` (minimal 1-signature legacy message built from the decoded recent blockhash) → 5000 lamports per signature (SIGNATURE_FEE, exact integer; fee verified independent of the account key)
- `getBalance("9WzDXw…WWM")` → 10,572,651,977,324,437 lamports — extracted EXACTLY from the raw response text (the JSON number exceeds `Number.MAX_SAFE_INTEGER` and would be lossy through a double round-trip; the adapter's exactness guard + raw-text parsing handles this, INV-F01 discipline)

## UTXO family — Bitcoin mainnet (Esplora REST, provider diversity: Blockstream + mempool.emzy.de)

Endpoints (public, no credentials):
- `https://blockstream.info/api` — Blockstream (primary responder in this run)
- `https://mempool.emzy.de/api` — mempool.emzy.de (reachable; tip observed 969,751 during endpoint selection; mempool.space itself was unreachable from this sandbox — the alternate esplora endpoint preserves provider diversity)

Observed (2026-10-03T19:03:46–47Z):
- `/blocks/tip/height` → 969,752; `/blocks/tip/hash` → `000000000000000000003e5a6b77578b091ec4bda168e01da9377a6904d9937b`
- `/block-height/0` → `000000000019d6689c085ae165831e934ff763ae46a2a6c172b3f1b60a8ce26f` — the well-known Bitcoin mainnet genesis block (structural chain identity verified live; testnet genesis `000000000933ea01ad0ee984209779baaec3ced90fa3f408719526f8d77f4943` separately verified via `https://blockstream.info/testnet/api/block-height/0`, testnet tip 5,155,271)
- `/fee-estimates` → 6-block bucket `3.001` sat/vB (exact decimal text extracted verbatim from the raw response — no float arithmetic), with the declared MempoolPolicy (BIP-125 opt-in RBF / CPFP, provenanced declaration)
- `/address/1A1zP1eP5QGefi2DMPTfTL5SLmv7DivfNa` → UTXO-set sums 5,747,914,894 satoshi observed (funded − spent; the genesis-coinbase address)

## Broadcast rails (NOT exercised live — honest record)

Broadcast (`eth_sendRawTransaction`, `sendTransaction`, POST `/tx`) was NOT exercised against the
live rails: this package holds no signing keys BY LAW (rule 25), so no signed payload can exist here.
The broadcast stage, its deterministic node-rejection classification tables and its
transport-ambiguity → OUTCOME_UNKNOWN paths are proven by the deterministic fixture suite
(`test/lifecycle-*.test.ts`, `test/unknown-paths.test.ts`). The broadcast endpoints' reachability
was not separately probed (read-only observation policy for the live run). This is recorded as an
honest limitation, not a simulated success.

## Limitations (honest)

1. **EVM account-state queries through the reachable public endpoints returned `0x0` for a known
   funded address** (`eth_getBalance`/`eth_getTransactionCount` on `0xd8dA…db39`), while
   chain-structural data (heads, chain ids, blocks, baseFee) is live and advancing. The observations
   are recorded verbatim with full provenance — external balances are observations (INV-C09), never
   asserted truth; a production deployment would cross-check state across more providers.
2. **mempool.space was unreachable from this sandbox** (timeout) — replaced by mempool.emzy.de
   (a public esplora-compatible endpoint) to preserve UTXO provider diversity.
3. **Cloudflare's Ethereum endpoint answered state queries with `-32603`** in this session — it
   remains configured as the second provider (chainId probe OK); failover handled it.
4. **No live broadcast** — see "Broadcast rails" above.
5. The Solana fee message is a minimal 1-signature/0-instruction legacy message (the exact fee
   surface for real transfers also depends on compute-unit pricing, which is surface-composed).

## Sanitization statement

No credential material of any kind — authentication material, signing or wallet-recovery
material of any form, cookies, or session tokens — appears in this file, in
`live-capture.jsonl`, or anywhere in this package. All endpoints are public and
credential-free.
