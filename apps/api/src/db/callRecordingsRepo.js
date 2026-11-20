import { createId, store } from '../data/store.js';
import { DATABASE_ENABLED, db } from './client.js';

/**
 * Call recordings + transcripts — persistence (2026-11-20, D8).
 *
 * SHIPS DARK: the only writers are the Twilio call-recording
 * callbacks in routes/twilioVoice.js, and they write only while
 * CALL_RECORDING_ENABLED is on (voiceConfig().callRecordingEnabled,
 * default false). With the flag off this layer is never called and
 * the table stays empty. Dual-mode like the rest of the platform:
 * the CallRecording table is the durable record, the in-memory store
 * list is the working set the CRM reads.
 */

function iso(value) {
  if (!value) return null;
  return value instanceof Date ? value.toISOString() : String(value);
}

function toStoreRecording(row) {
  return {
    id: row.id,
    callSid: row.callSid,
    recordingSid: row.recordingSid || null,
    fromNumber: row.fromNumber,
    toNumber: row.toNumber,
    recordingUrl: row.recordingUrl || null,
    durationSec: row.durationSec ?? null,
    status: row.status || 'RECORDED',
    transcript: row.transcript || null,
    transcriptStatus: row.transcriptStatus || 'NONE',
    consentAnnouncementPlayed: row.consentAnnouncementPlayed === true,
    createdAt: iso(row.createdAt),
    updatedAt: iso(row.updatedAt),
  };
}

export async function hydrateCallRecordings() {
  if (!DATABASE_ENABLED) return;
  try {
    const rows = await db().callRecording.findMany({ orderBy: { createdAt: 'desc' }, take: 500 });
    store.callRecordings = rows.map(toStoreRecording);
  } catch {
    // A missing table mid-deploy degrades to an empty list, like
    // every other add-on layer — never blocks hydration.
    store.callRecordings = [];
  }
}

/**
 * Idempotent upsert keyed on the Twilio CallSid: a redelivered
 * recording callback updates the same row instead of duplicating it.
 */
export async function recordCallRecording(input) {
  const now = new Date().toISOString();
  const existing = store.callRecordings.find((r) => r.callSid === input.callSid);
  const record = {
    id: existing?.id || createId(),
    callSid: input.callSid,
    recordingSid: input.recordingSid || existing?.recordingSid || null,
    fromNumber: input.fromNumber || existing?.fromNumber || '',
    toNumber: input.toNumber || existing?.toNumber || '',
    recordingUrl: input.recordingUrl || existing?.recordingUrl || null,
    durationSec: input.durationSec ?? existing?.durationSec ?? null,
    status: 'RECORDED',
    transcript: existing?.transcript || null,
    transcriptStatus: existing?.transcriptStatus || 'NONE',
    consentAnnouncementPlayed: input.consentAnnouncementPlayed === true,
    createdAt: existing?.createdAt || now,
    updatedAt: now,
  };
  if (existing) Object.assign(existing, record);
  else store.callRecordings.unshift(record);
  if (DATABASE_ENABLED) {
    try {
      const row = {
        id: record.id,
        callSid: record.callSid,
        recordingSid: record.recordingSid,
        fromNumber: record.fromNumber,
        toNumber: record.toNumber,
        recordingUrl: record.recordingUrl,
        durationSec: record.durationSec,
        status: record.status,
        transcript: record.transcript,
        transcriptStatus: record.transcriptStatus,
        consentAnnouncementPlayed: record.consentAnnouncementPlayed,
        createdAt: new Date(record.createdAt),
        updatedAt: new Date(record.updatedAt),
      };
      await db().callRecording.upsert({ where: { callSid: record.callSid }, update: row, create: row });
    } catch (error) {
      console.error('recordCallRecording failed', error?.message || error);
    }
  }
  return record;
}

export async function attachCallTranscript({ callSid, transcript, failed }) {
  const record = store.callRecordings.find((r) => r.callSid === callSid);
  if (!record) return null;
  record.transcript = failed ? record.transcript : (transcript || '');
  record.transcriptStatus = failed ? 'FAILED' : 'RECEIVED';
  if (!failed) record.status = 'TRANSCRIBED';
  record.updatedAt = new Date().toISOString();
  if (DATABASE_ENABLED) {
    try {
      await db().callRecording.update({
        where: { callSid },
        data: {
          transcript: record.transcript,
          transcriptStatus: record.transcriptStatus,
          status: record.status,
          updatedAt: new Date(record.updatedAt),
        },
      });
    } catch (error) {
      console.error('attachCallTranscript failed', error?.message || error);
    }
  }
  return record;
}

/** Recordings involving a phone number (either leg), newest first. */
export function callRecordingsForPhone(digits10Value) {
  const wanted = String(digits10Value || '').replace(/\D/g, '').slice(-10);
  if (!wanted) return [];
  const digits = (value) => String(value || '').replace(/\D/g, '').slice(-10);
  return store.callRecordings
    .filter((r) => digits(r.fromNumber) === wanted || digits(r.toNumber) === wanted)
    .sort((a, b) => String(b.createdAt).localeCompare(String(a.createdAt)));
}
