/**
 * Object keys are generated from ids, never from user-supplied file names:
 *
 *   media/{organizationId}/{assetId}/source       original upload
 *   media/{organizationId}/{assetId}/hls/{file}   HLS master/variant playlists and segments
 *   media/{organizationId}/{assetId}/thumb.jpg    poster frame
 */
export const mediaKeys = {
  prefix: (organizationId: string, assetId: string) => `media/${organizationId}/${assetId}`,
  source: (organizationId: string, assetId: string) => `media/${organizationId}/${assetId}/source`,
  hlsPrefix: (organizationId: string, assetId: string) => `media/${organizationId}/${assetId}/hls`,
  hls: (organizationId: string, assetId: string, file: string) => {
    if (!HLS_FILE.test(file)) throw new Error(`Invalid HLS file name "${file}"`);
    return `media/${organizationId}/${assetId}/hls/${file}`;
  },
  thumbnail: (organizationId: string, assetId: string) => `media/${organizationId}/${assetId}/thumb.jpg`,
};

/** Flat HLS file names produced by the transcoder (`master.m3u8`, `720p.m3u8`, `720p_00001.ts`). */
export const HLS_FILE = /^[A-Za-z0-9][A-Za-z0-9_-]{0,63}\.(m3u8|ts|m4s|mp4|aac|vtt)$/;
export const HLS_PLAYLIST_FILE = /^[A-Za-z0-9][A-Za-z0-9_-]{0,63}\.m3u8$/;
