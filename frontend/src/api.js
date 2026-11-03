// Every request to the backend (server: backend/, proxied by vite.config.js) goes through here, so the
// "check the status, parse the JSON, make a readable error" step lives in one place.
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
