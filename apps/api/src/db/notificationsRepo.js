import { store } from '../data/store.js';
import { DATABASE_ENABLED, db } from './client.js';
import { NOTIFICATION_SETTING_DEFAULTS } from '../services/notifications.js';

/**
 * Notification settings persistence — the staff toggles for the
 * unified alerts system (staff email alerts, staff SMS alerts,
 * customer email/SMS confirmations). Key/value rows in the
 * NotificationSetting table; the store copy is what
 * services/notifications.js reads on every event. Defaults are ALL ON
 * (see NOTIFICATION_SETTING_DEFAULTS) — a missing row means "on".
 *
 * Every function is a no-op (or defaults) when DATABASE_URL is unset,
 * matching the other repos' skeleton behavior.
 */

export async function hydrateNotificationSettings() {
  if (!DATABASE_ENABLED) return 0;
  const rows = await db().notificationSetting.findMany();
  const settings = { ...NOTIFICATION_SETTING_DEFAULTS };
  for (const row of rows) {
    if (row.key in settings) settings[row.key] = Boolean(row.enabled);
  }
  store.notificationSettings = settings;
  return rows.length;
}

export async function persistNotificationSetting(key, enabled, updatedBy = null) {
  if (!store.notificationSettings) store.notificationSettings = { ...NOTIFICATION_SETTING_DEFAULTS };
  store.notificationSettings[key] = Boolean(enabled);
  if (!DATABASE_ENABLED) return;
  await db().notificationSetting.upsert({
    where: { key },
    update: { enabled: Boolean(enabled), updatedBy },
    create: { key, enabled: Boolean(enabled), updatedBy },
  });
}
