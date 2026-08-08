package com.rmyndharis.openwa.model;

/**
 * Partial update of a RUNNING session's configuration — no re-link and no QR scan. All three fields
 * were fixed at creation before this route existed.
 *
 * <p>Send a null {@code maxReconnectAttempts} to restore unlimited retries, which no in-range number
 * can express.
 *
 * @param autoRejectCalls auto-reject incoming calls
 * @param maxReconnectAttempts cap on consecutive reconnect attempts; null restores unlimited
 * @param reconnectBaseDelay base delay of the reconnect backoff, in milliseconds
 */
public record UpdateSessionConfigRequest(
        Boolean autoRejectCalls, Integer maxReconnectAttempts, Integer reconnectBaseDelay) {}
