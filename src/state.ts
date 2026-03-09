import { LobsterMail, Inbox } from '@lobsterkit/lobstermail';

let client: LobsterMail | null = null;
const inboxCache = new Map<string, Inbox>();

/**
 * Get or create the singleton LobsterMail client.
 * Auto-signs up on first call, persists token to ~/.lobstermail/token.
 */
export async function getClient(): Promise<LobsterMail> {
  if (!client) {
    client = await LobsterMail.create();
  }
  return client;
}

/** Cache an inbox instance for later retrieval. */
export function cacheInbox(inbox: Inbox): void {
  inboxCache.set(inbox.id, inbox);
}

/** Retrieve a cached inbox, or fetch from API. */
export async function getInbox(inboxId: string): Promise<Inbox> {
  const cached = inboxCache.get(inboxId);
  if (cached) return cached;

  const lm = await getClient();
  const inbox = await lm.getInbox(inboxId);
  inboxCache.set(inbox.id, inbox);
  return inbox;
}
