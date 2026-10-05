# ancre-indexer — output format (for the solver, chantier 04, and the demo screen, chantier 07)

Status: **v1, 2026-10-05** (chantier 03; aligned on the unified format `ancre-cert-v1`, `contracts/ENCODING.md`, and on `solver/from_indexer.py`). Entities are defined in `schema.graphql`; this file says what
they mean and how to read them. Change log at the bottom.

## Access

- GraphQL (Hasura). Local: `http://localhost:8080/v1/graphql` after `pnpm dev` (admin secret `testing`).
  Envio Cloud: `https://indexer.dev.hyperindex.xyz/<deployment-id>/v1/graphql` (id given after the 1st deploy, ≥ 01/10).
- **Per-chain rows.** The indexer runs with `disable_default_cross_chain: true`: every table has a `chainId`
  column and the key is `(id, chainId)`. **Always filter on `chainId`** (143 = Monad, 10143 = Monad testnet,
  10 = Optimism). The same `id` (e.g. agent `"4"`) exists independently on several chains.
- Indexer head per chain: `chain_metadata(where: {chain_id: {_eq: C}}) { latest_processed_block }` (MESURÉ 05/10 on
  the local endpoint; readable without the admin secret, like `_meta { chainId progressBlock eventsProcessed }`).
- Addresses are **lowercase** hex. Big integers are strings in JSON (`BigInt`).
- Pagination: `order_by: {id: asc}` with `where: {id: {_gt: $last}}`, pages of 1 000.

## Layer 1 — append-only history (replay any past block)

Nothing is ever deleted from these tables; each row carries `blockNumber` and `logIndex`.
To rebuild the state at block `B`, filter `blockNumber <= B` and replay in `(blockNumber, logIndex)` order.

| Entity | One row per | Key fields |
|---|---|---|
| `Feedback` | `NewFeedback` (id `agentId-client-feedbackIndex`) | `value` (exact int128), `valueDecimals`, `tag1`, `tag2`, `triple`, `txFrom` (signer, ≠ client when relayed), `revokedAtBlock` (null = active), `clientWasController` (at the feedback's block) |
| `WalletChange` | `MetadataSet(key = "agentWallet")` | `wallet` (`0x000…0` = cleared, emitted on every transfer) |
| `OwnerChange` | ERC-721 `Transfer` | `from`, `to`, `isMint` |
| `ApprovalChange` | ERC-721 `Approval` | `approved` |
| `OperatorChange` | `ApprovalForAll` | `owner`, `operator`, `approved` |
| `RegistryEvent` | `Upgraded` / `OwnershipTransferred` of either proxy (D17 watch) | `registry`, `kind`, `implementation`, `newOwner` |

**Solver input equivalents** (what `solver/from_indexer.py` should produce):
- `onchain_feedbacks.json` ← `Feedback` with `blockNumber <= B`: `{a: agent_id, c: client, i: feedbackIndex, v: value, d: valueDecimals, t1: tag1, t2: tag2, r: revokedAtBlock != null && revokedAtBlock <= B}`.
- identity at `B` ← replay of `OwnerChange`, `WalletChange`, `ApprovalChange` (reset by each `Transfer`), `OperatorChange`.
  Or, for the current head only, read layer 2 directly.

## Layer 2 — current state (head of the chain)

| Entity | Meaning |
|---|---|
| `Agent` (id = agentId) | `owner`, `wallet` (`0x0` if cleared), `approved` (`0x0` if none), `registeredBlock`, `registeredTxFrom`, `transferCount`, `lastTransferBlock` |
| `WalletAgents` (id = wallet) | reverse index wallet → `agentIds` (not available on-chain). `count > 1` = shared wallet (D20 row copy) |
| `Operator` (id = `owner-operator`) | `active` operator approvals |

## Layer 3 — normative edges per anchor set

`SetEdge` (id = `setId-client-agentId`): one row per (set, client, agent) pair that has at least one feedback under a
tag of the set's filter. Today the indexer maintains the pseudo-set **`"ref"`** (`AnchorSet {id: "ref", kind:
"reference"}`): schema `src/lib/schema_reference.json` (byte-identical copy of `solver/schema_reference.json`,
tested), filter `reference`. Rules = `solver/FORMAT.md` §0 R2-R6, the reference implementation being `solver/graph.py`:
R3 latest non-revoked per (client, agent, tag1), out of bounds ⇒ that tag gives nothing (judged **per tag**, no fallback);
R5 negative dominance across tags, **ties broken by the highest feedbackIndex**; R2 endorsement tags only; R6 rejection
of the target's **current** controllers (owner, operator, agentWallet, approved; no past-owner rule, D20).

| Field | Meaning |
|---|---|
| `set_id` | `"ref"` |
| `w` | int16 weight on the 1e-4 grid (`graph.quantize`); 0 when rejected |
| `decidingTag`, `feedbackIndex` | the feedback that decided `w` |
| `rejected` | **null = edge retained** · `NO_ACTIVE_FEEDBACK` (all revoked) · `OUT_OF_BOUNDS` (no tag yields a weight) · `ZERO_WEIGHT` · `CONTROLLER_OWNER` · `CONTROLLER_OPERATOR` · `CONTROLLER_WALLET` · `CONTROLLER_APPROVED` |
| `updatedAtBlock` | last block where the row changed |

**Not decided here: the emitter node** (R7, D20 row copy, D44 owner fallback): `SetEdge` is keyed by the client
*address*; the solver resolves the emitter from `Agent` + `WalletAgents` (or from the identity replay).

`TripleLatest` (id = `client-agentId-tag1`): the latest non-revoked feedback of each triple, **for every tag** (an
anchor set may commit its own filter, D12; the certificate audit replays it).

**Parity (MESURÉ 05/10)**: `solver/from_indexer.py --endpoint <graphql> --chain C --block <head> --parity` reports
0 difference on 143 (11 edges), 10143 (30) and 10 (10). A dump of chain 143 is in
`solver/tests/fixtures/indexer/` (`test_parity_real_indexer_dump`).

## Stats

`ChainStats` (id = `"stats"`, one row per chain): `agents`, `transfers`, `feedbacks`, `revoked`,
`selfRatings` (feedback given while the client controlled the target), `outOfRange` (|value| ≥ 1e38),
`refEdges` (`SetEdge` of the `ref` set with `w ≠ 0`), `sharedWallets`, `agentsOnSharedWallets`, `lastBlock`.

## Guarantees and tests

- `test/parity.test.ts` (`pnpm test:parity`): replaying Monad 143 up to block 108 434 518 yields exactly the
  11 reference edges of `solver/graph.py` and the brief 03 §7 figures (9 188 feedbacks, 7 771 couples,
  10 261 mints, 72 transfers, 178 shared wallets / 1 773 agents, 78 self-ratings by agentWallet). MESURÉ 28/09.
- `test/rules.test.ts` (`pnpm test`): D14 slash/review on #4, #8317 self-rating, 1e38, D15, transfer, revocation, R5 tie.
- `test/certificate.test.ts`: the `ancre-cert-v1` decoder re-reads the 13 solver vectors (violations included) byte for byte.
- `test/audit.test.ts` (`pnpm test:parity`): audit on Monad's rebuilt state (block 108 835 675): 4 honest vectors →
  0 discrepancy, 4 normative violations (D37) → FABRICATED, INFLATED, OMITTED_NEG ×2, INFLATED (dilution).

## Example queries

```graphql
# Reference edges kept on Monad
query { SetEdge(where: {chainId: {_eq: 143}, set_id: {_eq: "ref"}, rejected: {_is_null: true}}) { client agent_id w decidingTag feedbackIndex } }

# Agents sharing one wallet
query { WalletAgents(where: {chainId: {_eq: 143}, count: {_gt: 1}}, order_by: {count: desc}, limit: 5) { id count agentIds } }

# Stats of every indexed chain in one request
query { ChainStats { chainId agents feedbacks refEdges selfRatings outOfRange lastBlock } }
```

## Change log

- v0 (28/09): layers 1–3 for the reference set (`RefEdge`), ChainStats.
- v1 (05/10): `RefEdge` → `SetEdge` + `AnchorSet` (from_indexer.py interface), `rejected` null when retained,
  `OUT_OF_BOUNDS` (per-tag semantics), R5 tie by highest feedbackIndex, `TripleLatest` for every tag.
  Coming: `Certificate`, `CertificateAudit`, `Discrepancy`, `SetHealth` once the ANCRE contract is deployed (E4).
