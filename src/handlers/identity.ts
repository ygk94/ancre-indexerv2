// IdentityRegistry (ERC-8004 v2.0.0): owner, agentWallet, approved and operators rebuilt from events only.
//
// REGCB (review 06/10): register() writes agentWallet = msg.sender BEFORE _safeMint, but emits MetadataSet(agentWallet)
// AFTER the onERC721Received callback. Logs of one registration: Transfer(0, C), [callback events], Registered,
// MetadataSet(C). A wallet change made in the callback (unset, set, transfer) leaves the registry with that change,
// and the late MetadataSet(C) would overwrite it here. The agent's registration phase (regTx, regPhase) tells the
// registration's own late event apart: it is ignored when a wallet or owner change happened after the mint in the same
// transaction. Same rule to port to solver/graph.py replay_identity_events (relayed to 04-bis).
import { indexer } from "envio";
import { ZERO } from "../lib/rules.js";
import { bumpStats, getAgent, lc, moveWallet, recomputeEdgesInto } from "../lib/state.js";
import { safeText } from "../lib/text.js";

const logId = (e: { block: { number: number }; logIndex: number }) => `${e.block.number}-${e.logIndex}`;

indexer.onEvent(
  { contract: "IdentityRegistry", event: "Registered", fields: { transaction: ["from", "hash"] } },
  async ({ event, context }) => {
    const id = event.params.agentId.toString();
    const agent = await getAgent(context, id);
    const inReg = agent.regTx === event.transaction.hash;
    const regPhase = !inReg ? agent.regPhase
      : agent.regPhase === "minted" ? "registered" : agent.regPhase === "callback" ? "registeredStale" : agent.regPhase;
    context.Agent.set({ ...agent, uri: safeText(event.params.agentURI).text, registeredBlock: BigInt(event.block.number),
      registeredTxFrom: lc(event.transaction.from ?? ZERO), regPhase });
  },
);

indexer.onEvent({ contract: "IdentityRegistry", event: "URIUpdated" }, async ({ event, context }) => {
  const agent = await getAgent(context, event.params.agentId.toString());
  context.Agent.set({ ...agent, uri: safeText(event.params.newURI).text });
});

/** A wallet or owner change of an agent inside its registration transaction, before Registered: the callback. */
const inCallback = (a: { regTx?: string; regPhase?: string }, tx: string) =>
  a.regTx === tx && (a.regPhase === "minted" || a.regPhase === "callback");

indexer.onEvent({ contract: "IdentityRegistry", event: "Transfer", fields: { transaction: ["hash"] } }, async ({ event, context }) => {
  const id = event.params.tokenId.toString();
  const from = lc(event.params.from);
  const to = lc(event.params.to);
  const isMint = from === ZERO;
  const tx = event.transaction.hash;
  const agent = await getAgent(context, id);
  context.Agent.set({
    ...agent,
    owner: to,
    approved: ZERO, // ERC-721: approval cleared on transfer
    transferCount: agent.transferCount + (isMint ? 0 : 1),
    lastTransferBlock: isMint ? agent.lastTransferBlock : BigInt(event.block.number),
    ...(isMint ? { regTx: tx, regPhase: "minted" } : inCallback(agent, tx) ? { regPhase: "callback" } : {}),
  });
  context.OwnerChange.set({ id: logId(event), agent_id: id, from, to, isMint,
    blockNumber: BigInt(event.block.number), logIndex: event.logIndex });
  await bumpStats(context, event.block.number, isMint ? { agents: 1 } : { transfers: 1 });
  if (!isMint) await recomputeEdgesInto(context, id, event.block.number);
});

indexer.onEvent(
  { contract: "IdentityRegistry", event: "MetadataSet", fields: { transaction: ["hash"] } },
  async ({ event, context }) => {
    if (event.params.metadataKey !== "agentWallet") return;
    const v = event.params.metadataValue; // hex bytes: 20 bytes, or empty when cleared
    const wallet = v.length === 42 ? lc(v) : ZERO;
    const id = event.params.agentId.toString();
    const tx = event.transaction.hash;
    const agent = await getAgent(context, id);
    const inReg = agent.regTx === tx;
    if (inReg && agent.regPhase === "registeredStale") {
      // register()'s own late event after a change made in the callback: the registry kept the callback's state
      context.Agent.set({ ...agent, regPhase: "done" });
      return;
    }
    const regPhase = !inReg ? agent.regPhase : agent.regPhase === "registered" ? "done"
      : inCallback(agent, tx) ? "callback" : agent.regPhase;
    await moveWallet(context, id, agent.wallet, wallet, event.block.number);
    context.Agent.set({ ...agent, wallet, regPhase });
    context.WalletChange.set({ id: logId(event), agent_id: id, wallet,
      blockNumber: BigInt(event.block.number), logIndex: event.logIndex });
    await recomputeEdgesInto(context, id, event.block.number);
  },
);

indexer.onEvent({ contract: "IdentityRegistry", event: "Approval" }, async ({ event, context }) => {
  const id = event.params.tokenId.toString();
  const approved = lc(event.params.approved);
  const agent = await getAgent(context, id);
  context.Agent.set({ ...agent, approved });
  context.ApprovalChange.set({ id: logId(event), agent_id: id, approved,
    blockNumber: BigInt(event.block.number), logIndex: event.logIndex });
  await recomputeEdgesInto(context, id, event.block.number);
});

indexer.onEvent({ contract: "IdentityRegistry", event: "ApprovalForAll" }, async ({ event, context }) => {
  const owner = lc(event.params.owner);
  const operator = lc(event.params.operator);
  const active = event.params.approved;
  context.Operator.set({ id: `${owner}-${operator}`, owner, operator, active });
  context.OperatorChange.set({ id: logId(event), owner, operator, approved: active,
    blockNumber: BigInt(event.block.number), logIndex: event.logIndex });
  const owned = await context.Agent.getWhere({ owner: { _eq: owner } });
  for (const a of owned) await recomputeEdgesInto(context, a.id, event.block.number);
});

for (const contract of ["IdentityRegistry", "ReputationRegistry"] as const) {
  const registry = contract === "IdentityRegistry" ? "identity" : "reputation";
  indexer.onEvent({ contract, event: "Upgraded", fields: { transaction: ["hash"] } }, async ({ event, context }) => {
    context.RegistryEvent.set({ id: logId(event), registry, kind: "Upgraded", implementation: lc(event.params.implementation),
      newOwner: undefined, blockNumber: BigInt(event.block.number), txHash: event.transaction.hash });
  });
  indexer.onEvent({ contract, event: "OwnershipTransferred", fields: { transaction: ["hash"] } }, async ({ event, context }) => {
    context.RegistryEvent.set({ id: logId(event), registry, kind: "OwnershipTransferred", implementation: undefined,
      newOwner: lc(event.params.newOwner), blockNumber: BigInt(event.block.number), txHash: event.transaction.hash });
  });
}
