// Live exam monitoring: camera and microphone on, face in view, one screen, periodic snapshots.
// Reliable signals (camera off, second screen) count as warnings through exam.js; face and
// noise checks are logged with snapshots for the human reviewer.
import { audioMeter, captureFrame, loadFaceDetector, startCamera, uploadMedia } from './proctor.js';

const video = document.querySelector('[data-exam-cam] video');
const overlay = document.querySelector('[data-camera-overlay]');
const overlayText = document.querySelector('[data-camera-text]');
const retry = document.querySelector('[data-camera-retry]');
const exam = () => window.hvExam;

let stream = null;
let meter = null;
let markReady;
window.hvProctorReady = new Promise((resolve) => { markReady = resolve; });

const SNAPSHOT_EVERY = 30_000;
const NO_FACE_AFTER = 8_000;

async function snapshot(note) {
  if (!stream || !exam()?.isRunning()) return;
  try {
    const blob = await captureFrame(video, { width: 480, quality: 0.7 });
    if (blob) await uploadMedia(exam().attemptId, exam().csrf, 'snapshot', blob, note);
  } catch {
    /* best effort; the next snapshot will try again */
  }
}

function report(kind, detail) {
  snapshot(kind);
  return exam()?.report(kind, detail);
}

function cameraLost(reason) {
  overlayText.textContent = reason;
  overlay.hidden = false;
  if (exam()?.isRunning()) report('camera_off', reason);
}

async function connect() {
  try {
    stream = await startCamera(video);
    meter?.close();
    meter = audioMeter(stream);
    for (const track of stream.getTracks()) {
      track.addEventListener('ended', () => cameraLost('Your camera or microphone stopped. Turn it back on to continue.'));
    }
    if (!overlay.hidden && exam()?.isRunning()) exam().report('camera_restored');
    overlay.hidden = true;
    markReady();
  } catch (err) {
    stream = null;
    overlayText.textContent = err?.name === 'NotAllowedError'
      ? 'Camera access is blocked. Click the camera icon in the address bar, allow the camera and microphone, then try again.'
      : 'We can’t reach your camera. Check that it’s connected and not used by another app, then try again.';
    overlay.hidden = false;
  }
}
retry.addEventListener('click', () => {
  meter?.resume();
  connect();
});
document.addEventListener('click', () => meter?.resume(), { capture: true });

// ---------- Face presence ----------
(async () => {
  const detector = await loadFaceDetector();
  if (!detector) {
    const wait = setInterval(() => {
      if (exam()?.isRunning()) {
        exam().report('detector_unavailable');
        clearInterval(wait);
      }
    }, 2000);
    return;
  }
  let noFaceSince = null;
  let multiStreak = 0;
  let flaggedNoFace = false;
  let flaggedMulti = false;
  setInterval(async () => {
    if (!stream || !exam()?.isRunning() || document.hidden) return;
    let n;
    try {
      n = await detector.count(video);
    } catch {
      return;
    }
    if (n === 0) {
      noFaceSince ??= Date.now();
      if (!flaggedNoFace && Date.now() - noFaceSince > NO_FACE_AFTER) {
        flaggedNoFace = true;
        report('no_face', 'No face in view for 8+ seconds');
      }
    } else {
      noFaceSince = null;
      flaggedNoFace = false;
    }
    multiStreak = n > 1 ? multiStreak + 1 : 0;
    if (multiStreak >= 2 && !flaggedMulti) {
      flaggedMulti = true;
      report('multiple_faces', `${n} faces in view`);
    }
    if (n <= 1) flaggedMulti = false;
  }, 2500);
})();

// ---------- One screen only ----------
let extended = window.screen.isExtended === true;
function checkScreens() {
  const now = window.screen.isExtended === true;
  if (now && !extended && exam()?.isRunning()) report('second_screen', 'Additional display connected');
  extended = now;
}
window.screen.addEventListener?.('change', checkScreens);
setInterval(checkScreens, 3000);

// ---------- Sustained noise or talking (logged for review) ----------
let loudSince = null;
let lastNoise = 0;
setInterval(() => {
  if (!meter || !exam()?.isRunning()) return;
  if (meter.level() > 0.35) {
    loudSince ??= Date.now();
    if (Date.now() - loudSince > 3000 && Date.now() - lastNoise > 60_000) {
      lastNoise = Date.now();
      exam().report('noise', 'Sustained sound or talking');
    }
  } else {
    loudSince = null;
  }
}, 250);

// ---------- Camera health + periodic snapshots ----------
setInterval(() => {
  if (!exam()?.isRunning()) return;
  const live = stream?.getVideoTracks()[0]?.readyState === 'live';
  if (!live && overlay.hidden) cameraLost('Your camera turned off. Turn it back on to continue.');
}, 2000);
setInterval(() => snapshot(''), SNAPSHOT_EVERY);
// One snapshot shortly after the exam starts.
const firstShot = setInterval(() => {
  if (exam()?.isRunning()) {
    clearInterval(firstShot);
    setTimeout(() => snapshot('start'), 2000);
  }
}, 1000);

connect();
