import { getReaderProgress, captureFanqiePage } from './fanqie-reading.js';

// Observation only. Caller must hold the shared phone mutex for the entire operation.
export function createFanqieReadingGuard({serial, configuredSerial=process.env.PHONE_SERIAL, progress=getReaderProgress, capture=captureFanqiePage}={}) {
 return async reading => {
  if (!serial || serial !== configuredSerial || !reading?.text?.trim() || !reading.source || !reading.fingerprint || !reading.progress?.chapter) return false;
  const same = p => p && p.chapter === reading.progress.chapter && p.page === reading.progress.page && p.total === reading.progress.total;
  try {
   if (!same(await progress(serial))) return false;
   const page=await capture(serial);
   if (!page || page.source !== reading.source || page.fingerprint !== reading.fingerprint || page.text !== reading.text) return false;
   return Boolean(same(await progress(serial)));
  } catch { return false; }
 };
}
