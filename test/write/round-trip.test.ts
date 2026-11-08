import fs from 'fs/promises'
import os from 'os'
import path from 'path'
import { parseFile } from 'music-metadata'
import { UnsupportedFeatureError, UnsupportedFormatError } from 'music-metadata'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { readAudioMetadata } from '../../src/read/read-audio-metadata'
import { MetadataWriteError } from '../../src/shared/errors'
import { splitMultiValue } from '../../src/shared/multi-value'
import { AudioMetadataPatch } from '../../src/tags/domain'
import { writeAudioMetadata } from '../../src/write/write-audio-metadata'
import { writeAudioPicture } from '../../src/write/write-audio-picture'

const FIXTURES = path.join(__dirname, '..', 'fixtures')

let workDir: string

beforeAll(async () => {
  workDir = await fs.mkdtemp(path.join(os.tmpdir(), 'audiotagr-'))
})

afterAll(async () => {
  await fs.rm(workDir, { recursive: true, force: true })
})

/**
 * Copy a fixture into the scratch dir so every test writes to its own file and
 * the checked-in fixtures stay pristine. The copy is named after the running
 * test, so two tests can never share a file by accident.
 */
async function fixture(name: string): Promise<string> {
  const testName = expect.getState().currentTestName ?? 'unknown'
  const slug = testName.replace(/[^a-z0-9]+/gi, '-').toLowerCase()
  const target = path.join(workDir, `${slug}-${name}`)

  // WAV and raw AAC have no checked-in fixtures; generate minimal files for the
  // write path.
  if (name === 'sample.wav') await fs.writeFile(target, makeWav())
  else if (name === 'sample.aac') await fs.writeFile(target, makeAdtsAac())
  else await fs.copyFile(path.join(FIXTURES, name), target)
  return target
}

async function writeAndRead(name: string, patch: AudioMetadataPatch) {
  const filePath = await fixture(name)
  await writeAudioMetadata(filePath, patch)
  return readAudioMetadata(filePath)
}

/** A minimal 16-bit PCM WAV file; WAV has no checked-in fixture. */
function makeWav(durationSeconds = 0.05): Buffer {
  const sampleRate = 8000
  const channels = 1
  const bitsPerSample = 16
  const dataLength = Math.round(sampleRate * channels * (bitsPerSample / 8) * durationSeconds)
  const buffer = Buffer.alloc(44 + dataLength)

  buffer.write('RIFF', 0, 'latin1')
  buffer.writeUInt32LE(36 + dataLength, 4)
  buffer.write('WAVE', 8, 'latin1')
  buffer.write('fmt ', 12, 'latin1')
  buffer.writeUInt32LE(16, 16)
  buffer.writeUInt16LE(1, 20)
  buffer.writeUInt16LE(channels, 22)
  buffer.writeUInt32LE(sampleRate, 24)
  buffer.writeUInt32LE(sampleRate * channels * (bitsPerSample / 8), 28)
  buffer.writeUInt16LE(channels * (bitsPerSample / 8), 32)
  buffer.writeUInt16LE(bitsPerSample, 34)
  buffer.write('data', 36, 'latin1')
  buffer.writeUInt32LE(dataLength, 40)

  return buffer
}

/**
 * A single-frame ADTS AAC stream with a silent payload. The writer only
 * validates the first ADTS header, and the reader surfaces it as AAC audio.
 */
function makeAdtsAac(frameLength = 32): Buffer {
  const headerLength = 7
  const buffer = Buffer.alloc(frameLength)

  buffer[0] = 0xff
  buffer[1] = 0xf1 // MPEG-4, layer 00, no CRC
  buffer[2] = 0x50 // AAC LC, 44.1 kHz
  buffer[3] = 0x80 // stereo
  buffer[3] |= (frameLength >> 11) & 0x03
  buffer[4] = (frameLength >> 3) & 0xff
  buffer[5] = ((frameLength & 0x07) << 5) | 0x1f
  buffer[6] = 0xfc
  buffer.fill(0, headerLength)

  return buffer
}

async function wavFixture(): Promise<string> {
  const testName = expect.getState().currentTestName ?? 'unknown'
  const slug = testName.replace(/[^a-z0-9]+/gi, '-').toLowerCase()
  const target = path.join(workDir, `${slug}-sample.wav`)
  await fs.writeFile(target, makeWav())
  return target
}

/** Build an ID3v2.3 text frame. */
function id3v23TextFrame(id: string, text: string): Buffer {
  const value = Buffer.from(text, 'latin1')
  const frame = Buffer.alloc(10 + 1 + value.length)
  frame.write(id, 0, 'latin1')
  frame.writeUInt32BE(1 + value.length, 4)
  frame[10] = 0
  value.copy(frame, 11)
  return frame
}

/** Build an ID3v2.3 TXXX frame. */
function id3v23TxxxFrame(description: string, text: string): Buffer {
  const desc = Buffer.from(description, 'latin1')
  const value = Buffer.from(text, 'latin1')
  const data = Buffer.alloc(1 + desc.length + 1 + value.length)
  data[0] = 0
  desc.copy(data, 1)
  value.copy(data, 2 + desc.length)

  const frame = Buffer.alloc(10 + data.length)
  frame.write('TXXX', 0, 'latin1')
  frame.writeUInt32BE(data.length, 4)
  data.copy(frame, 10)
  return frame
}

/** Build an ID3v2.3 tag around the supplied frames. */
function id3v23Tag(frames: Buffer[]): Buffer {
  const body = Buffer.concat(frames)
  const tag = Buffer.alloc(10 + body.length)
  tag.write('ID3', 0, 'latin1')
  tag[3] = 3
  tag[4] = 0
  tag[5] = 0
  tag[6] = (body.length >> 21) & 0x7f
  tag[7] = (body.length >> 14) & 0x7f
  tag[8] = (body.length >> 7) & 0x7f
  tag[9] = body.length & 0x7f
  body.copy(tag, 10)
  return tag
}

/** Build an ID3v2.2 frame (3-byte ID, 3-byte size, no flags). */
function id3v22Frame(id: string, data: Buffer): Buffer {
  const frame = Buffer.alloc(6 + data.length)
  frame.write(id, 0, 'latin1')
  frame[3] = (data.length >> 16) & 0xff
  frame[4] = (data.length >> 8) & 0xff
  frame[5] = data.length & 0xff
  data.copy(frame, 6)
  return frame
}

/** Build an ID3v2.2 TXX frame, whose description is embedded in the value. */
function id3v22TxxxFrame(description: string, text: string): Buffer {
  const desc = Buffer.from(description, 'latin1')
  const value = Buffer.from(text, 'latin1')
  const data = Buffer.alloc(1 + desc.length + 1 + value.length)
  data[0] = 0
  desc.copy(data, 1)
  value.copy(data, 2 + desc.length)
  return id3v22Frame('TXX', data)
}

/** Build an ID3v2.2 tag around the supplied frames. */
function id3v22Tag(frames: Buffer[]): Buffer {
  const body = Buffer.concat(frames)
  const tag = Buffer.alloc(10 + body.length)
  tag.write('ID3', 0, 'latin1')
  tag[3] = 2
  tag[4] = 0
  tag[5] = 0
  tag[6] = (body.length >> 21) & 0x7f
  tag[7] = (body.length >> 14) & 0x7f
  tag[8] = (body.length >> 7) & 0x7f
  tag[9] = body.length & 0x7f
  body.copy(tag, 10)
  return tag
}

/** Build an MP3 carrying a valid ID3v2.2 tag in front of the sample audio. */
async function id3v22Fixture(): Promise<string> {
  const source = await fs.readFile(path.join(FIXTURES, 'sample.mp3'))
  const tagSize =
    ((source[6]! & 0x7f) << 21) | ((source[7]! & 0x7f) << 14) | ((source[8]! & 0x7f) << 7) | (source[9]! & 0x7f)
  const audio = source.subarray(10 + tagSize)

  const tag = id3v22Tag([id3v22TxxxFrame('MOOD', 'calm')])

  const testName = expect.getState().currentTestName ?? 'unknown'
  const slug = testName.replace(/[^a-z0-9]+/gi, '-').toLowerCase()
  const target = path.join(workDir, `${slug}-id3v22.mp3`)
  await fs.writeFile(target, Buffer.concat([tag, audio]))
  return target
}

/** Build an MP3 carrying a valid ID3v2.3 tag in front of the sample audio. */
async function id3v23Fixture(): Promise<string> {
  const source = await fs.readFile(path.join(FIXTURES, 'sample.mp3'))
  const tagSize =
    ((source[6]! & 0x7f) << 21) | ((source[7]! & 0x7f) << 14) | ((source[8]! & 0x7f) << 7) | (source[9]! & 0x7f)
  const audio = source.subarray(10 + tagSize)

  const tag = id3v23Tag([
    id3v23TextFrame('TIT2', 'Old ID3v2.3 tag'),
    id3v23TextFrame('TPE1', 'Old Artist'),
    id3v23TextFrame('TALB', 'Old Album'),
    id3v23TxxxFrame('MOOD', 'calm')
  ])

  const testName = expect.getState().currentTestName ?? 'unknown'
  const slug = testName.replace(/[^a-z0-9]+/gi, '-').toLowerCase()
  const target = path.join(workDir, `${slug}-id3v23.mp3`)
  await fs.writeFile(target, Buffer.concat([tag, audio]))
  return target
}

/** Build a WAV file whose id3 chunk contains an ID3v2.3 tag. */
async function wavId3v23Fixture(): Promise<string> {
  const wav = makeWav()
  const tag = id3v23Tag([id3v23TextFrame('TIT2', 'Old WAV title')])
  const tagChunk = Buffer.alloc(8 + tag.length + (tag.length % 2))
  tagChunk.write('id3 ', 0, 'latin1')
  tagChunk.writeUInt32LE(tag.length, 4)
  tag.copy(tagChunk, 8)

  // Insert the ID3 chunk between the fmt and data chunks, then fix the RIFF size.
  const withTag = Buffer.concat([wav.subarray(0, 36), tagChunk, wav.subarray(36)])
  withTag.writeUInt32LE(withTag.length - 8, 4)

  const testName = expect.getState().currentTestName ?? 'unknown'
  const slug = testName.replace(/[^a-z0-9]+/gi, '-').toLowerCase()
  const target = path.join(workDir, `${slug}-id3v23.wav`)
  await fs.writeFile(target, withTag)
  return target
}

// Formats with a canonical write section in music-metadata 12.7.0. AIFF remains
// readable, but is not writable. WAV and raw AAC are generated by `fixture()`.
const ALL_FORMATS = [
  'sample.mp3',
  'sample.aac',
  'sample.flac',
  'sample.m4a',
  'sample.ogg',
  'sample.opus',
  'sample.wav',
  'sample.wma',
  'sample.ape'
]

describe.each(ALL_FORMATS)('%s', name => {
  it('round-trips the common fields', async () => {
    const meta = await writeAndRead(name, {
      title: 'Round Trip',
      album: 'Test Album',
      trackNumber: 3,
      year: 1998,
      comment: 'hello'
    })

    expect(meta.title).toBe('Round Trip')
    expect(meta.album).toBe('Test Album')
    expect(meta.trackNumber).toBe(3)
    expect(meta.year).toBe(1998)
    expect(meta.comment).toBe('hello')
  })

  it('round-trips multi-value artists', async () => {
    const meta = await writeAndRead(name, { artist: 'A;B' })

    // MP4 holds every performer in a single field joined with "; ", so compare
    // the values rather than the exact separator.
    expect(splitMultiValue(meta.artist?.replace(/;\s+/g, ';'))).toEqual(['A', 'B'])
  })

  it('round-trips album artist, disc numbers and credits', async () => {
    const meta = await writeAndRead(name, {
      albumArtist: 'Album Artist',
      discNumber: 2,
      discTotal: 3,
      composer: 'Composer',
      conductor: 'Conductor',
      lyricist: 'Lyricist',
      grouping: 'Grouping',
      copyright: '2026 Example',
      lyrics: 'first line\nsecond line'
    })

    expect(meta.albumArtist).toBe('Album Artist')
    expect(meta.discNumber).toBe(2)
    expect(meta.discTotal).toBe(3)
    expect(meta.composer).toBe('Composer')
    expect(meta.conductor).toBe('Conductor')
    expect(meta.lyricist).toBe('Lyricist')
    expect(meta.grouping).toBe('Grouping')
    expect(meta.copyright).toBe('2026 Example')
    expect(meta.lyrics).toBe('first line\nsecond line')
  })

  it('round-trips sort fields and track totals', async () => {
    const meta = await writeAndRead(name, {
      sortArtist: 'Artist, The',
      sortAlbum: 'Album, The',
      sortAlbumArtist: 'Album Artist, The',
      trackNumber: 3,
      trackTotal: 12
    })

    expect(meta.sortArtist).toBe('Artist, The')
    expect(meta.sortAlbum).toBe('Album, The')
    expect(meta.sortAlbumArtist).toBe('Album Artist, The')
    expect(meta.trackNumber).toBe(3)
    expect(meta.trackTotal).toBe(12)
  })

  it('round-trips release metadata', async () => {
    const meta = await writeAndRead(name, {
      publisher: 'Label',
      catalogNumber: 'CAT-001',
      barcode: '1234567890123',
      work: 'Work Title',
      originalReleaseDate: '1998-05-04',
      compilation: true
    })

    expect(meta.publisher).toBe('Label')
    expect(meta.catalogNumber).toBe('CAT-001')
    expect(meta.barcode).toBe('1234567890123')
    expect(meta.work).toBe('Work Title')
    expect(meta.originalReleaseDate).toBe('1998-05-04')
    expect(meta.compilation).toBe(true)
  })

  it('keeps Style out of Genre', async () => {
    const meta = await writeAndRead(name, { genre: 'Pop Punk', style: 'acoustic' })

    expect(meta.genre).toBe('Pop Punk')
    expect(meta.style).toBe('acoustic')
  })

  it('round-trips a multi-value release type', async () => {
    const meta = await writeAndRead(name, { releaseType: 'album;live' })

    expect(splitMultiValue(meta.releaseType?.replace(/;\s+/g, ';'))).toEqual(['album', 'live'])
    expect(meta.customTags.some(t => /album ?type|releasetype/i.test(t.key))).toBe(false)
  })

  it('round-trips custom tags', async () => {
    const meta = await writeAndRead(name, {
      customTags: [{ key: 'MOOD', value: 'calm' }]
    })

    const mood = meta.customTags.find(t => t.key.toUpperCase().endsWith('MOOD'))
    expect(mood?.value).toBe('calm')
  })

  it('writes reader-prefixed custom tags back and clears them', async () => {
    const filePath = await fixture(name)
    await writeAudioMetadata(filePath, { customTags: [{ key: 'MOOD', value: 'calm' }] })

    const mood = (await readAudioMetadata(filePath)).customTags.find(t => t.key.toUpperCase().endsWith('MOOD'))
    expect(mood).toBeDefined()

    await writeAudioMetadata(filePath, { customTags: [{ key: mood!.key, value: 'focused' }] })
    expect((await readAudioMetadata(filePath)).customTags.find(t => t.key.toUpperCase().endsWith('MOOD'))?.value).toBe(
      'focused'
    )

    await writeAudioMetadata(filePath, { customTags: [{ key: mood!.key, value: null }] })
    expect(
      (await readAudioMetadata(filePath)).customTags.find(t => t.key.toUpperCase().endsWith('MOOD'))
    ).toBeUndefined()
  })

  it('clears a field written as null', async () => {
    const filePath = await fixture(name)
    await writeAudioMetadata(filePath, { title: 'To be removed' })
    await writeAudioMetadata(filePath, { title: null })

    expect((await readAudioMetadata(filePath)).title).toBeNull()
  })

  it('writes a front cover', async () => {
    const filePath = await fixture(name)
    // 1x1 transparent PNG.
    const png = Buffer.from(
      'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
      'base64'
    )

    await writeAudioPicture(filePath, png, 'image/png')

    const meta = await readAudioMetadata(filePath)
    expect(meta.pictures).toHaveLength(1)
    expect(meta.pictures[0].data?.length).toBe(png.length)
  })
})

// BPM is written to the canonical BPM field in Vorbis comments rather than the
// legacy TEMPO field, which parsers do not surface as BPM.
describe.each(ALL_FORMATS)('%s bpm', name => {
  it('round-trips BPM', async () => {
    const meta = await writeAndRead(name, { bpm: 128 })

    expect(meta.bpm).toBe(128)
  })
})

// Rating uses POPM in ID3v2, a common field in ASF/Vorbis and a 0-100 RATING
// item in APEv2.
describe.each([
  'sample.mp3',
  'sample.aac',
  'sample.flac',
  'sample.ogg',
  'sample.opus',
  'sample.wav',
  'sample.wma',
  'sample.ape'
])('%s rating', name => {
  it('round-trips a 0-100 rating', async () => {
    const meta = await writeAndRead(name, { rating: 80 })

    expect(meta.rating).toBe(80)
  })
})

// Release type is written as separate values (not one ";"-joined string) where
// the format supports it, so readers that don't split on ";" see each type.
describe.each(ALL_FORMATS)('%s release type', name => {
  it('stores each release type as its own value', async () => {
    const filePath = await fixture(name)
    await writeAudioMetadata(filePath, { releaseType: 'album;live' })

    const { common } = await parseFile(filePath)
    expect(common.releasetype).toEqual(['album', 'live'])
    expect((await readAudioMetadata(filePath)).releaseType).toBe('album;live')
  })

  it('clears the release type', async () => {
    const filePath = await fixture(name)
    await writeAudioMetadata(filePath, { releaseType: 'album;live' })
    await writeAudioMetadata(filePath, { releaseType: null })

    expect((await readAudioMetadata(filePath)).releaseType).toBeNull()
  })
})

// WAV has no checked-in fixture; generate a minimal PCM file for the write path.
describe('sample.wav', () => {
  it('writes ID3v2.4 tags into a RIFF/WAVE id3 chunk', async () => {
    const filePath = await wavFixture()

    await writeAudioMetadata(filePath, {
      title: 'WAV Title',
      artist: 'A;B',
      style: 'acoustic',
      customTags: [{ key: 'MOOD', value: 'calm' }]
    })

    const meta = await readAudioMetadata(filePath)
    expect(meta.title).toBe('WAV Title')
    expect(splitMultiValue(meta.artist)).toEqual(['A', 'B'])
    expect(meta.style).toBe('acoustic')
    expect(meta.customTags.find(tag => tag.key.toUpperCase().endsWith('MOOD'))?.value).toBe('calm')
  })

  it('writes a front cover', async () => {
    const filePath = await wavFixture()
    const png = Buffer.from(
      'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
      'base64'
    )

    await writeAudioPicture(filePath, png, 'image/png')

    expect((await readAudioMetadata(filePath)).pictures).toHaveLength(1)
  })
})

describe('ID3v2.3 input', () => {
  it('normalizes the tag to ID3v2.4 and applies the patch', async () => {
    const filePath = await id3v23Fixture()

    await writeAudioMetadata(filePath, { title: 'New title' })

    const meta = await readAudioMetadata(filePath)
    expect(meta.title).toBe('New title')
    // The original fields from the ID3v2.3 tag should be preserved
    expect(meta.artist).toBe('Old Artist')
    expect(meta.album).toBe('Old Album')
  })

  it('preserves rating ownership, play count and track total during a partial edit', async () => {
    const filePath = path.join(workDir, 'legacy-rating.aac')
    const body = Buffer.from('listener\0\x80\0\0\0\x2a', 'latin1')
    const header = Buffer.alloc(10)
    header.write('POPM')
    header.writeUInt32BE(body.length, 4)
    const tag = id3v23Tag([Buffer.concat([header, body]), id3v23TextFrame('TRCK', '1/9')])
    const audio = makeAdtsAac()
    await fs.writeFile(filePath, Buffer.concat([tag, audio]))

    await writeAudioMetadata(filePath, { trackNumber: 3 })

    const saved = await parseFile(filePath)
    expect(saved.common.track).toEqual({ no: 3, of: 9 })
    expect(saved.native['ID3v2.4']).toContainEqual({
      id: 'POPM',
      value: { email: 'listener', rating: 128, counter: 42 }
    })
    expect((await fs.readFile(filePath)).subarray(-audio.length)).toEqual(audio)
  })

  it('normalizes an ID3v2.3 tag inside a WAV file', async () => {
    const filePath = await wavId3v23Fixture()

    await writeAudioMetadata(filePath, { title: 'New WAV title' })

    expect((await readAudioMetadata(filePath)).title).toBe('New WAV title')
  })

  it('normalizes an ID3v2.3 tag in front of raw ADTS AAC', async () => {
    const filePath = path.join(workDir, 'legacy-id3.aac')
    const tag = id3v23Tag([id3v23TextFrame('TIT2', 'Old AAC title')])
    await fs.writeFile(filePath, Buffer.concat([tag, makeAdtsAac()]))

    await writeAudioMetadata(filePath, { title: 'New AAC title' })

    const meta = await readAudioMetadata(filePath)
    expect(meta.title).toBe('New AAC title')
    expect(meta.sampleRate).toBe(44100)
  })
})

describe('ID3v2.2 input', () => {
  it('normalizes TXX custom tags to the TXXX shape', async () => {
    const filePath = await id3v22Fixture()

    await writeAudioMetadata(filePath, { title: 'New title' })

    const meta = await readAudioMetadata(filePath)
    expect(meta.title).toBe('New title')
    expect(meta.customTags.find(tag => tag.key.toUpperCase().endsWith('MOOD'))?.value).toBe('calm')
    expect(meta.customTags.some(tag => tag.key.includes('TXX:'))).toBe(false)
  })
})

describe('raw ADTS AAC', () => {
  it('writes a tag without changing the audio payload', async () => {
    const audio = makeAdtsAac()
    const filePath = path.join(workDir, 'payload.aac')
    await fs.writeFile(filePath, audio)

    await writeAudioMetadata(filePath, { title: 'AAC title' })

    const written = await fs.readFile(filePath)
    expect(written.subarray(written.length - audio.length)).toEqual(audio)
    expect((await readAudioMetadata(filePath)).title).toBe('AAC title')
  })
})

describe('signature detection', () => {
  it('detects WMA and APE files without relying on the extension', async () => {
    for (const [name, target] of [
      ['sample.wma', 'signature-asf.bin'],
      ['sample.ape', 'signature-ape.bin']
    ] as const) {
      const filePath = path.join(workDir, target)
      await fs.copyFile(path.join(FIXTURES, name), filePath)

      await writeAudioMetadata(filePath, { title: 'Signature Title' })

      expect((await readAudioMetadata(filePath)).title).toBe('Signature Title')
    }
  })

  it('reports an APE file with a leading ID3 tag as unsupported', async () => {
    const source = await fs.readFile(path.join(FIXTURES, 'sample.ape'))
    const filePath = path.join(workDir, 'leading-id3.ape')
    await fs.writeFile(filePath, Buffer.concat([id3v23Tag([id3v23TextFrame('TIT2', 'Leading ID3')]), source]))

    const error = await writeAudioMetadata(filePath, { title: 'Nope' }).then(
      () => null,
      reason => reason
    )

    expect(error).toBeInstanceOf(MetadataWriteError)
    expect((error as MetadataWriteError).cause).toBeInstanceOf(UnsupportedFeatureError)
  })
})

describe('formats without a writer', () => {
  it('rejects AIFF and leaves the file untouched', async () => {
    const filePath = path.join(workDir, 'unsupported-sample.aiff')
    // detectWriteTarget rejects this by extension before any parser runs, so
    // the contents only need to exist.
    const before = Buffer.from('unsupported audio container')
    await fs.writeFile(filePath, before)

    const error = await writeAudioMetadata(filePath, { title: 'New title' }).then(
      () => null,
      reason => reason
    )

    expect(error).toBeInstanceOf(MetadataWriteError)
    expect((error as MetadataWriteError).cause).toBeInstanceOf(UnsupportedFormatError)
    expect(await fs.readFile(filePath)).toEqual(before)
  })
})
