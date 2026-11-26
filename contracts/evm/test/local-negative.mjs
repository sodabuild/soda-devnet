// Takes one REAL certificate from our local Alpenglow node and asks the
// destination chain's light client (eth_call, no gas) to accept it unchanged
// and with one field changed at a time. Only the unchanged one may pass.
//
// Usage: node local-negative.mjs                   Base Sepolia
//        DEST=bsc-testnet node local-negative.mjs  BNB Smart Chain testnet
import fs from 'node:fs'
import { bls12_381 as bls } from '@noble/curves/bls12-381.js'
import { createPublicClient, http } from 'viem'
import { privateKeyToAccount } from 'viem/accounts'
import { readValidatorSet, collectFooterCerts } from './local-cert.mjs'
import { dest } from './dests.mjs'

const D = dest()
const C = JSON.parse(fs.readFileSync(new URL('../out/AlpenglowSim.json', import.meta.url), 'utf8')).AlpenglowLightClient
const dep = JSON.parse(fs.readFileSync(new URL(`../out/local-deployment.${D.key}.json`, import.meta.url), 'utf8'))
const env = fs.readFileSync(new URL('../../../.env', import.meta.url), 'utf8')
const relayer = privateKeyToAccount(`0x${env.match(/^SEPOLIA_FUNDER_KEY=(.*)$/m)[1].trim().replace(/^0x/, '')}`).address
const pub = createPublicClient({ chain: D.chain, transport: http(D.rpc) })
const fp = (x) => x.toString(16).padStart(128, '0')
const g2 = (b) => { const a = bls.G2.Point.fromBytes(b).toAffine(); return `0x${fp(a.x.c0)}${fp(a.x.c1)}${fp(a.y.c0)}${fp(a.y.c1)}` }
const hx = (b) => `0x${Buffer.from(b).toString('hex')}`

console.log(`${D.name}: light client ${dep.lightClient}`)
await readValidatorSet()
const certs = await collectFooterCerts(3000)
const [slot, c] = [...certs.entries()].at(-1)
const blockId = hx(c.final_aggregate.block_id)
const sig = g2(c.final_aggregate.signature)
const bm = hx(c.final_aggregate.signer_bitmap)
const otherSig = g2([...certs.values()].at(-2).final_aggregate.signature)

const cases = [
  ['real certificate, unchanged', [BigInt(slot), blockId, sig, bm, '0x', '0x'], true],
  ['slot + 1', [BigInt(slot + 1), blockId, sig, bm, '0x', '0x'], false],
  ['block_id changed', [BigInt(slot), `0x${'11'.repeat(32)}`, sig, bm, '0x', '0x'], false],
  ['signature from another block', [BigInt(slot), blockId, otherSig, bm, '0x', '0x'], false],
  ['bitmap: nobody signed', [BigInt(slot), blockId, sig, '0x00010000', '0x', '0x'], false],
]
let failures = 0
for (const [name, args, shouldPass] of cases) {
  let accepted = false
  let why = ''
  try {
    await pub.simulateContract({ address: dep.lightClient, abi: C.abi, functionName: 'submitFinalCert', args, account: relayer })
    accepted = true
  } catch (e) {
    why = e.shortMessage?.split('\n').find((l) => l.includes('reverted')) ?? e.shortMessage ?? e.message
  }
  const ok = accepted === shouldPass
  if (!ok) failures++
  console.log(`${name.padEnd(32)} ${accepted ? 'ACCEPTED' : `rejected: ${why}`}${ok ? '' : '   <-- WRONG'}`)
}
console.log(failures ? `${failures} case(s) behaved wrongly` : 'all cases behaved as expected')
process.exit(failures ? 1 : 0)
