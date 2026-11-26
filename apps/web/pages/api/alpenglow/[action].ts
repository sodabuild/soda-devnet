// API for the /alpenglow page. Testnet only.
//
//   GET  state?owner=<base58>        the owner's SODA account on the destination chain
//   GET  demo-owner                  the server's demo key, if any
//   POST prepare     { owner }       fund the account, return the memo to sign
//   POST demo-sign   { memo }        sign the memo with the demo key
//   POST certify     { signature, nonSigners }   certificate -> light client
//   POST execute     { signature }   the account runs the approved deposit
//   GET  local-status                our local Alpenglow node and its footer stream
//
// Every route takes net=devnet (simulated certificate) or net=local (our own
// Alpenglow node; real certificate from its block footer), and
// dest=base-sepolia (default) or dest=bsc-testnet for the destination chain.

import type { NextApiRequest, NextApiResponse } from "next";
import { keccak256 } from "viem";

import { approvalMemo, DEFAULT_DEST, DEPOSIT_WEI, DEST_KEYS, DESTS, NON_SIGNER_CHOICES, parseDest, type PrepareResponse } from "@/lib/alpenglow/shared";
import { dest as destConfig } from "@/lib/alpenglow/dest";
import {
  accountState,
  certify,
  demoOwner,
  demoSign,
  depositCalldata,
  execute,
  fundIfNeeded,
  type Net,
} from "@/lib/alpenglow/server";
import { certifyLocal, localStatus } from "@/lib/alpenglow/local";

export const config = { maxDuration: 120 };

const json = (v: unknown) => JSON.parse(JSON.stringify(v, (_k, x) => (typeof x === "bigint" ? x.toString() : x)));

export default async function handler(req: NextApiRequest, res: NextApiResponse) {
  const action = String(req.query.action);
  const body = (req.body ?? {}) as Record<string, unknown>;
  const net: Net = (req.query.net ?? body.net) === "local" ? "local" : "devnet";
  // A missing dest means the default; a wrong one is an error, never a silent
  // fallback that would relay on another chain than the caller asked for.
  const rawDest = req.query.dest ?? body.dest;
  const dest = rawDest == null || rawDest === "" ? DEFAULT_DEST : parseDest(rawDest);
  if (!dest) return res.status(400).json({ error: `dest must be one of ${DEST_KEYS.join(", ")}` });
  try {
    if (req.method === "GET" && action === "state") {
      return res.status(200).json(await accountState(String(req.query.owner), net, dest));
    }
    if (req.method === "GET" && action === "local-status") {
      return res.status(200).json(await localStatus());
    }
    if (req.method === "GET" && action === "demo-owner") {
      return res.status(200).json({ owner: demoOwner()?.publicKey.toBase58() ?? null });
    }
    if (req.method !== "POST") return res.status(405).json({ error: "method not allowed" });

    if (action === "prepare") {
      const state = await accountState(String(body.owner), net, dest);
      const funding = await fundIfNeeded(dest, state.account, BigInt(state.balanceWei));
      const fresh = funding ? await accountState(String(body.owner), net, dest) : state;
      const memo = approvalMemo(
        {
          chainId: DESTS[dest].chainId,
          account: fresh.account,
          target: destConfig(dest).action.target,
          value: DEPOSIT_WEI,
          dataHash: keccak256(depositCalldata(dest, fresh.account)),
          nonce: BigInt(fresh.nonce),
          deadline: BigInt(Math.floor(Date.now() / 1000) + 600),
        },
        DESTS[dest].memoAction,
      );
      const out: PrepareResponse = { ...fresh, memo, funding };
      return res.status(200).json(out);
    }
    if (action === "demo-sign") {
      return res.status(200).json(await demoSign(String(body.memo), net));
    }
    if (action === "certify" && net === "local") {
      return res.status(200).json(json(await certifyLocal(String(body.signature), dest)));
    }
    if (action === "certify") {
      const n = Number(body.nonSigners ?? 0);
      if (!(NON_SIGNER_CHOICES as readonly number[]).includes(n)) {
        return res.status(400).json({ error: `nonSigners must be one of ${NON_SIGNER_CHOICES.join(", ")}` });
      }
      return res.status(200).json(json(await certify(String(body.signature), n, dest)));
    }
    if (action === "execute") {
      return res.status(200).json(json(await execute(String(body.signature), net, dest)));
    }
    return res.status(404).json({ error: `unknown action ${action}` });
  } catch (e) {
    const err = e as Error & { shortMessage?: string };
    return res.status(500).json({ error: err.shortMessage ?? err.message });
  }
}
