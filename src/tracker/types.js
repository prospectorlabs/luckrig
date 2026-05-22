/**
 * @typedef {Object} NodeHealth
 * @property {'unknown'|'available'|'unavailable'} status
 * @property {string|null} last_checked_at
 * @property {string|null} last_seen_at
 * @property {number|null} latency_ms
 * @property {number} consecutive_failures
 * @property {string|null} last_error
 *
 * @typedef {Object} NodeRecord
 * @property {string} id
 * @property {string} display_name
 * @property {string} endpoint_url
 * @property {string} health_url
 * @property {string} model_name
 * @property {string} quantization
 * @property {string} lora
 * @property {string} gpu
 * @property {number|null} vram_gb
 * @property {number|null} context_length
 * @property {string} availability_note
 * @property {string} tuning_note
 * @property {string[]} tags
 * @property {string} created_at
 * @property {string} updated_at
 * @property {NodeHealth} health
 */
export {};
