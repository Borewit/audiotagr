import { MediaFile, type TagPatch } from 'music-metadata'
import { mapAudioTags } from '../read/common-fields.mapper'
import { mapCustomTags } from '../read/native-tags.mapper'
import { buildWriterPatch } from './to-writer-patch'

/** Carry writable common tags and audiotagr's native fields into the replacement ID3v2.4 tag. */
export async function replaceLegacyId3(filePath: string, patch: TagPatch): Promise<void> {
  const file = await MediaFile.open(filePath)
  const { common, native } = file.metadata
  const tags = mapAudioTags(common, native)
  const extra = buildWriterPatch(
    {
      style: tags.style,
      genre: tags.style ? tags.genre : undefined,
      work: common.work ? undefined : tags.work,
      publisher: common.label ? undefined : tags.publisher,
      customTags: mapCustomTags(native)
    },
    'id3'
  )

  // The replacement writer has no old tag to supply the other half of a number pair.
  for (const key of ['track', 'disk'] as const) {
    if (patch[key]) patch[key] = { ...common[key], ...patch[key] }
  }
  Object.assign(common, extra, patch, { native: { ...extra.native, ...patch.native } })
  await file.save({ replaceId3: true })
}
