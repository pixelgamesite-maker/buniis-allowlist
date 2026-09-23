/**
 * Optional: sets the root from merkle-root.txt on-chain with a private key.
 * The admin page does the same thing through your connected wallet, which
 * is the recommended route — it keeps the owner key out of any terminal.
 *
 * Usage (mainnet):
 *   CONTRACT_ADDRESS=0x2E04eb88d9e9d066D7b0977848ffb02Dd4eaf346 \
 *   PRIVATE_KEY=0x... \
 *   CHAIN_ID=4663 RH_RPC_URL=https://rpc.mainnet.chain.robinhood.com \
 *   node set-merkle-root.mjs
 *
 * CHAIN_ID and RH_RPC_URL are required on purpose, so this never lands on
 * the wrong network by default.
 */
import { readFileSync } from "fs";
import { createWalletClient, createPublicClient, http, defineChain } from "viem";
import { privateKeyToAccount } from "viem/accounts";

const { CONTRACT_ADDRESS, PRIVATE_KEY, RH_RPC_URL, CHAIN_ID } = process.env;
if (!CONTRACT_ADDRESS || !PRIVATE_KEY || !RH_RPC_URL || !CHAIN_ID) {
  console.error("Set CONTRACT_ADDRESS, PRIVATE_KEY, RH_RPC_URL and CHAIN_ID.");
  process.exit(1);
}

const root = readFileSync("merkle-root.txt", "utf8").trim();
const chain = defineChain({
  id: Number(CHAIN_ID),
  name: "Robinhood Chain",
  nativeCurrency: { decimals: 18, name: "Ether", symbol: "ETH" },
  rpcUrls: { default: { http: [RH_RPC_URL] } },
});
const account = privateKeyToAccount(PRIVATE_KEY);
const wallet = createWalletClient({ account, chain, transport: http(RH_RPC_URL) });
const client = createPublicClient({ chain, transport: http(RH_RPC_URL) });

const abi = [{ type: "function", name: "setMerkleRoot", stateMutability: "nonpayable", inputs: [{ name: "root", type: "bytes32" }], outputs: [] }];

console.log(`Setting root ${root} on ${CONTRACT_ADDRESS} (chain ${CHAIN_ID})…`);
const hash = await wallet.writeContract({ address: CONTRACT_ADDRESS, abi, functionName: "setMerkleRoot", args: [root] });
console.log(`Sent: ${hash}`);
const receipt = await client.waitForTransactionReceipt({ hash });
console.log(`Confirmed in block ${receipt.blockNumber}, status: ${receipt.status}`);
