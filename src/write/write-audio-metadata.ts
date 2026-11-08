import { UnsupportedFormatError, updateFile } from 'music-metadata'
import { MetadataWriteError } from '../shared/errors'
import { AudioMetadataPatch } from '../tags/domain'
import { replaceLegacyId3 } from './normalize-id3'
import { buildWriterPatch } from './to-writer-patch'
import { detectWriteTarget, hasLegacyId3Tag } from './write-target'

/**
 * Write the given fields, leaving fields absent from the patch untouched.
 * Empty strings and `null` clear a tag.
 *
 * ID3v2.2/2.3 tags are read and normalized to ID3v2.4 before the patch is
 * applied. Fields this package models are preserved; frames the reader does not
 * expose, and a trailing ID3v1 tag, are lost when the old tag is replaced.
 *
 * @throws {MetadataWriteError} when the file cannot be opened, is not a
 * supported writable format, or cannot be saved.
 */
export async function writeAudioMetadata(filePath: string, patch: AudioMetadataPatch): Promise<void> {
  try {
    const target = await detectWriteTarget(filePath)
    if (target === 'unsupported') {
      throw new UnsupportedFormatError(
        'Unsupported writable format; supported formats are FLAC, Ogg Vorbis/Opus, WAV, MP4, MP3, raw AAC (ADTS), WMA/ASF and APEv2 (Monkey’s Audio, WavPack, Musepack)'
      )
    }

    if (await hasLegacyId3Tag(filePath, target)) {
      await replaceLegacyId3(filePath, buildWriterPatch(patch, target))
      return
    }

    await updateFile(filePath, buildWriterPatch(patch, target))
  } catch (error) {
    throw new MetadataWriteError(filePath, { cause: error })
  }
}
