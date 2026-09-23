function abortError() {
  const error = new Error('The data session is no longer active.')
  error.name = 'AbortError'
  return error
}

// Only wrap data traffic. Auth dispatch must remain outside this boundary.
export function createSessionTransport(fetchImpl = globalThis.fetch) {
  let generation = 0
  let controller = null

  function invalidate() {
    const previous = controller
    controller = null
    generation++
    previous?.abort()
  }

  function activate() {
    invalidate()
    controller = new AbortController()
  }

  async function fetch(input, init = {}) {
    if (!controller) throw abortError()
    init ??= {}
    const current = generation
    const callerSignal = init.signal === undefined ? input?.signal : init.signal
    if (callerSignal?.aborted) throw abortError()
    // Signal composition requires Safari 17.4+ or equivalent support; never drop either signal.
    if (callerSignal && typeof globalThis.AbortSignal?.any !== 'function') {
      const error = new Error('This browser needs AbortSignal.any() to combine request and session cancellation.')
      error.name = 'NotSupportedError'
      throw error
    }
    const signal = callerSignal
      ? AbortSignal.any([controller.signal, callerSignal])
      : controller.signal
    if (signal.aborted) throw abortError()

    let onAbort
    const aborted = new Promise((resolve, reject) => {
      onAbort = () => reject(abortError())
      signal.addEventListener('abort', onAbort, { once: true })
    })
    try {
      // Capture synchronous failures too, so the abort promise always has a handler.
      const request = new Promise(resolve => resolve(fetchImpl(input, { ...init, signal })))
      const response = await Promise.race([request, aborted])
      if (current !== generation || signal.aborted) throw abortError()
      return response
    } catch (error) {
      if (current !== generation || signal.aborted) throw abortError()
      throw error
    } finally {
      signal.removeEventListener('abort', onAbort)
    }
  }

  return { fetch, activate, invalidate }
}
