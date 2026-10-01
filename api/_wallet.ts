// The pool wallet, VALUED never touched: a public address's ETH
// balance (Alchemy) times the ETH price (CoinGecko). Shared by the
// Prizes read and the season-end snapshot so both see the same number.
export interface WalletValue {
  address: string
  ethBalance: number | null
  ethPrice: number | null
  usdValue: number | null
  lastUpdated: string | null
  error: string | null
}

export async function valueWallet(address: string): Promise<WalletValue> {
  const out: WalletValue = {
    address,
    ethBalance: null,
    ethPrice: null,
    usdValue: null,
    lastUpdated: null,
    error: null,
  }
  // Server-side name first; the VITE_ spelling is accepted so a key
  // entered under the browser prefix still works, but the key never
  // belongs in client code.
  const key = process.env.ALCHEMY_API_KEY ?? process.env.VITE_ALCHEMY_API_KEY
  if (!key) {
    out.error = 'ALCHEMY_API_KEY is not set on this project yet.'
    return out
  }
  try {
    const bal = (await (
      await fetch(`https://eth-mainnet.g.alchemy.com/v2/${key}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          jsonrpc: '2.0',
          id: 1,
          method: 'eth_getBalance',
          params: [address, 'latest'],
        }),
      })
    ).json()) as { result?: string; error?: { message: string } }
    if (bal.error || !bal.result) throw new Error(bal.error?.message ?? 'no balance result')
    out.ethBalance = parseInt(bal.result, 16) / 1e18

    const price = (await (
      await fetch('https://api.coingecko.com/api/v3/simple/price?ids=ethereum&vs_currencies=usd')
    ).json()) as { ethereum?: { usd?: number } }
    if (!price.ethereum?.usd) throw new Error('no ETH price')
    out.ethPrice = price.ethereum.usd
    out.usdValue = out.ethBalance * out.ethPrice
    out.lastUpdated = new Date().toISOString()
  } catch (e) {
    out.error = e instanceof Error ? e.message : 'wallet lookup failed'
  }
  return out
}
