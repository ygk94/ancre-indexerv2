// A local JSON-RPC endpoint answering `nodeKeyAt(setId, i)` from a table, so that the node-table repair Effect
// (src/lib/nodekeys.ts) is tested end to end over HTTP without touching a public RPC.
import { createServer, type Server } from "node:http";
import { decodeFunctionData, encodeFunctionResult, parseAbi, type Hex } from "viem";

const ABI = parseAbi(["function nodeKeyAt(bytes32 setId, uint256 i) view returns (bytes32)"]);
const ZERO32 = ("0x" + "00".repeat(32)) as Hex;

export type MockRpc = { url: string; keys: Map<string, Hex>; calls: number; down: boolean; close(): Promise<void> };

/** keys: `${setId}-${index}` -> node key. `down = true` answers every call with a JSON-RPC error. */
export async function startMockRpc(): Promise<MockRpc> {
  const state = { keys: new Map<string, Hex>(), calls: 0, down: false };
  const answer = (req: { id: number; method: string; params: [{ data: Hex }] }) => {
    if (req.method === "eth_chainId") return { jsonrpc: "2.0", id: req.id, result: "0x279f" };
    if (state.down || req.method !== "eth_call") return { jsonrpc: "2.0", id: req.id, error: { code: -32000, message: "down" } };
    state.calls++;
    const { args } = decodeFunctionData({ abi: ABI, data: req.params[0].data });
    const key = state.keys.get(`${(args[0] as string).toLowerCase()}-${args[1]}`) ?? ZERO32;
    return { jsonrpc: "2.0", id: req.id, result: encodeFunctionResult({ abi: ABI, functionName: "nodeKeyAt", result: key }) };
  };
  const server: Server = createServer((rq, rs) => {
    let body = "";
    rq.on("data", (c) => (body += c));
    rq.on("end", () => {
      const j = JSON.parse(body);
      rs.setHeader("Content-Type", "application/json");
      rs.end(JSON.stringify(Array.isArray(j) ? j.map(answer) : answer(j)));
    });
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const port = (server.address() as { port: number }).port;
  return Object.assign(state, {
    url: `http://127.0.0.1:${port}`,
    close: () => new Promise<void>((r) => server.close(() => r())),
  }) as MockRpc;
}

export const agentKey = (id: number) => ("0x01" + id.toString(16).padStart(62, "0")) as Hex;
export const addressKey = (a: string) => ("0x02" + "00".repeat(11) + a.slice(2)) as Hex;
