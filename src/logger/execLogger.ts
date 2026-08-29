import { logger } from "../config/logger.js";

/**
 * Records verbose execution details through the application's structured logger.
 * Debug output is controlled centrally through LOG_LEVEL.
 */
export function logData(data: unknown, action: string) {
    logger.debug({ data }, action);
}
