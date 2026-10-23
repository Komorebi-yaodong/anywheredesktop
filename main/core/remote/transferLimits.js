export const ADAPTIVE_TRANSFER_CAPABILITY = 'remote.transfer.adaptive.v1'
export const TRANSFER_MIN_CHUNK_BYTES = 512 * 1024
export const TRANSFER_MAX_CHUNK_BYTES = 8 * 1024 * 1024
// Two Base64URL expansions: an 8 MiB raw chunk fits below 16 MiB including JSON.
export const TRANSFER_MAX_FRAME_BYTES = 16 * 1024 * 1024
