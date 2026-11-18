/** Runtime settings; only console level and retention can be changed from Infrastructure. */
let retentionDays = Number(process.env.LOG_RETENTION_DAYS ?? 30);
if (!Number.isInteger(retentionDays) || retentionDays < 1 || retentionDays > 365) retentionDays = 30;
export function getRetentionDays(): number { return retentionDays; }
export function setRetentionDays(days: number): void {
  if (!Number.isInteger(days) || days < 1 || days > 365) throw new Error('invalid_log_retention_days');
  retentionDays = days;
}
