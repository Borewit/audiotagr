import { UnsupportedFormatError, updateFile } from 'music-metadata'
import { MetadataWriteError } from '../shared/errors'
import { replaceLegacyId3 } from './normalize-id3'
import { detectWriteTarget, hasLegacyId3Tag } from './write-target'

/**
 * Replace every embedded picture with a single front cover.
 *
 * ID3v2.2/2.3 files are normalized to ID3v2.4 first, preserving the fields this
 * package models.
 *
 * @throws {MetadataWriteError} when the file cannot be opened, is not a
 * supported writable format, or cannot be saved.
 */
export async function writeAudioPicture(filePath: string, image: Buffer, mimeType: string): Promise<void> {
  try {
    const target = await detectWriteTarget(filePath)
    if (target === 'unsupported') {
      throw new UnsupportedFormatError(
        'Unsupported writable format; supported formats are FLAC, Ogg Vorbis/Opus, WAV, MP4, MP3, raw AAC (ADTS), WMA/ASF and APEv2 (Monkey’s Audio, WavPack, Musepack)'
      )
    }

    const picture = {
      type: 'Cover (front)',
      format: mimeType,
      description: '',
      data: image
    }

    if (await hasLegacyId3Tag(filePath, target)) {
      await replaceLegacyId3(filePath, { picture: [picture] })
      return
    }

    await updateFile(filePath, { picture: [picture] })
  } catch (error) {
    throw new MetadataWriteError(filePath, { cause: error })
  }
}
