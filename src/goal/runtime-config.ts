/** Пауза перед повторной попыткой, когда сессия занята. */
export const CONTINUATION_RETRY_MS = 50;
/** Дольше этого фоновый сабагент не держит продолжение, если событие о его завершении потерялось. */
export const SUBAGENT_WAIT_TIMEOUT_MS = 30 * 60_000;
/** Сколько ждать ответа pi-subagents о статусе, прежде чем считать его отсутствующим. */
export const SUBAGENT_RPC_TIMEOUT_MS = 2_000;
export const PROVIDER_LIMIT_AUTO_RESUME_MS = 5 * 60_000;
export const RUNTIME_PERSIST_INTERVAL_MS = 60_000;
