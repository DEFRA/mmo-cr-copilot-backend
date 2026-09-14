import { ProxyAgent } from 'undici'

import { config } from '#/config.js'

/**
 * Returns an undici dispatcher routing requests through the CDP outbound proxy,
 * or undefined when no proxy is configured (local development and tests).
 * Platform egress is only permitted via the proxy, so anything calling a third
 * party API must opt in to this dispatcher.
 */
export function createProxyDispatcher(proxyUrl = config.get('httpProxy')) {
  return proxyUrl ? new ProxyAgent(proxyUrl) : undefined
}
