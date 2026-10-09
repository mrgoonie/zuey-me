import { timingSafeEqualStrings } from './payments/sepay';

/** True when the request carries `Authorization: Bearer <CRON_SECRET>` (the Cloudflare cron worker). */
export async function isCronCaller(request: Request, secret: string | undefined): Promise<boolean> {
  const match = /^Bearer\s+(.+)$/i.exec(request.headers.get('authorization')?.trim() ?? '');
  return Boolean(secret && match && (await timingSafeEqualStrings(match[1].trim(), secret)));
}
