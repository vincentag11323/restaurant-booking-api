/**
 * Notification stub. v1 only logs; swap this body for email/WhatsApp delivery later.
 */
export async function notify(to: string, subject: string, body: string) {
  console.info(`[notify] to=${to} subject="${subject}" ${body}`);
}
