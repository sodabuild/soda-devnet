// Copies the light client and factory addresses that test/local-flow.mjs
// deployed (out/local-deployment.<dest>.json) into the web app's
// apps/web/lib/alpenglow/local-deployment.json, so the /alpenglow page uses
// the same contracts as the tests.
//
// Usage: node sync-web-deployment.mjs [dest ...]     default: every deployed destination
import fs from 'node:fs'

const WEB = new URL('../../apps/web/lib/alpenglow/local-deployment.json', import.meta.url)
const web = JSON.parse(fs.readFileSync(WEB, 'utf8'))
const keys = process.argv.slice(2).length ? process.argv.slice(2) : Object.keys(web)
for (const key of keys) {
  const file = new URL(`./out/local-deployment.${key}.json`, import.meta.url)
  if (!fs.existsSync(file)) {
    console.log(`${key}: no out/local-deployment.${key}.json, left as is`)
    continue
  }
  const { lightClient, factory, chainId } = JSON.parse(fs.readFileSync(file, 'utf8'))
  web[key] = { lightClient, factory }
  console.log(`${key} (chain ${chainId}): light client ${lightClient}, factory ${factory}`)
}
fs.writeFileSync(WEB, JSON.stringify(web, null, 2) + '\n')
console.log(`wrote ${WEB.pathname}`)
