// All backend requests: check status, parse JSON, readable errors
export async function request(url, options) {
  const res = await fetch(url, options)
  if (!res.ok) {
    const err = new Error(`server error ${res.status}`)
    err.status = res.status
    throw err
  }
  return res.status === 204 ? null : res.json()
}

export const getJson = (url) => request(url)

// DELETE that also counts "already gone" (404) as done.
export const remove = (url) => request(url, { method: 'DELETE' }).catch((e) => { if (e.status !== 404) throw e })

// Console line of a photo request's time: client stages, server steps, network
export function timing(client, server, requestMs) {
  const ms = (v) => `${Math.round(v)}ms`
  const serverMs = Object.values(server).reduce((a, b) => a + b, 0) * 1000
  const clientMs = Object.values(client).reduce((a, b) => a + b, 0)
  return [...Object.entries(client).map(([k, v]) => `${k} ${ms(v)}`),
    `| request ${ms(requestMs)} = server ${ms(serverMs)} [${Object.entries(server).map(([k, v]) => `${k} ${ms(v * 1000)}`).join(' ')}]`,
    `+ network ${ms(requestMs - serverMs)} | total ${ms(clientMs + requestMs)}`].join(' ')
}

// Read-aloud clip URL for `text` in a Gemini voice (cached on the server)
export const ttsUrl = (text, voice) => `/tts?${new URLSearchParams({ text, voice })}`
