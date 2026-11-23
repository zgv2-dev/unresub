const required = (name: string) => {
  const v = process.env[name];
  if (!v) throw new Error(`Missing env var ${name}. See .env.example.`);
  return v;
};

export const env = {
  get secretKey() {
    const key = Buffer.from(required('UNRESUB_SECRET_KEY'), 'base64');
    if (key.length !== 32) throw new Error('UNRESUB_SECRET_KEY must be 32 bytes, base64-encoded');
    return key;
  },
  get apiToken() {
    return required('UNRESUB_API_TOKEN');
  },
  publicUrl: process.env.PUBLIC_URL?.replace(/\/$/, '') || null,
  port: Number(process.env.PORT ?? 8787),
  dbPath: process.env.DB_PATH ?? './unresub.db',
  syncIntervalHours: Number(process.env.SYNC_INTERVAL_HOURS ?? 6),
  backfillMonths: Number(process.env.BACKFILL_MONTHS ?? 12),
};
