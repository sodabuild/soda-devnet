// Server side of the /alpenglow demo. Testnet only.
//
// The EVM sponsor (SEPOLIA_FUNDER_KEY, one key for every destination chain)
// plays two roles here:
//   1. the relayer, which pays gas for the certificate and the action;
//   2. the seed of the SIMULATED validator set (see validators.ts).
// Neither role can move the SODA account's funds: the account only runs an
// action whose approval sits under a certified Solana block.

import fs from "node:fs";
import os from "node:os";
import { Connection, Keypair, PublicKey, Transaction, TransactionInstruction } from "@solana/web3.js";
import {
  createPublicClient,
  createWalletClient,
  encodePacked,
  formatEther,
  http,
  keccak256,
  parseAbi,
  type Hex,
} from "viem";
import { privateKeyToAccount } from "viem/accounts";

import {
  ALPENGLOW,
  DEPOSIT_WEI,
  DESTS,
  MEMO_PROGRAM_ID,
  parseApprovalMemo,
  type AccountState,
  type Approval,
  type DestKey,
  type EvmTxReport,
} from "./shared";
import { dest as destConfig, type DestServer } from "./dest";
import { buildValidatorSet, signCertificate, type ValidatorSet } from "./validators";

// Two Solana networks share this code. "devnet" signs certificates with
// SIMULATED validator keys. "local" is our own Alpenglow node
// (solana-test-validator --alpenglow): its certificates are real and come
// from its block footers.
export type Net = "devnet" | "local";
export const LOCAL_RPC = process.env.ALPENGLOW_LOCAL_RPC_URL || "http://127.0.0.1:8899";
export const DEVNET_RPC = process.env.ALPENGLOW_SOLANA_RPC_URL || "https://api.devnet.solana.com";

/** The light client and factory for one (Solana network, destination chain) pair. */
export function netConfig(net: Net, dest: DestKey) {
  const D = destConfig(dest);
  const dep = net === "local" ? D.local : D.devnet;
  if (!dep) {
    throw new Error(
      net === "local"
        ? `no light client deployed on ${D.meta.name} for the local Alpenglow node yet (run contracts/evm/test/local-flow.mjs with DEST=${dest})`
        : `simulated certificates are only deployed on ${DESTS["base-sepolia"].name}`,
    );
  }
  return { solanaRpc: net === "local" ? LOCAL_RPC : DEVNET_RPC, lightClient: dep.lightClient, factory: dep.factory };
}

export const LC_ABI = parseAbi([
  "struct NonSigner { bytes pk; uint64 stake; bytes32[] proof; }",
  "function submitCertificate(bytes32 blockId, bytes32 approvalsRoot, bytes sig, NonSigner[] nonSigners)",
  "function finalized(bytes32) view returns (bytes32)",
  "function validatorRoot() view returns (bytes32)",
]);
export const FACTORY_ABI = parseAbi([
  "function accountAddress(bytes32 owner, bytes32 path) view returns (address)",
  "function deployAndExecute(bytes32 owner, bytes32 path, address target, uint256 value, bytes data, uint64 nonce, uint64 deadline, bytes32 blockId, bytes32[] proof) returns (address)",
]);
export const ACCOUNT_ABI = parseAbi([
  "function nonce() view returns (uint64)",
  "function execute(address target, uint256 value, bytes data, uint64 nonce, uint64 deadline, bytes32 blockId, bytes32[] proof) returns (bytes)",
]);
const ERC20_ABI = parseAbi(["function balanceOf(address) view returns (uint256)"]);

export const PATH0 = `0x${"00".repeat(32)}` as Hex;
const FUND_WEI = 500_000_000_000_000n; // 0.0005 ETH or BNB, five deposits

function funderKey(): Hex {
  const raw = (process.env.SEPOLIA_FUNDER_KEY ?? "").trim().replace(/^0x/, "");
  if (!/^[0-9a-fA-F]{64}$/.test(raw)) {
    throw new Error("SEPOLIA_FUNDER_KEY is not set: the Alpenglow demo needs it as relayer and validator seed");
  }
  return `0x${raw}`;
}

// One public client and one relayer wallet per destination chain, built on
// first use. The same key relays on every chain; it needs gas on each.
const clients = new Map<DestKey, { pub: ReturnType<typeof createPublicClient>; relayer: ReturnType<typeof createWalletClient> }>();
export function evm(dest: DestKey) {
  let c = clients.get(dest);
  if (!c) {
    const D = destConfig(dest);
    const transport = http(D.rpc);
    c = {
      pub: createPublicClient({ chain: D.chain, transport }),
      relayer: createWalletClient({ account: privateKeyToAccount(funderKey()), chain: D.chain, transport }),
    };
    clients.set(dest, c);
  }
  return c;
}

// Building 1,000 BLS keys takes about 0.3 s, so do it once per process. The
// simulated set is only deployed on Base Sepolia.
let setPromise: Promise<ValidatorSet> | null = null;
export function validatorSet(): Promise<ValidatorSet> {
  setPromise ??= (async () => {
    const set = buildValidatorSet(funderKey());
    const onChain = await evm("base-sepolia").pub.readContract({ address: ALPENGLOW.lightClient, abi: LC_ABI, functionName: "validatorRoot" });
    if (onChain.toLowerCase() !== set.root.toLowerCase()) {
      throw new Error(
        `validator set mismatch: light client has ${onChain}, this server's SEPOLIA_FUNDER_KEY gives ${set.root}. ` +
          "Run scripts/alpenglow-deploy.ts with the same key.",
      );
    }
    return set;
  })().catch((e) => {
    setPromise = null;
    throw e;
  });
  return setPromise;
}

export function ownerHex(owner: string): Hex {
  return `0x${Buffer.from(new PublicKey(owner).toBytes()).toString("hex")}`;
}

/** Calldata of the one demo action on `dest`, for the account that sends it. */
export function depositCalldata(dest: DestKey, account: Hex): Hex {
  return destConfig(dest).action.calldata(account);
}

export function approvalLeaf(a: Approval, owner: Hex): Hex {
  return keccak256(
    encodePacked(
      ["uint256", "address", "bytes32", "address", "uint256", "bytes32", "uint64", "uint64"],
      [BigInt(a.chainId), a.account, owner, a.target, a.value, a.dataHash, a.nonce, a.deadline],
    ),
  );
}

export async function accountState(owner: string, net: Net, dest: DestKey): Promise<AccountState> {
  const cfg = netConfig(net, dest);
  const D = destConfig(dest);
  const { pub } = evm(dest);
  const oh = ownerHex(owner);
  const account = await pub.readContract({
    address: cfg.factory,
    abi: FACTORY_ABI,
    functionName: "accountAddress",
    args: [oh, PATH0],
  });
  const [code, balance, receipt] = await Promise.all([
    pub.getCode({ address: account }),
    pub.getBalance({ address: account }),
    pub.readContract({ address: D.action.receiptToken, abi: ERC20_ABI, functionName: "balanceOf", args: [account] }),
  ]);
  const deployed = !!code && code !== "0x";
  const nonce = deployed
    ? await pub.readContract({ address: account, abi: ACCOUNT_ABI, functionName: "nonce" })
    : 0n;
  return {
    owner,
    ownerHex: oh,
    account,
    deployed,
    nonce: nonce.toString(),
    balanceWei: balance.toString(),
    receiptUnits: receipt.toString(),
    lightClient: cfg.lightClient,
    factory: cfg.factory,
    dest,
  };
}

/** Sends one transaction from the relayer on `dest` and measures it. */
export async function sendAndMeasure(dest: DestKey, send: () => Promise<Hex>): Promise<EvmTxReport> {
  const { pub } = evm(dest);
  const t0 = performance.now();
  const hash = await send();
  const r = await pub.waitForTransactionReceipt({ hash, pollingInterval: 250 });
  const ms = Math.round(performance.now() - t0);
  if (r.status !== "success") throw new Error(`${DESTS[dest].name} tx reverted: ${hash}`);
  const tx = await pub.getTransaction({ hash });
  // OP-stack chains add an L1 data fee; others do not have the field.
  const l1Fee = (r as unknown as { l1Fee?: bigint }).l1Fee ?? 0n;
  return {
    hash,
    gasUsed: Number(r.gasUsed),
    feeWei: (r.gasUsed * r.effectiveGasPrice + l1Fee).toString(),
    calldataBytes: (tx.input.length - 2) / 2,
    ms,
  };
}

export async function fundIfNeeded(dest: DestKey, account: Hex, balance: bigint): Promise<EvmTxReport | undefined> {
  if (balance >= DEPOSIT_WEI) return undefined;
  const { pub, relayer } = evm(dest);
  const have = await pub.getBalance({ address: relayer.account!.address });
  if (have < FUND_WEI * 2n) {
    throw new Error(`relayer ${relayer.account!.address} is low on ${DESTS[dest].name}: ${formatEther(have)} ${DESTS[dest].native}`);
  }
  return sendAndMeasure(dest, () => relayer.sendTransaction({ to: account, value: FUND_WEI, chain: destConfig(dest).chain, account: relayer.account! }));
}

/**
 * Reads a FINALIZED Solana transaction and returns the approval it carries.
 * Checks that the memo is the one demo action and that the owner signed it.
 * In a real light client this check is a proof against the certified block;
 * here the server reads the block from an RPC (see "What is simulated").
 */
const approvals = new Map<string, Promise<Awaited<ReturnType<typeof readApprovalUncached>>>>();
export function readApproval(signature: string, net: Net, dest: DestKey) {
  // certify and execute both need it; read the chain once per signature.
  const key = `${net}:${dest}:${signature}`;
  let p = approvals.get(key);
  if (!p) {
    p = readApprovalUncached(signature, net, dest);
    approvals.set(key, p);
    p.catch(() => approvals.delete(key));
    if (approvals.size > 200) approvals.delete(approvals.keys().next().value!);
  }
  return p;
}

async function readApprovalUncached(signature: string, net: Net, dest: DestKey) {
  const D: DestServer = destConfig(dest);
  const conn = new Connection(netConfig(net, dest).solanaRpc, "finalized");
  let tx = null;
  for (let i = 0; i < 20 && !tx; i++) {
    tx = await conn.getTransaction(signature, { commitment: "finalized", maxSupportedTransactionVersion: 0 });
    if (!tx) await new Promise((r) => setTimeout(r, 250));
  }
  if (!tx) throw new Error(`approval transaction is not finalized on ${net === "local" ? "the local Alpenglow network" : "Solana devnet"} yet`);
  if (tx.meta?.err) throw new Error("approval transaction failed on Solana");

  const msg = tx.transaction.message;
  const keys = msg.staticAccountKeys;
  const memoIx = msg.compiledInstructions.find((ix) => keys[ix.programIdIndex].toBase58() === MEMO_PROGRAM_ID);
  if (!memoIx) throw new Error("no memo instruction in the approval transaction");
  const memo = Buffer.from(memoIx.data).toString("utf8");
  const approval = parseApprovalMemo(memo);
  if (!approval) throw new Error("memo is not a SODA Alpenglow approval");

  // The memo program fails the transaction unless every account it lists
  // signed, so a listed signer is a signature from that key.
  const signers = memoIx.accountKeyIndexes.filter((i) => msg.isAccountSigner(i)).map((i) => keys[i].toBase58());
  if (signers.length !== 1) throw new Error("approval must name exactly one owner");
  const owner = signers[0];

  const [block, state] = await Promise.all([
    conn.getBlock(tx.slot, {
      commitment: "finalized",
      maxSupportedTransactionVersion: 0,
      transactionDetails: "none",
      rewards: false,
    }),
    accountState(owner, net, dest),
  ]);
  if (!block) throw new Error(`block ${tx.slot} not available`);

  // Refuse anything except the demo action for this owner's account on this chain.
  if (approval.chainId !== D.meta.chainId) throw new Error(`approval is for chain ${approval.chainId}, not ${D.meta.name}`);
  if (approval.account.toLowerCase() !== state.account.toLowerCase()) throw new Error("approval is for another account");
  if (approval.target.toLowerCase() !== D.action.target.toLowerCase()) throw new Error(`only the ${D.meta.protocol} deposit is allowed`);
  if (approval.value !== DEPOSIT_WEI) throw new Error(`only a 0.0001 ${D.meta.native} deposit is allowed`);
  const data = D.action.calldata(state.account);
  if (approval.dataHash !== keccak256(data)) throw new Error("approval data does not match the deposit");

  return {
    approval,
    owner,
    ownerHex: state.ownerHex,
    state,
    data,
    slot: tx.slot,
    blockhash: block.blockhash,
    blockId: `0x${Buffer.from(new PublicKey(block.blockhash).toBytes()).toString("hex")}` as Hex,
  };
}

/** Devnet path: a SIMULATED certificate, checked by SolanaLightClient on Base Sepolia. */
export async function certify(signature: string, nonSignerCount: number, dest: DestKey) {
  const a = await readApproval(signature, "devnet", dest);
  const cfg = netConfig("devnet", dest);
  const set = await validatorSet();
  // This block carries one SODA approval, so its root is that leaf.
  const approvalsRoot = approvalLeaf(a.approval, a.ownerHex);
  const t0 = performance.now();
  const cert = signCertificate(set, a.blockId, approvalsRoot, nonSignerCount);
  const signMs = Math.round(performance.now() - t0);
  const { relayer } = evm(dest);
  const tx = await sendAndMeasure(dest, () =>
    relayer.writeContract({
      address: cfg.lightClient,
      abi: LC_ABI,
      functionName: "submitCertificate",
      args: [a.blockId, approvalsRoot, cert.sig, cert.nonSigners],
      chain: destConfig(dest).chain,
      account: relayer.account!,
    }),
  );
  return {
    slot: a.slot,
    blockhash: a.blockhash,
    blockId: a.blockId,
    approvalsRoot,
    validators: set.vals.length,
    nonSigners: nonSignerCount,
    signedStakePct: cert.signedStakePct,
    signMs,
    tx,
  };
}

export async function execute(signature: string, net: Net, dest: DestKey) {
  const cfg = netConfig(net, dest);
  const D = destConfig(dest);
  const { pub, relayer } = evm(dest);
  const a = await readApproval(signature, net, dest);
  // Devnet names a block by its blockhash; the local light client names it by
  // the real Alpenglow block_id from the certificate.
  const blockId = net === "local" ? localBlockIds.get(`${dest}:${signature}`) : a.blockId;
  if (!blockId) throw new Error("certify this approval first");
  // Retry: a public RPC is load balanced and can answer from a node that
  // has not seen the certificate's block yet.
  let certified: Hex = "0x";
  for (let i = 0; i < 20; i++) {
    certified = await pub.readContract({
      address: cfg.lightClient,
      abi: LC_ABI,
      functionName: "finalized",
      args: [blockId],
    });
    if (!/^0x0+$/.test(certified)) break;
    await new Promise((r) => setTimeout(r, 250));
  }
  if (/^0x0+$/.test(certified)) throw new Error(`this Solana block has no certificate on ${D.meta.name} yet`);
  const { approval: p } = a;
  const tx = await sendAndMeasure(dest, () =>
    a.state.deployed
      ? relayer.writeContract({
          address: a.state.account,
          abi: ACCOUNT_ABI,
          functionName: "execute",
          args: [p.target, p.value, a.data, p.nonce, p.deadline, blockId, []],
          chain: D.chain,
          account: relayer.account!,
        })
      : relayer.writeContract({
          address: cfg.factory,
          abi: FACTORY_ABI,
          functionName: "deployAndExecute",
          args: [a.ownerHex, PATH0, p.target, p.value, a.data, p.nonce, p.deadline, blockId, []],
          chain: D.chain,
          account: relayer.account!,
        }),
  );
  // A public RPC can answer from a node one block behind; wait until it
  // shows the new nonce before reporting balances.
  let after = await accountState(a.owner, net, dest);
  for (let i = 0; i < 12 && BigInt(after.nonce) <= p.nonce; i++) {
    await new Promise((r) => setTimeout(r, 250));
    after = await accountState(a.owner, net, dest);
  }
  return { account: a.state.account, deployedNow: !a.state.deployed, tx, receiptUnits: after.receiptUnits };
}

// Optional: a Solana key the server signs approvals with, so the demo still
// runs if Phantom is on another network. ALPENGLOW_DEVNET_KEY_JSON (a JSON
// byte array) first; on a laptop, the Solana CLI wallet.
export function demoOwner(): Keypair | null {
  const raw = process.env.ALPENGLOW_DEVNET_KEY_JSON;
  try {
    if (raw) return Keypair.fromSecretKey(Uint8Array.from(JSON.parse(raw)));
    const p = `${os.homedir()}/.config/solana/id.json`;
    if (fs.existsSync(p)) return Keypair.fromSecretKey(Uint8Array.from(JSON.parse(fs.readFileSync(p, "utf8"))));
  } catch {
    return null;
  }
  return null;
}

export function memoInstruction(memo: string, owner: PublicKey) {
  return new TransactionInstruction({
    programId: new PublicKey(MEMO_PROGRAM_ID),
    keys: [{ pubkey: owner, isSigner: true, isWritable: false }],
    data: Buffer.from(memo, "utf8"),
  });
}

export async function demoSign(memo: string, net: Net) {
  const kp = demoOwner();
  if (!kp) throw new Error("no demo owner key on this server");
  if (!parseApprovalMemo(memo)) throw new Error("memo is not a SODA Alpenglow approval");
  const conn = new Connection(net === "local" ? LOCAL_RPC : DEVNET_RPC, "confirmed");
  const { blockhash, lastValidBlockHeight } = await conn.getLatestBlockhash("confirmed");
  const tx = new Transaction({ feePayer: kp.publicKey, blockhash, lastValidBlockHeight }).add(
    memoInstruction(memo, kp.publicKey),
  );
  tx.sign(kp);
  return { tx: tx.serialize().toString("base64"), lastValidBlockHeight };
}

/** block_id from the real certificate, keyed `${dest}:${approval signature}` (set by certifyLocal). */
export const localBlockIds: Map<string, Hex> =
  ((globalThis as Record<string, unknown>).__agLocalBlockIds as Map<string, Hex>) ??
  ((globalThis as Record<string, unknown>).__agLocalBlockIds = new Map<string, Hex>());
