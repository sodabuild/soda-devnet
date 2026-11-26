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

The demo action is a 0.0001 ETH supply into Aave V3 on Base Sepolia, which
returns aWETH to the SODA account. Testnet only. Not audited.

## What is real and what is trusted

| Piece | Status |
|---|---|
| Finality certificate | **Real** Alpenglow certificate, read from the block footers of our own node. The node is a one-validator local cluster, so the signer holds 100% of the stake |
| Certificate check on Base Sepolia | **Real**: bitmap, stake rule and BLS pairing, on-chain |
| Approval is in the certified block | **Trusted**: the attester key posts the approvals root. `ShredInclusion` and `crates/shred-inclusion` are the first step toward proving it (transaction → shreds → the `block_id` the certificate signs) |
| Validator set on the light client | **Trusted**: the admin key loads it from the node |
| Aave deposit | **Real**, on Base Sepolia |

The code also has a `devnet` mode (Solana devnet with a simulated validator
set signing the certificate, because no provider streams devnet certificates
yet). The page currently runs the `local` mode only.

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

## Setup (once)

### Requirements

- macOS on Apple silicon (the node script loads the Yellowstone plugin as a `.dylib`)
- Node.js 20 or newer
- Rust, only to build the Yellowstone plugin and the optional inclusion tool
- [Phantom](https://phantom.com) in the browser
- A Solana keypair at `~/.config/solana/id.json` (`solana-keygen new`). The tests
  sign approvals with it, and the page's `?demo` backup uses it
- An EVM testnet key with Base Sepolia ETH (0.05 ETH covers deploys and many runs)

### 1. Local Alpenglow node

The node lives in `.alpenglow-node/` (git-ignored; set `ALPENGLOW_NODE_DIR` to
use another folder):

```
.alpenglow-node/
  agave-4.3.2/bin/solana-test-validator
  libyellowstone_grpc_geyser.dylib
  ledger/                                  created on first start
```

- **Agave 4.3.2**: download `solana-release-aarch64-apple-darwin.tar.bz2` from
  the [v4.3.2 release](https://github.com/anza-xyz/agave/releases/tag/v4.3.2)
  and unpack it as `.alpenglow-node/agave-4.3.2/`. It needs `brew install libusb`.
- **Yellowstone gRPC plugin v16.1.5**:
  ```bash
  git clone --branch "v16.1.5+solana.4.3.2" https://github.com/rpcpool/yellowstone-grpc .alpenglow-node/yellowstone-src
  cd .alpenglow-node/yellowstone-src && cargo build --release -p yellowstone-grpc-geyser
  cp target/release/libyellowstone_grpc_geyser.dylib ..
  ```

Start it once to create the ledger, and leave it running for step 3:

```bash
npm run alpenglow:node            # RPC on 127.0.0.1:8899, gRPC on 127.0.0.1:10000
```

### 2. Keys

```bash
cp .env.example .env                       # used by contracts/evm/test
cp apps/web/.env.example apps/web/.env     # used by the web app
```

Set `SEPOLIA_FUNDER_KEY` to the **same** EVM key in both files. It is the
relayer (pays gas), and the admin and attester of the light client you deploy
next. Never commit either file.

### 3. Deploy the light client and run the end-to-end test

With the node running:

```bash
cd contracts/evm
npm install
npm run compile
npm run test:e2e                 # deploys on the first run, then does one full deposit
node sync-web-deployment.mjs     # copies the new addresses into apps/web/lib/alpenglow/local-deployment.json
```

A passing `test:e2e` prints the Base Sepolia transactions and an aWETH balance
for the SODA account. The committed `local-deployment.json` points at contracts
whose admin is the original author's key, so this step is required with your
own key.

### 4. Web app dependencies

```bash
cd apps/web && npm install
```

## Run the demo

Everything runs on one machine: the browser talks to the node at
`127.0.0.1:8899`, and the server needs internet for Base Sepolia.

1. **Node** (terminal 1, repo root): `npm run alpenglow:node`. Do not pass
   `--reset` before a demo; it starts a new chain with new validator keys.
2. **Web app** (terminal 2): `cd apps/web && npm run dev`. Start it from
   `apps/web`, because the server loads its gRPC proto files relative to that
   folder. Use `npm run dev -- -p 3001` if port 3000 is taken.
3. **Phantom**: Settings → Developer settings → Testnet mode → **Solana Localnet**.
4. Open <http://localhost:3000> (it redirects to `/alpenglow`), connect Phantom.
   The page airdrops local SOL to the wallet for the fee.
5. Click **Deposit 0.0001 ETH** and approve in Phantom. The page walks through:
   approval on Solana → real finality certificate → light client on Base
   Sepolia → the SODA account supplies 0.0001 ETH to Aave → aWETH balance.

The first run funds the SODA account with 0.0005 ETH from the relayer (enough
for five deposits) and deploys the account. Each run then costs the relayer a
few transactions of Base Sepolia gas.

**Backup signer.** If Phantom misbehaves, open
<http://localhost:3000/alpenglow?demo>. The server signs the approval with
`~/.config/solana/id.json` (or `ALPENGLOW_DEVNET_KEY_JSON`) instead.

**BNB Smart Chain testnet** works the same way with `?dest=bsc-testnet`, after
`DEST=bsc-testnet npm run test:e2e` and `node sync-web-deployment.mjs` have
deployed there and the relayer holds tBNB.

### Troubleshooting

| Error | Fix |
|---|---|
| `SEPOLIA_FUNDER_KEY is not set` | Add it to `apps/web/.env` and restart the dev server |
| "Local Alpenglow node not reachable" and the button stays grey | The node is not running, or not on `127.0.0.1:8899` |
| `no finality certificate seen for slot …` | The Yellowstone plugin is not streaming on `127.0.0.1:10000`. Check the node's output for plugin errors |
| `no light client deployed on … yet` | Run step 3 for that destination |
| `relayer … is low` | Send Base Sepolia ETH (or tBNB) to the relayer address in the message |
| Node was reset | `npm run test:e2e` redeploys automatically on a new shred version; then run `node sync-web-deployment.mjs` again |

## Regression tests

See [contracts/evm/README.md](contracts/evm/README.md) for the four tests
(certificate checks, tampered certificates, shred inclusion off-chain and
on-chain) and the inclusion tool.
