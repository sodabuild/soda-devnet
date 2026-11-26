// Shared by the /alpenglow page and its API routes. Testnet only: Solana
// devnet (which runs Alpenglow) or our local Alpenglow node on one side, and
// one of the destination chains below on the other.
//
// The owner's action request for another chain is a Solana transaction whose
// Memo holds every field of the action, so anyone can read the approval on an explorer.
// The server rebuilds the same fields from the memo and refuses anything that
// is not the one demo action of the chosen destination (a DEPOSIT_WEI deposit
// into that chain's lending protocol).

import deployment from "./deployment.json";

// ---- destination chains ----------------------------------------------------
// Everything the page needs to label a destination. The server-only parts
// (RPC, viem chain, calldata, deployments) live in dest.ts.
export type DestKey = "base-sepolia" | "bsc-testnet";
export const DEST_KEYS: readonly DestKey[] = ["base-sepolia", "bsc-testnet"];
export const DEFAULT_DEST: DestKey = "base-sepolia";

export type DestMeta = {
  key: DestKey;
  /** Chain name as a user reads it. */
  name: string;
  /** Short form for buttons and headings. */
  short: string;
  chainId: number;
  /** Native coin the account deposits and the relayer pays gas in. */
  native: string;
  /** Lending protocol the demo deposits into, and the token it hands back. */
  protocol: string;
  receiptSymbol: string;
  receiptDecimals: number;
  /** Identifies the action inside the memo, for people reading explorers. */
  memoAction: string;
  explorer: string;
  explorerTx: (hash: string) => string;
  explorerAddress: (addr: string) => string;
};

export const DESTS: Record<DestKey, DestMeta> = {
  "base-sepolia": {
    key: "base-sepolia",
    name: "Base Sepolia",
    short: "Base",
    chainId: 84532,
    native: "ETH",
    protocol: "Aave V3",
    receiptSymbol: "aWETH",
    receiptDecimals: 18,
    memoAction: "aave-v3-deposit",
    explorer: "BaseScan",
    explorerTx: (h) => `https://sepolia.basescan.org/tx/${h}`,
    explorerAddress: (a) => `https://sepolia.basescan.org/address/${a}`,
  },
  "bsc-testnet": {
    key: "bsc-testnet",
    name: "BNB Smart Chain testnet",
    short: "BNB Chain",
    chainId: 97,
    native: "BNB",
    protocol: "Venus",
    receiptSymbol: "vBNB",
    receiptDecimals: 8,
    memoAction: "venus-supply",
    explorer: "BscScan",
    explorerTx: (h) => `https://testnet.bscscan.com/tx/${h}`,
    explorerAddress: (a) => `https://testnet.bscscan.com/address/${a}`,
  },
};

/** A known destination, or null for anything else. */
export function parseDest(v: unknown): DestKey | null {
  return (DEST_KEYS as readonly string[]).includes(String(v)) ? (v as DestKey) : null;
}

/** The page's view: an unknown or missing ?dest falls back to the default. */
export function destKey(v: unknown): DestKey {
  return parseDest(v) ?? DEFAULT_DEST;
}

export const ALPENGLOW = deployment as {
  chainId: number;
  lightClient: `0x${string}`;
  factory: `0x${string}`;
  validators: number;
  thresholdPct: number;
  deployedAt: string;
  deployTxs: Record<string, string>;
};

export const MEMO_PROGRAM_ID = "MemoSq4gqABAXKb96qnH8TysNcWxMyWCqXgDLGmfcHr";
export const MEMO_PREFIX = "SODA cross-chain action v1";
export const DEPOSIT_WEI = 100_000_000_000_000n; // 0.0001 of the native coin (ETH or BNB)
export const NON_SIGNER_CHOICES = [0, 20, 50] as const;

// Measured on Base Sepolia, 14 Oct 2026: the same Aave deposit sent by the
// SODA MPC path from a normal address (tx 0x12acc10c…).
export const MPC_BASELINE = {
  gasUsed: 158_421,
  tx: "0x12acc10c2b9544e7861ae2413fd28a6b265c07dc03e15a91799b402be26621bb",
  blockToBlockMs: 4_000,
};

export type Approval = {
  chainId: number;
  account: `0x${string}`;
  target: `0x${string}`;
  value: bigint;
  dataHash: `0x${string}`;
  nonce: bigint;
  deadline: bigint;
};

export function approvalMemo(a: Approval, action = DESTS[DEFAULT_DEST].memoAction): string {
  return [
    MEMO_PREFIX,
    // For people reading it on an explorer; the fields below are what count.
    `action=${action}`,
    `chain=${a.chainId}`,
    `account=${a.account}`,
    `target=${a.target}`,
    `value=${a.value}`,
    `data=${a.dataHash}`,
    `nonce=${a.nonce}`,
    `deadline=${a.deadline}`,
  ].join("|");
}

export function parseApprovalMemo(memo: string): Approval | null {
  const parts = memo.split("|");
  if (parts[0] !== MEMO_PREFIX) return null;
  const f = Object.fromEntries(parts.slice(1).map((p) => p.split("=", 2)));
  const hex = (v: string | undefined, len: number) =>
    v && new RegExp(`^0x[0-9a-fA-F]{${len}}$`).test(v) ? (v as `0x${string}`) : null;
  const num = (v: string | undefined) => (v && /^\d+$/.test(v) ? BigInt(v) : null);
  const account = hex(f.account, 40);
  const target = hex(f.target, 40);
  const dataHash = hex(f.data, 64);
  const chainId = num(f.chain);
  const value = num(f.value);
  const nonce = num(f.nonce);
  const deadline = num(f.deadline);
  if (!account || !target || !dataHash || chainId == null || value == null || nonce == null || deadline == null) {
    return null;
  }
  return { chainId: Number(chainId), account, target, value, dataHash, nonce, deadline };
}

// Shapes the API routes return.
export type EvmTxReport = {
  hash: string;
  gasUsed: number;
  feeWei: string;
  calldataBytes: number;
  ms: number;
};

export type AccountState = {
  owner: string;
  ownerHex: `0x${string}`;
  account: `0x${string}`;
  deployed: boolean;
  nonce: string;
  balanceWei: string;
  /** Receipt token held (aWETH on Base, vBNB on BNB Chain), in its own base units. */
  receiptUnits: string;
  lightClient: string;
  factory: string;
  dest: DestKey;
};

export type PrepareResponse = AccountState & {
  memo: string;
  funding?: EvmTxReport;
};

export type CertifyResponse = {
  slot: number;
  blockhash: string;
  blockId: `0x${string}`;
  approvalsRoot: `0x${string}`;
  validators: number;
  nonSigners: number;
  signedStakePct: number;
  signMs: number;
  tx: EvmTxReport;
  /** Present on the local network, where the certificate is a real Alpenglow one. */
  real?: {
    kind: string;
    signature: string;
    bitmap: string;
    payload: string;
    shredVersion: number;
    validatorSetSync: EvmTxReport | null;
    attest: EvmTxReport;
  };
};

export type NetName = "devnet" | "local";

export type ExecuteResponse = {
  account: string;
  deployedNow: boolean;
  tx: EvmTxReport;
  receiptUnits: string;
};
