import { ProxyAgent } from 'undici'

import { createProxyDispatcher } from './proxy.js'

describe('#createProxyDispatcher', () => {
  test('Should return a proxy agent when a proxy is configured', () => {
    const dispatcher = createProxyDispatcher('http://localhost:3128')

    expect(dispatcher).toBeInstanceOf(ProxyAgent)
  })

  test('Should return undefined when there is no proxy', () => {
    expect(createProxyDispatcher(null)).toBeUndefined()
  })

  test('Should default to the configured proxy, which is unset locally', () => {
    expect(createProxyDispatcher()).toBeUndefined()
  })
})
