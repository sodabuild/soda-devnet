# SODA × Alpenglow prototype

SODA lets a Solana account act on other chains. This prototype removes the
signing committee from that path. The destination chain checks Solana's own
finality instead:

1. The owner approves an action in a Memo transaction on Solana.
2. A relayer posts the finality certificate for that block to a light client
   on the destination chain (Base Sepolia or BNB Smart Chain testnet). The
   light client checks the BLS12-381 aggregate signature and the stake rule
   with the EIP-2537 precompiles.
3. The owner's SODA smart account checks that its approval is in the
   certified block, then makes a real deposit: Aave V3 on Base Sepolia, Venus
   on BNB Smart Chain testnet.

Testnet only. Not audited.

## Two networks

| Network | Solana side | Certificate |
|---|---|---|
| `local` | Our own node: `solana-test-validator --alpenglow` (Agave 4.3.2) with the Yellowstone gRPC plugin | **Real.** Read from the node's block footers |
| `devnet` | Solana devnet | **Simulated.** No provider streams devnet certificates yet, so a simulated validator set signs it |

What is not proved yet, and is done by named roles on the light client: the
admin loads the validator set, and the attester posts the approvals root.
`ShredInclusion` and `crates/shred-inclusion` are the first step toward
proving approval inclusion instead (transaction → shreds → the `block_id` the
certificate signs).

## Layout

```
apps/web/                 Next.js app, the /alpenglow page and /api/alpenglow/*
  lib/alpenglow/          server logic, validator set, destination chains, deployments
  scripts/                alpenglow-deploy.ts (one-time deploy for the devnet mode)
contracts/evm/            AlpenglowSim.sol: light clients, SODA account + factory, ShredInclusion
  test/                   regression tests against a local Alpenglow node
crates/shred-inclusion/   Rust tool that builds shred inclusion proofs from the node's ledger
scripts/                  alpenglow-local-node.sh (starts the local Alpenglow node)
```

## Run the web app

```bash
cp apps/web/.env.example apps/web/.env    # set SEPOLIA_FUNDER_KEY (testnet key)
cd apps/web && npm install && npm run dev
# http://localhost:3000 → /alpenglow
```

`SEPOLIA_FUNDER_KEY` pays gas on the destination chain, so it needs Base
Sepolia ETH or BNB testnet tBNB. Pick the destination with the toggle or
`?dest=base-sepolia` / `?dest=bsc-testnet`.

The `local` network also needs the local node running (below) and contracts
deployed by `test:e2e`; `node contracts/evm/sync-web-deployment.mjs` copies
those addresses into `apps/web/lib/alpenglow/local-deployment.json`.

## Contracts and tests

```bash
cp .env.example .env                      # set SEPOLIA_FUNDER_KEY
cd contracts/evm && npm install && npm run compile
```

See [contracts/evm/README.md](contracts/evm/README.md) for the local node,
the inclusion tool and the four regression tests.
