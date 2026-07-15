const asObject = (value) => (value && typeof value === "object" && !Array.isArray(value) ? value : {});

export const normalizeUpdateMetadata = (metadata) => {
  const source = asObject(metadata);
  return {
    version: String(source.version || source.tag_name || source.name || "").trim(),
    publishedAt: String(source.pub_date || source.published_at || "").trim(),
    releaseNotes: String(source.notes || source.body || source.release_notes || "").trim(),
    hasPublishedRelease: Boolean(source.version || source.tag_name),
  };
};

export const describeUpdateAvailability = ({ metadata, online = true, update = null } = {}) => {
  if (!online) {
    return { phase: "offline", label: "Offline - update status unavailable" };
  }
  if (update) {
    return { phase: "update_available", label: `Update available: ${String(update.version || "").trim()}`.trim() };
  }
  if (!normalizeUpdateMetadata(metadata).hasPublishedRelease) {
    return { phase: "no_published_update", label: "No published update available" };
  }
  return { phase: "up_to_date", label: "No newer published update available" };
};
