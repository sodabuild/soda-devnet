// Destination chains for the regression tests: where the light client and the
// SODA account live, and the one lending action the account performs there.
// The web app keeps the same list in apps/web/lib/alpenglow/dest.ts.
//
// Pick one with DEST=base-sepolia (default) or DEST=bsc-testnet.

import fs from 'node:fs'
import { encodeFunctionData, parseAbi } from 'viem'
import { baseSepolia, bscTestnet } from 'viem/chains'

// RPC overrides, named as in the web app (apps/web/lib/alpenglow/dest.ts) so
// they do not collide with the MPC demo's BASE_SEPOLIA_RPC_URL: the shell
// environment first, then the repo-root .env (the tests do not load it any
// other way), then the public endpoint.
function envVar(name) {
  if (process.env[name]) return process.env[name]
  try {
    return fs.readFileSync(new URL('../../../.env', import.meta.url), 'utf8').match(new RegExp(`^${name}=(.*)$`, 'm'))?.[1].trim() || undefined
  } catch {
    return undefined
  }
}

export const DESTS = {
  'base-sepolia': {
    key: 'base-sepolia',
    name: 'Base Sepolia',
    native: 'ETH',
    chain: baseSepolia,
    rpc: envVar('ALPENGLOW_BASE_RPC_URL') || 'https://sepolia.base.org',
    explorerTx: (h) => `https://sepolia.basescan.org/tx/${h}`,
    // Aave V3 (bgd-labs/aave-address-book, AaveV3BaseSepolia): depositETH on
    // the gateway supplies native ETH and the account receives aWETH.
    protocol: 'Aave V3',
    target: '0x0568130e794429D2eEBC4dafE18f25Ff1a1ed8b6',
    calldata: (account) => encodeFunctionData({ abi: parseAbi(['function depositETH(address,address,uint16)']), args: ['0x8bAB6d1b75f19e9eD9fCe8b9BD338844fF79aE27', account, 0] }),
    receiptToken: '0x73a5bB60b0B0fc35710DDc0ea9c407031E31Bdbb',
    receiptSymbol: 'aWETH',
    receiptDecimals: 18,
    memoAction: 'aave-v3-deposit',
  },
  'bsc-testnet': {
    key: 'bsc-testnet',
    name: 'BNB Smart Chain testnet',
    native: 'BNB',
    chain: bscTestnet,
    rpc: envVar('ALPENGLOW_BSC_RPC_URL') || 'https://bsc-testnet-rpc.publicnode.com',
    explorerTx: (h) => `https://testnet.bscscan.com/tx/${h}`,
    // Venus Core Pool vBNB (symbol "vBNB", name "Venus BNB", 8 decimals,
    // comptroller 0x94d1820b2D1c7c7452A163983Dc888CEC546b77D; read back from
    // the chain on 24 Nov 2026). mint() is payable: it supplies the BNB sent
    // with the call and mints vBNB to the caller.
    protocol: 'Venus',
    target: '0x2E7222e51c0f6e98610A1543Aa3836E092CDe62c',
    calldata: () => encodeFunctionData({ abi: parseAbi(['function mint() payable']), functionName: 'mint' }),
    receiptToken: '0x2E7222e51c0f6e98610A1543Aa3836E092CDe62c',
    receiptSymbol: 'vBNB',
    receiptDecimals: 8,
    memoAction: 'venus-supply',
  },
}

export function dest(key = process.env.DEST || 'base-sepolia') {
  const d = DESTS[key]
  if (!d) throw new Error(`unknown DEST "${key}", expected one of ${Object.keys(DESTS).join(', ')}`)
  return d
}
