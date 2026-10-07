# ancre-indexer — output format (for the solver, chantier 04, and the demo screen, chantier 07)

Status: **v3, 2026-10-06** (chantier 03 + review of 06/10; aligned on the 02-bis contract and the 04-bis rules; previously aligned on the unified format `ancre-cert-v1`, `contracts/ENCODING.md`, and on `solver/from_indexer.py`). Entities are defined in `schema.graphql`; this file says what
they mean and how to read them. Change log at the bottom.

## Access

- GraphQL (Hasura). Local: `http://localhost:8080/v1/graphql` after `pnpm dev` (admin secret `testing`).
  Envio Cloud: **`https://indexer.dev.hyperindex.xyz/433cc83/v1/graphql`** (deployment 6107d0a, 05/10; public, no secret).
- **Per-chain rows.** The indexer runs with `disable_default_cross_chain: true`: every table has a `chainId`
  column and the key is `(id, chainId)`. **Always filter on `chainId`** (143 = Monad, 10143 = Monad testnet,
  10 = Optimism). The same `id` (e.g. agent `"4"`) exists independently on several chains.
- Indexer head per chain: `chain_metadata(where: {chain_id: {_eq: C}}) { latest_processed_block }` (MESURÉ 05/10 on
  the local endpoint; readable without the admin secret, like `_meta { chainId progressBlock eventsProcessed }`).
- Addresses are **lowercase** hex. Big integers are strings in JSON (`BigInt`).
- Pagination: `order_by: {id: asc}` with `where: {id: {_gt: $last}}`, pages of 1 000, **stop on an EMPTY page** (a
  server-side row cap below 1 000 must not truncate silently; `scripts/check.ts` and `solver/from_indexer.py` agree, v3).

## Layer 1 — append-only history (replay any past block)

Nothing is ever deleted from these tables; each row carries `blockNumber` and `logIndex`.
To rebuild the state at block `B`, filter `blockNumber <= B` and replay in `(blockNumber, logIndex)` order.

| Entity | One row per | Key fields |
|---|---|---|
| `Feedback` | `NewFeedback` (id `agentId-client-feedbackIndex`) | `value` (exact int128), `valueDecimals`, `tagHash` (keccak256 of the tag bytes = `indexedTag1`: **the tag's identity**), `tag1` (display text) with `tag1Exact` (false: NUL or lone surrogate escaped as `\u0000`, or cut at 1 KiB; never match such a tag by text), `tag2`, `triple` (`client-agentId-tagHash`), `txFrom` (signer, ≠ client when relayed), `revokedAtBlock` (null = active), `clientWasController` (at the feedback's block) |
| `WalletChange` | `MetadataSet(key = "agentWallet")` | `wallet` (`0x000…0` = cleared, emitted on every transfer) |
| `OwnerChange` | ERC-721 `Transfer` | `from`, `to`, `isMint` |
| `ApprovalChange` | ERC-721 `Approval` | `approved` |
| `OperatorChange` | `ApprovalForAll` | `owner`, `operator`, `approved` |
| `RegistryEvent` | `Upgraded` / `OwnershipTransferred` of either proxy (D17 watch) | `registry`, `kind`, `implementation`, `newOwner` |

**Solver input equivalents** (what `solver/from_indexer.py` should produce):
- `onchain_feedbacks.json` ← `Feedback` with `blockNumber <= B`: `{a: agent_id, c: client, i: feedbackIndex, v: value, d: valueDecimals, t1: tag1, t2: tag2, r: revokedAtBlock != null && revokedAtBlock <= B}`.
  A row with `tag1Exact = false` must never match a filter tag (its text is escaped or cut; v3): compare `tagHash`
  with keccak256 of the filter tag, or skip such rows (relayed to 04-bis).
- identity at `B` ← replay of `OwnerChange`, `WalletChange`, `ApprovalChange` (reset by each `Transfer`), `OperatorChange`.
  Or, for the current head only, read layer 2 directly.

## Layer 2 — current state (head of the chain)

| Entity | Meaning |
|---|---|
| `Agent` (id = agentId) | `owner`, `wallet` (`0x0` if cleared), `approved` (`0x0` if none), `registeredBlock`, `registeredTxFrom`, `transferCount`, `lastTransferBlock`, `regTx` / `regPhase` (registration callback tracking, below) |
| `WalletAgents` (id = wallet) | reverse index wallet → `agentIds` (not available on-chain). `count > 1` = shared wallet (D20 row copy) |
| `Operator` (id = `owner-operator`) | `active` operator approvals |

## Layer 3 — normative edges per anchor set

`SetEdge` (id = `setId-client-agentId`): one row per (set, client, agent) pair that has at least one feedback under a
tag of the set's filter. Today the indexer maintains the pseudo-set **`"ref"`** (`AnchorSet {id: "ref", kind:
"reference"}`): schema `src/lib/schema_reference.json` (byte-identical copy of `solver/schema_reference.json`,
tested), filter `reference`. Rules = `solver/FORMAT.md` §0 R2-R6, the reference implementation being `solver/graph.py`:
R3 latest non-revoked per (client, agent, tag1), out of bounds ⇒ that tag gives nothing (judged **per tag**, no fallback);
R5 negative dominance across tags, **ties broken by the highest feedbackIndex**; R2 endorsement tags only; R6 rejection
of the target's **current** controllers (owner, operator, agentWallet, approved; no past-owner rule, D20) **only when the
combined weight is positive: a controller's negative edge is kept** (rule B, D48-B, v3; contract 02-bis `_edgeHolds`).
`valueDecimals > 18` gives nothing for that tag, as the contract's `_normalize` (DEC18). Feedbacks are matched to the
filter by `tagHash`, never by their text.

| Field | Meaning |
|---|---|
| `set_id` | `"ref"` |
| `w` | int16 weight on the 1e-4 grid (`graph.quantize`); 0 when rejected |
| `decidingTag`, `feedbackIndex` | the feedback that decided `w` |
| `rejected` | **null = edge retained** (a controller's negative edge included) · `NO_ACTIVE_FEEDBACK` (all revoked) · `OUT_OF_BOUNDS` (no tag yields a weight) · `ZERO_WEIGHT` · `CONTROLLER_OWNER` · `CONTROLLER_OPERATOR` · `CONTROLLER_WALLET` · `CONTROLLER_APPROVED` (positive combined weight only) |
| `updatedAtBlock` | last block where the row changed |

**Not decided here: the emitter node** (R7, D20 row copy, D44 owner fallback): `SetEdge` is keyed by the client
*address*; the solver resolves the emitter from `Agent` + `WalletAgents` (or from the identity replay).

`TripleLatest` (id = `client-agentId-tagHash`, fixed length whatever the tag): the latest non-revoked feedback of each
triple, **for every tag** (an anchor set may commit its own filter, D12; the certificate audit replays it, looking up
keccak256 of each schema tag).

**Registration callback (REGCB, v3).** ERC-8004 v2.0.0 `register()` writes agentWallet before `_safeMint` but emits
`MetadataSet(agentWallet)` after the `onERC721Received` callback. When the callback changed the wallet or the owner,
that late event is ignored (no `WalletChange` row): the indexer keeps the registry's state. Same rule to port to
`solver/graph.py` `replay_identity_events` (relayed to 04-bis).

**Parity (MESURÉ 05/10)**: `solver/from_indexer.py --endpoint <graphql> --chain C --block <head> --parity` reports
0 difference on 143 (11 edges), 10143 (30) and 10 (10). A dump of chain 143 is in
`solver/tests/fixtures/indexer/` (`test_parity_real_indexer_dump`).

## ANCRE certificates — live audit (contract `AnchoredReputation`)

Handlers in `src/handlers/ancre.ts` (v3, review 06/10 OUTERCALL):
- **Schema and rows**: from the `registerAnchorSet` / `submitCertificate` calldata, **direct or nested** in a wrapper's
  input (Safe, Multicall3, 4337, EIP-7702: the inner call is a contiguous ABI `bytes`, found by its selector). Trusted
  only when it provably is the committed data: set params hash to the setId (`computeSetId`), rows hash to the event's
  `graphRoot` (with `nCert` and `numRows`). Monad serves no call traces, hence the scan; an input with no matching
  inner call is `UNDECODABLE`, never guessed. (The 02-bis contract requires `msg.sender == tx.origin` for certificates
  of open sets, G-11.)
- **Node table**: from a direct `addNodes` / `newNodes` (exactly `count` entries); otherwise from the contract itself,
  `nodeKeyAt(setId, i)` read at the head through an Envio Effect (`src/lib/nodekeys.ts`, keys are immutable). RPC per
  chain: `ENVIO_MONAD_RPC`, `ENVIO_MONAD_TESTNET_RPC`, `ENVIO_OPTIMISM_RPC` (defaults: the public RPCs). A key that
  cannot be read yet (RPC down or lagging) is not cached and stays a hole, retried on the next `NodesAdded` or
  certificate: `nodesComplete` never stays false for good.

| Entity | Content |
|---|---|
| `AnchorSet` (kind `onchain`, id = setId) | anchors, lambdas, α (`alphaN`, `alphaD` as **BigInt**: uint32 on chain, v3), `tagsJson` (the set's edge schema, bounds in WAD), `policyJson`, `ownerFallback`, `registryVerified`, `decodable` (params decoded **and** hashing to setId), `nodesComplete`, `nodeCount` |
| `SetNode` (id = setId-index) | the set's node table: anchors at 0..k−1, then appended agents/addresses in contract order |
| `Certificate` (id = txHash-logIndex) | event fields + `submitter`, `status` (`AUDITED` / `UNDECODABLE` / `ROOT_MISMATCH` / `UNKNOWN_SET` / `NODES_MISSING`), `graphRootMatches`, `rowsChecked`, `edgesChecked`, `discrepancyCount` |
| `Discrepancy` | one audit finding: `kind` (see `src/lib/audit.ts`), the edge **whose proof corrects it** (`u`, `dst`, `client`, `agentId`, committed vs registry weight; `bCommitted` / `bRegistry` B⁺ as BigInt; `rowPlus` / `rowDeclared` for DILUTION / DEFLATED), `proof` (`proveEdge`; `proveWallet` for a SOURCE row and every edge finding of it; `refused at submission`; `none (…)`), and `provenAtBlock` once a proof landed |
| `SetHealth` (id = setId) | `status` (`CLEAN` / `DISCREPANCY` / `UNAUDITED` / `STALE` after `RegistryChanged`), certificates, latest certificate and `eEff`, `openDiscrepancies` (closed by `RowVoided` for the row; by `EdgeProven(u, agentJ)` for that exact edge, then DILUTION / DEFLATED findings of the row re-evaluated on the amended row), `edgesProven`, `rowsVoided`, `transfersFlagged`, `registryChangedAtBlock` |

The audit runs inside the handler against the registry state rebuilt by the indexer **at that log** (events of a chain
are processed in block/log order). Contract address: placeholder (`0x…01`) on 143 and 10143 until deployment.

```graphql
# Is the latest certificate of a set clean? What would a watcher prove?
query { SetHealth(where: {chainId: {_eq: 10143}}) { id status certificates openDiscrepancies lastEEff edgesProven } }
query { Discrepancy(where: {set_id: {_eq: "0x…"}}) { kind proof agentId client wCommitted wRegistry bCommitted bRegistry } }
```

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
  0 discrepancy, 4 normative violations (D37) → FABRICATED, INFLATED, OMITTED_NEG ×2, DILUTION on the omitted #3 (v3).
- `test/offline.test.ts` (`pnpm test`, monorepo): the same parity and audit WITHOUT HyperSync, by replaying the real
  layer-1 dump `solver/tests/fixtures/indexer/` through the current handlers (`test/replay.ts`); `ANCRE_VECTORS=<solver
  dir>` audits another vector set (04-bis, completed by its snapshot). `test/common.test.ts`: joint vectors 02-bis/04-bis.
- `test/review.test.ts`, `test/check.test.ts`, `test/publish.test.ts`: non-regression of the 06/10 review (journal
  `docs/chantiers/journal/indexer-revue.md`).
- `test/ancre.test.ts` (`pnpm test`): the certificate handlers on a simulated registry: set and node table from calldata,
  honest certificate AUDITED/CLEAN, wrong root → ROOT_MISMATCH, inflated edge flagged with `proveEdge` then closed by
  `EdgeProven`, nested certificate and set audited, relayed `addNodes` repaired by `nodeKeyAt` (local JSON-RPC), opaque
  input UNDECODABLE, params not hashing to setId → no schema, `RegistryChanged` → STALE.
- `test/ancre.real.test.ts` (`pnpm test:parity`): the same handlers on Monad's real state (block 108 835 675) with the
  real calldata of the normative vectors: our `computeSetId` equals the solver's setId on all 8; 4 honest → AUDITED,
  0 discrepancy, root identical; 4 violations flagged. MESURÉ 06/10.

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
- v2 (06/10): `AnchoredReputation` handlers: `AnchorSet` (on-chain sets), `SetNode`, `Certificate`, `Discrepancy`,
  `SetHealth`. Live once the contract address replaces the placeholder.
- v3 (06/10, review): tags keyed by `tagHash` (`Feedback.triple`, `TripleLatest.id`), `tag1Exact`; `alphaN`/`alphaD`,
  `bCommitted`/`bRegistry` BigInt; `Discrepancy.rowPlus`/`rowDeclared`; kinds DILUTION / DEFLATED; rule B; nested calls
  and `nodeKeyAt` repair; `Agent.regTx`/`regPhase`. **Breaking for the GraphQL schema: the next Cloud deployment
  re-indexes from scratch** (it does anyway on every push).
