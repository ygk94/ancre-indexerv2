# ancre-indexer

**An Envio HyperIndex indexer that executes the ANCRE trust-graph rules on ERC-8004 registries and audits
ANCRE certificates against the registry, on Monad and other chains.**

ERC-8004 gives every agent an identity and lets anyone post feedback about it. It explicitly leaves Sybil
filtering to the reader. ANCRE is that reader: a personalised-PageRank reputation relative to anchors *the
reader chooses*, certified on-chain so that a contract can read it before paying. This indexer is the data
layer. It does three things:

1. **Compiles the normative trust graph.** Out of every feedback, it keeps the edges the ANCRE rules allow:
   - latest non-revoked feedback per (client, agent, tag), with negative dominance across tags;
   - endorsement tags only;
   - out-of-range values rejected, never capped;
   - no positive feedback from the target's own controllers (owner, operator, `agentWallet`, approved); a
     controller's negative feedback is kept, so an owner cannot silence a critic by approving it;
   - tags matched by their keccak256 hash, as the contract does: no tag text ever enters a key or an index.

   Wallets and owners are rebuilt **from events only**, because Monad serves no historical state beyond
   ~40k blocks.
2. **Audits certificates.** It decodes a certificate's calldata and compares every committed edge with the
   registry, as normalised shares `w / B`. Fabricated, inflated, diluted or omitted edges become typed
   discrepancies, each filed on the edge whose on-chain proof corrects it (`proveEdge` / `proveWallet` of the
   ANCRE contract). Calls made through a Safe, Multicall3 or a smart account are read from the nested calldata,
   and the node table is read back from the contract (`nodeKeyAt`, Effect API) when the calldata is unavailable. The
   decoder (certificate format `ancre-cert-v1`) and the audit run **inside the event handler** of the ANCRE contract:
   every `CertificateSubmitted` gets a `Certificate` row (status, Merkle root check), its `Discrepancy` findings and the
   set's `SetHealth`. Tested on Monad's real state with the real calldata of the normative certificates. The contract
   address is a placeholder until the deployment.
3. **Measures the standard with HyperSync.** A multichain scan shows how few ERC-8004 feedbacks survive the
   rules (see below).

## Live endpoint

**`https://indexer.dev.hyperindex.xyz/433cc83/v1/graphql`** (Envio Cloud, public, read-only; deployed 2026-10-05, 3 chains synced in 1 minute, 55 775 events).

```bash
curl -s https://indexer.dev.hyperindex.xyz/433cc83/v1/graphql -H 'Content-Type: application/json' \
  -d '{"query":"{ ChainStats { chainId agents feedbacks refEdges selfRatings outOfRange } }"}'
```

Verified against the chain the same day: `pnpm check --endpoint <url> --chain C --full` green on the 3 chains, and the
reference solver's parity tool reports 0 difference.

## Chains

| Chain | Registries | Start block |
|---|---|---|
| Monad mainnet (143) | `0x8004A169…a432` / `0x8004BAa1…9b63` | 52 952 790 |
| Monad testnet (10143) | `0x8004A818…BD9e` / `0x8004B663…8713` | 10 391 697 |
| Optimism (10) | `0x8004A169…a432` / `0x8004BAa1…9b63` | 147 514 947 |

Per-chain data mode (`disable_default_cross_chain: true`): an `agentId` is only unique on its chain, and a
reorg rolls back its own chain only. Real volume measured on 2026-09-28: 55 138 events in total.

## Data model (`schema.graphql`, documented in [SCHEMA.md](SCHEMA.md))

| Layer | Entities |
|---|---|
| 1 · append-only history (replays any past block) | `Feedback`, `WalletChange`, `OwnerChange`, `ApprovalChange`, `OperatorChange`, `RegistryEvent` |
| 2 · current state | `Agent`, `WalletAgents` (reverse wallet → agents index, absent on-chain), `Operator` |
| 3 · normative edges | `TripleLatest` (every tag), `SetEdge` per anchor set (`ref` = reference schema), with a typed rejection reason (`null` = retained) |
| ANCRE audit | `AnchorSet` (on-chain sets), `SetNode`, `Certificate`, `Discrepancy` (with the on-chain proof to use), `SetHealth` |
| stats | `ChainStats` |

```graphql
query { ChainStats { chainId agents feedbacks refEdges selfRatings outOfRange sharedWallets } }
```

## Run it

```bash
pnpm install
echo 'ENVIO_API_TOKEN=<your token from https://envio.dev/app/api-tokens>' > .env
pnpm codegen
pnpm dev            # Postgres + Hasura in Docker; GraphQL on http://localhost:8080 (admin secret: testing)
                    # with colima: DOCKER_HOST=unix://$HOME/.colima/default/docker.sock pnpm dev
```

## Correctness

| Command | What it proves |
|---|---|
| `pnpm test` | Rule unit tests on real cases, simulated: the slash-then-review on agent #4, #8317 rating itself 78 times through its own `agentWallet`, a 1e38 value, a transfer, a revocation, a tie between tags; hostile inputs (NUL and 4 KiB tags, uint32 parameters, relayed calls, wallet changed in the registration callback). In the monorepo, also the parity and audit checks below **without HyperSync**, by replaying the real history dumped from the indexer |
| `pnpm test:parity` | Replays the **real history** of each chain and checks that the edges are identical to the reference solver's: 11 edges on Monad at block 108 434 518, 28 on the testnet, 10 on Optimism. Then audits real certificates against Monad's rebuilt state: 4 honest certificates → 0 discrepancy; the 4 normative violations (fabricated, inflated, omitted negative, dilution) and tampered variants (wrong source, ghost agent, opposite sign) → caught |
| `pnpm check --chain 143 --full` | Live consistency with the registries, at the block the indexer has processed, through Multicall3: Σ `getLastIndex` = #feedbacks, `getClients` of **every minted** agent, `readFeedback` (value, decimals, tag hash, revocation) of the latest feedback of every triple (of every feedback with `--full`), owner and wallet of **every** agent, mint count, `getVersion` |

## HyperSync survival scan

MEASURED on 2026-09-28/29 under the ANCRE reference schema and filter. The scan streams every ERC-8004 log of a chain through HyperSync (Monad's full history in ~17 s, Base's 531 500 feedbacks included), rebuilds identities from events and applies the reference edge rules. Its script lives in the ANCRE monorepo, next to the solver it calls; it will be published here with the solver.

| Chain | Feedbacks | Top-client share | Edges kept | Survival |
|---|---|---|---|---|
| Monad | 9 283 | 11 % (83 % of all feedback targets one farm agent) | 11 | 0.12 % |
| Monad testnet | 1 862 | 58 % | 28 | 1.5 % |
| Arbitrum | 498 | 63 % | 22 | 4.4 % |
| Optimism | 334 | 54 % | 10 | 3.0 % |
| Polygon | 508 | 60 % | 10 | 2.0 % |
| Ethereum | 17 682 | 80 % | 519 | 2.9 % |
| Base | 531 500 | 9 % (70 % of all feedback targets one agent) | 9 857 | 1.9 % |

The reference schema was built from Monad's tags, and an unknown tag never creates an edge. Outside Monad,
survival is therefore a lower bound under this schema, not a verdict on those chains.

## AI tools

Built with Claude Code and the official Envio skills (`envio skills update`) and docs. Every figure above
comes from a command in this repository.

## License

MIT, see [LICENSE](LICENSE).
