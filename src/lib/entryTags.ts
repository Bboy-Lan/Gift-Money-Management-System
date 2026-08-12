import type { Tag } from "../types";

export const ENTRY_VISIBLE_TAG_COUNT = 4;

export function mergeEntryTag(tags: Tag[], createdTag: Tag) {
  return [...tags.filter((tag) => tag.id !== createdTag.id), createdTag];
}

export function getEntryTagSections(tags: Tag[], promotedTagId: string | null = null) {
  const uniqueTags = [...new Map(tags.map((tag) => [tag.id, tag])).values()];
  const promotedTag = promotedTagId ? uniqueTags.find((tag) => tag.id === promotedTagId) : undefined;
  const orderedTags = promotedTag
    ? [promotedTag, ...uniqueTags.filter((tag) => tag.id !== promotedTag.id)]
    : uniqueTags;
  return {
    visible: orderedTags.slice(0, ENTRY_VISIBLE_TAG_COUNT),
    overflow: orderedTags.slice(ENTRY_VISIBLE_TAG_COUNT),
  };
}
