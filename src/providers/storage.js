/**
 * Media storage abstraction for ID cards, certificates and profile photos.
 *
 * UltraMsg already hosts inbound media at a public URL, so the default provider
 * simply records that URL. Swap in S3/GCS here if the media must be re-hosted.
 */
export const passthroughStorage = {
  name: 'passthrough',
  async store({ url, mediaId, type }) {
    return { url, mediaId, type, storedAt: new Date() };
  },
};

export const storage = passthroughStorage;
export default storage;
