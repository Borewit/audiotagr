import type { ICommonTagsResult } from 'music-metadata'
import { joinMultiValue } from '../shared/multi-value'
import { AudioTags, NativeTagMap } from '../tags/domain'
import { getNativeStyleValues } from '../tags/style-tag'
import { getNativeTagValue } from './native-tags.mapper'

export function mapAudioTags(common: ICommonTagsResult, native: NativeTagMap | undefined): AudioTags {
  // Parsers merge STYLE frames into the same common field as the genre frame.
  // Pull the raw STYLE values out so Style gets its own field and Genre keeps
  // only what the genre frame held.
  const styleValues = getNativeStyleValues(native)
  const styleSet = new Set(styleValues)

  return {
    title: common.title || null,
    artist: joinMultiValue(common.artists ?? []) || common.artist || null,
    sortArtist: common.artistsort || null,
    album: common.album || null,
    sortAlbum: common.albumsort || null,
    trackNumber: common.track?.no || null,
    trackTotal: common.track?.of || null,
    discNumber: common.disk?.no || null,
    discTotal: common.disk?.of || null,
    year: common.year || null,
    bpm: common.bpm || null,
    genre: joinMultiValue((common.genre ?? []).filter(g => !styleSet.has(g))) || null,
    style: joinMultiValue(styleValues) || null,
    albumArtist: joinMultiValue(common.albumartists ?? []) || common.albumartist || null,
    sortAlbumArtist: common.albumartistsort || null,
    composer: joinMultiValue(common.composer ?? []) || null,
    conductor: joinMultiValue(common.conductor ?? []) || null,
    comment: common.comment?.[0]?.text || null,
    grouping: common.grouping || null,
    publisher: joinMultiValue(common.label ?? []) || getNativeTagValue(native, 'PUBLISHER') || null,
    catalogNumber: joinMultiValue(common.catalognumber ?? []) || null,
    releaseType: joinMultiValue(common.releasetype ?? []) || null,
    lyricist: joinMultiValue(common.lyricist ?? []) || null,
    barcode: common.barcode || null,
    work: common.work || getNativeTagValue(native, 'WORK') || getNativeTagValue(native, 'TXXX:WORK') || null,
    originalReleaseDate: common.originaldate || common.originalyear?.toString() || null,
    copyright: common.copyright || null,
    rating: mapRating(common, native),
    lyrics: common.lyrics?.[0]?.text || null,
    compilation: common.compilation || false,
    gapless: common.gapless || false
  }
}

function mapRating(common: ICommonTagsResult, native: NativeTagMap | undefined): number | null {
  const score = common.rating?.[0]?.rating
  if (typeof score === 'number') return Math.round(score * 100)

  // APEv2 has no common rating mapping, so the writer stores a 0-100 RATING
  // text item. Read it back through the native fallback.
  const nativeRating = getNativeTagValue(native, 'RATING')
  if (nativeRating === undefined) return null

  const value = Number(nativeRating)
  return Number.isFinite(value) && value >= 0 && value <= 100 ? Math.round(value) : null
}
