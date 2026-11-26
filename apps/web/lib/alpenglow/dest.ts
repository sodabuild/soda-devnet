// Server-side destination chains for the /alpenglow demo: the viem chain, the
// RPC, the one lending action the SODA account performs there, and the light
// client deployments. The page-visible part of each destination is in
// shared.ts (DESTS); contracts/evm/test/dests.mjs mirrors this list for the
// regression tests.

import { encodeFunctionData, parseAbi, type Chain, type Hex } from "viem";
import { baseSepolia, bscTestnet } from "viem/chains";
// Aave V3 on Base Sepolia (from bgd-labs/aave-address-book).
const AAVE_V3_BASE_SEPOLIA = {
  POOL: "0x8bAB6d1b75f19e9eD9fCe8b9BD338844fF79aE27",
  WETH_GATEWAY: "0x0568130e794429D2eEBC4dafE18f25Ff1a1ed8b6",
  A_WETH: "0x73a5bB60b0B0fc35710DDc0ea9c407031E31Bdbb",
} as const;

import { DESTS, type DestKey, type DestMeta } from "./shared";
import simulated from "./deployment.json";
import local from "./local-deployment.json";

type Deployment = { lightClient: Hex; factory: Hex };

export type DestServer = {
  meta: DestMeta;
  chain: Chain;
  rpc: string;
  action: {
    /** Contract the account calls with DEPOSIT_WEI of native coin. */
    target: Hex;
    calldata: (account: Hex) => Hex;
    /** ERC-20 the account holds afterwards; balanceOf shows the position. */
    receiptToken: Hex;
  };
  /** AlpenglowLightClient + factory for our local node's real certificates, or null until deployed. */
  local: Deployment | null;
  /** SolanaLightClient + factory for the simulated devnet certificates, or null. */
  devnet: Deployment | null;
};

// Venus Protocol, BNB Smart Chain testnet (chain 97). vBNB.mint() is payable:
// it supplies the BNB sent with the call and mints vBNB (8 decimals) to the
// caller, the same one-call shape as Aave's depositETH.
export const VENUS_BSC_TESTNET = {
  VBNB: "0x2E7222e51c0f6e98610A1543Aa3836E092CDe62c" as Hex,
  COMPTROLLER: "0x94d1820b2D1c7c7452A163983Dc888CEC546b77D" as Hex,
};

const localDeployments = local as Record<DestKey, Deployment | null>;

const CONFIG: Record<DestKey, DestServer> = {
  "base-sepolia": {
    meta: DESTS["base-sepolia"],
    chain: baseSepolia,
    // Public endpoint by default. The Alchemy keys in .env hit their monthly
    // quota on 21 Oct 2026, and the public one is enough for a demo.
    rpc: process.env.ALPENGLOW_BASE_RPC_URL || "https://sepolia.base.org",
    action: {
      target: AAVE_V3_BASE_SEPOLIA.WETH_GATEWAY as Hex,
      calldata: (account) =>
        encodeFunctionData({
          abi: parseAbi(["function depositETH(address pool, address onBehalfOf, uint16 referralCode)"]),
          functionName: "depositETH",
          args: [AAVE_V3_BASE_SEPOLIA.POOL as Hex, account, 0],
        }),
      receiptToken: AAVE_V3_BASE_SEPOLIA.A_WETH as Hex,
    },
    local: localDeployments["base-sepolia"],
    devnet: { lightClient: simulated.lightClient as Hex, factory: simulated.factory as Hex },
  },
  "bsc-testnet": {
    meta: DESTS["bsc-testnet"],
    chain: bscTestnet,
    rpc: process.env.ALPENGLOW_BSC_RPC_URL || "https://bsc-testnet-rpc.publicnode.com",
    action: {
      target: VENUS_BSC_TESTNET.VBNB,
      // mint() takes no arguments; the account is msg.sender and receives the vBNB.
      calldata: () => encodeFunctionData({ abi: parseAbi(["function mint() payable"]), functionName: "mint" }),
      receiptToken: VENUS_BSC_TESTNET.VBNB,
    },
    local: localDeployments["bsc-testnet"],
    devnet: null,
  },
};

export function dest(key: DestKey): DestServer {
  return CONFIG[key];
}
