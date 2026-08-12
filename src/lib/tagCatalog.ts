import type { Tag } from "../types";

export function canonicalizeTags(tags: Tag[]) {
  return tags.map((tag) => ({ ...tag, color: tag.color.trim().toLocaleLowerCase() }));
}

export function resolveCatalogTags(assignedTags: Tag[], catalogTags: Tag[]) {
  const catalog = canonicalizeTags(catalogTags);
  const catalogById = new Map(catalog.map((tag) => [tag.id, tag]));
  const catalogByName = new Map(catalog.map((tag) => [tag.name.trim().toLocaleLowerCase(), tag]));
  return assignedTags.flatMap((tag) => {
    const catalogTag = catalogById.get(tag.id) ?? catalogByName.get(tag.name.trim().toLocaleLowerCase());
    return catalogTag ? [catalogTag] : [];
  });
}
