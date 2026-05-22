/**
 * @typedef {Object} NodeHealth
 * @property {'unknown'|'available'|'unavailable'} status
 * @property {string|null} last_checked_at
 * @property {string|null} last_seen_at
 * @property {number|null} latency_ms
 * @property {number} consecutive_failures
 * @property {string|null} last_error
 *
 * @typedef {Object} TelemetrySnapshot
 * @property {{used_mb?: number, total_mb?: number, free_mb?: number}=} memory
 * @property {{name?: string, utilization_pct?: number, memory_used_mb?: number, memory_total_mb?: number, temperature_c?: number, power_w?: number}=} gpu
 * @property {{name?: string, version?: string, backend?: string}=} engine
 * @property {{depth?: number, active?: number}=} queue
 * @property {number=} error_rate
 * @property {number=} active_requests
 *
 * @typedef {Object} MetricsSummary
 * @property {string} node_id
 * @property {number} samples_count
 * @property {number} available_samples
 * @property {number} unavailable_samples
 * @property {number} unknown_samples
 * @property {number|null} availability_ratio
 * @property {string|null} last_observed_at
 * @property {'unknown'|'available'|'unavailable'} last_status
 * @property {number|null} last_latency_ms
 * @property {TelemetrySnapshot['memory']|null} last_memory
 * @property {TelemetrySnapshot['gpu']|null} last_gpu
 * @property {TelemetrySnapshot['engine']|null} last_engine
 * @property {TelemetrySnapshot['queue']|null} last_queue
 * @property {number|null} last_error_rate
 * @property {string|null} last_error
 *
 * @typedef {Object} NodeRecord
 * @property {string} id
 * @property {string} display_name
 * @property {string} endpoint_url
 * @property {string} health_url
 * @property {string} node_public_key
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
