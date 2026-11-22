const MAX_BYTES = 32 * 1024 * 1024
const MAX_FILES = 48
const KEEP_MS = 5 * 60_000

interface ImageEntry {
  room: string
  url: Promise<string>
  users: number
  objectUrl?: string
  bytes: number
  decoded?: boolean
  expiry?: ReturnType<typeof setTimeout>
}

/** Share current downloads and keep only a bounded set of warmed, unused object URLs. */
export function createDotImageCache({
  maxBytes = MAX_BYTES,
  maxFiles = MAX_FILES,
  keepMs = KEEP_MS,
  urls = URL as Pick<typeof URL, 'createObjectURL' | 'revokeObjectURL'>,
} = {}) {
  const images = new Map<string, ImageEntry>()
  const idFor = (room: string, file: string): string => JSON.stringify([room, file])
  function remove(id: string, entry: ImageEntry): void {
    if (images.get(id) !== entry) return
    images.delete(id)
    if (entry.expiry !== undefined) clearTimeout(entry.expiry)
    if (entry.objectUrl) urls.revokeObjectURL(entry.objectUrl)
  }
  function trim(): void {
    let count = 0
    let bytes = 0
    for (const entry of images.values()) {
      if (entry.users || !entry.objectUrl) continue
      count++
      bytes += entry.bytes
    }
    for (const [id, entry] of images) {
      if (count <= maxFiles && bytes <= maxBytes) break
      if (entry.users || !entry.objectUrl) continue
      count--
      bytes -= entry.bytes
      remove(id, entry)
    }
  }
  return {
    peek(room: string, file: string) {
      const entry = images.get(idFor(room, file))
      return entry?.objectUrl ? { url: entry.objectUrl, decoded: !!entry.decoded } : undefined
    },
    decoded(room: string, file: string, url: string) {
      const entry = images.get(idFor(room, file))
      if (entry?.objectUrl === url) entry.decoded = true
    },
    invalidate(room: string, file: string, url: string) {
      const id = idFor(room, file)
      const entry = images.get(id)
      if (entry?.objectUrl === url) remove(id, entry)
    },
    acquire(room: string, file: string, load: () => Promise<Blob>) {
      const id = idFor(room, file)
      let entry = images.get(id)
      if (!entry) {
        const made: ImageEntry = {
          room,
          bytes: 0,
          users: 0,
          url: Promise.resolve()
            .then(load)
            .then(blob => {
              if (images.get(id) !== made) throw new Error('Image no longer requested')
              made.bytes = blob.size
              made.objectUrl = urls.createObjectURL(blob)
              return made.objectUrl
            })
            .catch(error => {
              remove(id, made)
              throw error
            }),
        }
        images.set(id, made)
        entry = made
      }
      const held = entry
      clearTimeout(held.expiry)
      held.expiry = undefined
      held.users++
      let released = false
      return {
        url: held.url,
        release() {
          if (released) return
          released = true
          if (--held.users > 0 || images.get(id) !== held) return
          if (!held.objectUrl) {
            // Keep an unfinished request reusable during a quick remount, but don't cache its result unboundedly.
            held.expiry = setTimeout(() => remove(id, held), keepMs)
            void held.url.then(trim, () => undefined)
            return
          }
          // LRU among the unreferenced URLs.
          images.delete(id)
          images.set(id, held)
          held.expiry = setTimeout(() => remove(id, held), keepMs)
          trim()
        },
      }
    },
    retain(rooms: ReadonlySet<string>) {
      for (const [id, entry] of images) if (!rooms.has(entry.room)) remove(id, entry)
    },
  }
}
export const dotImageCache = createDotImageCache()
