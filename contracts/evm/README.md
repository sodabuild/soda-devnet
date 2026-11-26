# EVM contracts

`AlpenglowSim.sol` holds the Alpenglow light client and the SODA account that
the `/alpenglow` page uses. The light client checks an Alpenglow finality
certificate (a BLS12-381 aggregate signature) with the EIP-2537 precompiles.

This folder is a standalone npm package.

## Compile

From the repo root:

```bash
npm run evm:compile
```

The output goes to `contracts/evm/out/AlpenglowSim.json`, which is git-ignored.
`apps/web/scripts/alpenglow-deploy.ts` reads it.

## Regression tests

The tests run against a local Alpenglow node and one destination chain.
`test:negative` and `test:e2e` take Base Sepolia by default, or BNB Smart
Chain testnet with `DEST=bsc-testnet`; the destinations are listed in
`test/dests.mjs`, which reads `ALPENGLOW_BASE_RPC_URL` / `ALPENGLOW_BSC_RPC_URL`
from the shell or the repo-root `.env` and otherwise uses public RPCs.
`test:inclusion-onchain` runs on Base Sepolia only.

1. Start the local node: `npm run alpenglow:node` (from the repo root). It reads its binaries and
   ledger from `.alpenglow-node/` (git-ignored).
2. Build the inclusion tool:
   `cargo build --release --manifest-path crates/shred-inclusion/Cargo.toml`.
3. Put `SEPOLIA_FUNDER_KEY` in the repo-root `.env`. The key pays gas on the
   destination chain, so it needs Base Sepolia ETH or BNB testnet tBNB. Never
   commit it.
4. Run the tests from this folder:

| Command | What it checks |
|---|---|
| `npm run test:negative` | The light client accepts a real certificate and rejects four tampered ones |
| `npm run test:inclusion` | A shred inclusion proof reaches the certified `block_id` |
| `npm run test:inclusion-onchain` | The contract checks that proof on-chain and rejects a tampered one |
| `npm run test:e2e` | Full flow: a Solana approval, a real certificate, then a deposit from the SODA account (Aave V3 on Base Sepolia, Venus on BNB Smart Chain testnet) |

`local-cert.mjs` is a shared helper. It reads the validator set and the
certificates from the node. `LOCAL_RPC` and `LOCAL_GRPC` override the node
addresses. `INCLUSION_TOOL` overrides the path to the inclusion tool.

Results go to `out/`. `test:e2e` deploys on its first run per destination
(`out/local-deployment.<dest>.json`) and reuses the deployment after. Pass
`--redeploy` to deploy again. The web app reads the same addresses from
`apps/web/lib/alpenglow/local-deployment.json`; `node sync-web-deployment.mjs`
copies them there after a deploy.
