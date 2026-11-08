import type { TagPatch } from 'music-metadata'
import { TagKeyValue } from '../shared/domain'
import { splitMultiValue } from '../shared/multi-value'
import { AudioMetadataPatch } from '../tags/domain'
import { WriteTarget } from './write-target'

type NativeValue = string | string[] | null

/** Formats that prefix custom-tag keys when the reader returns them. */
const READER_FORMAT_PREFIX = /^(?:ID3v1|ID3v2(?:\.\d)?|APEv2|vorbis|iTunes(?: MP4)?|exif|asf):/i

/**
 * Translate audiotagr's format-agnostic patch into the writer's common/native
 * patch. Native names are chosen per tag family so a custom field lands where
 * that format's readers actually look for it.
 */
export function buildWriterPatch(patch: AudioMetadataPatch, target: WriteTarget): TagPatch {
  const result: TagPatch = {}
  const native: Record<string, NativeValue> = {}

  if (patch.title !== undefined) result.title = text(patch.title)
  if (patch.album !== undefined) result.album = text(patch.album)
  if (patch.year !== undefined) result.year = patch.year
  if (patch.bpm !== undefined) result.bpm = patch.bpm
  if (patch.genre !== undefined) result.genre = values(patch.genre)
  if (patch.comment !== undefined) result.comment = text(patch.comment)
  if (patch.composer !== undefined) result.composer = values(patch.composer)
  if (patch.conductor !== undefined) result.conductor = text(patch.conductor)
  if (patch.grouping !== undefined) result.grouping = text(patch.grouping)
  if (patch.publisher !== undefined) result.label = text(patch.publisher)
  if (patch.catalogNumber !== undefined) result.catalognumber = text(patch.catalogNumber)
  if (patch.releaseType !== undefined) result.releasetype = values(patch.releaseType)
  if (patch.lyricist !== undefined) result.lyricist = text(patch.lyricist)
  if (patch.barcode !== undefined) result.barcode = text(patch.barcode)
  if (patch.work !== undefined) result.work = text(patch.work)
  if (patch.originalReleaseDate !== undefined) result.originaldate = text(patch.originalReleaseDate)
  if (patch.copyright !== undefined) result.copyright = text(patch.copyright)
  if (patch.lyrics !== undefined) result.lyrics = text(patch.lyrics)
  if (patch.compilation !== undefined) result.compilation = patch.compilation

  if (patch.artist !== undefined) {
    // ID3v2.4 keeps display artists in TPE1; Vorbis and MP4 readers surface the
    // repeated ARTIST / ©ART item as the artist list. ASF and APEv2 only map the
    // singular common `artist` field.
    if (target === 'id3' || target === 'asf' || target === 'ape') result.artist = values(patch.artist)
    else result.artists = values(patch.artist)
  }

  if (patch.albumArtist !== undefined) {
    // ASF and APEv2 expose only the singular `albumartist` common field.
    if (target === 'asf' || target === 'ape') result.albumartist = values(patch.albumArtist)
    else result.albumartists = values(patch.albumArtist)
  }
  if (patch.sortArtist !== undefined) result.artistsort = text(patch.sortArtist)
  if (patch.sortAlbum !== undefined) result.albumsort = text(patch.sortAlbum)
  if (patch.sortAlbumArtist !== undefined) result.albumartistsort = text(patch.sortAlbumArtist)

  const track = numberPair(patch.trackNumber, patch.trackTotal)
  if (track !== undefined) result.track = track
  const disk = numberPair(patch.discNumber, patch.discTotal)
  if (disk !== undefined) result.disk = disk

  if (patch.rating !== undefined) {
    if (target === 'ape') {
      // APEv2 has no common rating mapping. Write the 0-100 RATING text field
      // the read mapper falls back to, matching the previous writer.
      native.RATING = patch.rating === null ? null : String(patch.rating)
    } else if (target === 'mp4') {
      // MP4 has no common rating mapping; keep the iTunes freeform field the
      // previous writer used.
      native['----:com.apple.iTunes:RATING'] = text(patch.rating === null ? null : String(patch.rating)) ?? null
    } else {
      result.rating = patch.rating === null ? null : [{ rating: patch.rating / 100 }]
    }
  }

  if (patch.style !== undefined) {
    native[styleNativeKey(target)] = text(patch.style) ?? null
  }

  if (patch.customTags) {
    mergeCustomTags(native, patch.customTags, target)
  }

  if (Object.keys(native).length > 0) {
    result.native = native
  }

  return result
}

function text(value: string | null | undefined): string | null | undefined {
  if (value === undefined) return undefined
  return value === null || value === '' ? null : value
}

function values(value: string | null | undefined): string[] | null | undefined {
  if (value === undefined) return undefined
  if (value === null || value === '') return null
  const entries = splitMultiValue(value)
  return entries.length > 0 ? entries : null
}

function numberPair(
  no: number | null | undefined,
  of: number | null | undefined
): { no?: number | null; of?: number | null } | null | undefined {
  if (no === undefined && of === undefined) return undefined
  if (no === null && of === null) return null

  const pair: { no?: number | null; of?: number | null } = {}
  if (no !== undefined) pair.no = no
  if (of !== undefined) pair.of = of
  return pair
}

function mergeCustomTags(native: Record<string, NativeValue>, customTags: TagKeyValue[], target: WriteTarget) {
  const grouped = new Map<string, string[]>()

  for (const { key, value } of customTags) {
    const nativeKey = toNativeKey(key, target)
    const entries = grouped.get(nativeKey) ?? []
    if (value !== null && value !== '') entries.push(value)
    grouped.set(nativeKey, entries)
  }

  for (const [key, entries] of grouped) {
    native[key] = entries.length === 0 ? null : entries.length === 1 ? entries[0]! : entries
  }
}

/** Strip the reader's `format:tag` prefix without touching `TXXX:`/`----:`. */
function stripReaderFormat(key: string): string {
  return key.replace(READER_FORMAT_PREFIX, '')
}

function toNativeKey(rawKey: string, target: WriteTarget): string {
  const fromId3 = /^ID3v/i.test(rawKey.trim())
  const key = stripReaderFormat(rawKey).trim()
  // ID3v2.2's TXX frames are surfaced as `TXX:description`; the writer only
  // knows the ID3v2.4 TXXX shape.
  const userText = /^T(?:XX|XXX):(.*)$/i.exec(key)
  const userTextKey = userText ? `TXXX:${userText[1]}` : undefined

  if (target === 'asf') {
    // ASF attribute names are case-sensitive and the reader returns them as
    // stored, so preserve the key after unwrapping ID3/MP4 user-field syntax.
    if (key.startsWith('----:')) return lastSegment(key)
    if (userTextKey) return userText![1]!
    return key
  }

  if (target === 'vorbis' || target === 'ape') {
    if (key.startsWith('----:')) return lastSegment(key).toUpperCase()
    if (userTextKey) return userText![1]!.toUpperCase()
    return key.toUpperCase()
  }

  if (target === 'mp4') {
    if (key.startsWith('----:')) {
      const parts = key.split(':')
      const name = parts.pop()!
      const mean = parts.slice(1).join(':') || 'com.apple.iTunes'
      return `----:${mean}:${name}`
    }
    if (/^[\x20-\xff]{4}$/.test(key) && !key.toUpperCase().startsWith('TXXX')) return key
    return `----:com.apple.iTunes:${userText ? userText[1] : key.replace(/^TXXX:/i, '')}`
  }

  if (userTextKey) return userTextKey
  // A bare 4-character key read from ID3 is a frame ID; a bare key from any
  // other format (for example the Vorbis field MOOD) is a user text field.
  if (fromId3 && /^[A-Z0-9]{4}$/i.test(key)) return key.toUpperCase()
  return `TXXX:${key.startsWith('----:') ? lastSegment(key) : key}`
}

function lastSegment(key: string): string {
  return key.split(':').pop() ?? key
}

function styleNativeKey(target: WriteTarget): string {
  if (target === 'mp4') return '----:com.apple.iTunes:STYLE'
  if (target === 'id3') return 'TXXX:STYLE'
  // Vorbis comments, ASF attributes and APEv2 items all use a plain STYLE key.
  return 'STYLE'
}
