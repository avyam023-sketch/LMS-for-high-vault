// Exam check-in: system check → face photo → ID photo → room scan → begin.
// The exam timer only starts when the learner presses "Begin exam".
import {
  audioMeter, captureFrame, environmentCheck, loadFaceDetector, postEvent, recordStream, startCamera, uploadMedia,
} from './proctor.js';

const root = document.querySelector('[data-checkin]');
const attemptId = root.dataset.checkin;
const csrf = root.dataset.csrf;
const video = root.querySelector('[data-cam]');
const camEmpty = root.querySelector('[data-cam-empty]');
const steps = [...root.querySelectorAll('[data-step]')];
const done = { face: Boolean(root.dataset.doneFace), id: Boolean(root.dataset.doneId), room: Boolean(root.dataset.doneRoom) };

let stream = null;
let detector = null;
let detectorState = 'loading'; // loading | ready | unavailable
let faces = null; // latest face count, or null when unknown
let current = 'system';

const $step = (name) => root.querySelector(`[data-step="${name}"]`);
const showError = (step, message) => {
  const box = $step(step).querySelector('[data-error]');
  box.textContent = message ?? '';
  box.hidden = !message;
};
function setCheck(name, state, label) {
  const li = root.querySelector(`[data-check="${name}"]`);
  li.classList.remove('ok', 'bad', 'warn');
  if (state) li.classList.add(state);
  if (label && name === 'face') li.querySelector('[data-face-label]').textContent = label;
}

function go(name) {
  current = name;
  for (const s of steps) {
    s.classList.toggle('active', s.dataset.step === name);
    const order = steps.indexOf(s);
    s.classList.toggle('complete', order < steps.indexOf($step(name)));
  }
  $step(name).scrollIntoView({ block: 'nearest', behavior: 'smooth' });
  if (name === 'face') {
    faceStepStarted = Date.now();
    updateFaceHint();
  }
}
const nextAfter = (name) => {
  const order = ['system', 'face', 'id', 'room', 'confirm'];
  const remaining = order.slice(order.indexOf(name) + 1);
  return remaining.find((s) => !(s === 'face' && done.face) && !(s === 'id' && done.id) && !(s === 'room' && done.room)) ?? 'confirm';
};

// ---------- 1. System check ----------
const env = environmentCheck();
function evaluateSystem() {
  const browserOk = env.desktop && env.mediaSupported && env.screenCheckSupported && env.fullscreenSupported;
  setCheck('browser', browserOk ? 'ok' : 'bad');
  const single = window.screen.isExtended === false;
  setCheck('screen', single ? 'ok' : 'bad');
  const camOk = Boolean(stream?.getVideoTracks()[0]?.readyState === 'live');
  const micOk = Boolean(stream?.getAudioTracks()[0]?.readyState === 'live');
  setCheck('camera', stream ? (camOk ? 'ok' : 'bad') : null);
  setCheck('mic', stream ? (micOk ? 'ok' : 'bad') : null);
  let problem = null;
  if (!env.desktop) problem = 'The exam must be taken on a laptop or desktop computer, not a phone or tablet.';
  else if (!env.mediaSupported || !env.screenCheckSupported || !env.fullscreenSupported) problem = 'Please open this page in Google Chrome or Microsoft Edge to take the exam.';
  else if (!single) problem = 'More than one screen is connected. Disconnect extra monitors (or set your display to show on one screen only), then continue.';
  else if (stream && (!camOk || !micOk)) problem = 'Your camera and microphone both need to be on.';
  const ready = !problem && camOk && micOk;
  showError('system', problem);
  $step('system').querySelector('[data-next]').disabled = !ready;
  return ready;
}
window.screen.addEventListener?.('change', evaluateSystem);
evaluateSystem();

$step('system').querySelector('[data-start-camera]').addEventListener('click', async (e) => {
  e.target.disabled = true;
  try {
    stream = await startCamera(video);
    camEmpty.hidden = true;
    stream.getTracks().forEach((t) => t.addEventListener('ended', evaluateSystem));
    startMeter();
    startFaceLoop();
    e.target.textContent = 'Camera on';
  } catch (err) {
    e.target.disabled = false;
    showError('system', err?.name === 'NotAllowedError'
      ? 'Camera or microphone access was blocked. Click the camera icon in the address bar, allow access, then try again.'
      : 'We couldn’t find a working camera and microphone. Connect one and try again.');
  }
  evaluateSystem();
});
$step('system').querySelector('[data-next]').addEventListener('click', () => evaluateSystem() && go(nextAfter('system')));

function startMeter() {
  const meter = audioMeter(stream);
  const bar = root.querySelector('[data-meter]');
  if (!meter) return;
  setInterval(() => { bar.style.width = `${Math.round(meter.level() * 100)}%`; }, 120);
}

let faceStepStarted = 0;
async function startFaceLoop() {
  detector = await loadFaceDetector();
  detectorState = detector ? 'ready' : 'unavailable';
  if (!detector) {
    updateFaceHint();
    setCheck('face', 'warn', 'Face detection unavailable — reviewed manually');
    postEvent(attemptId, csrf, 'detector_unavailable');
    return;
  }
  const tick = async () => {
    try {
      faces = await detector.count(video);
      if (faces === 1) setCheck('face', 'ok', 'Face detected');
      else if (faces === 0) setCheck('face', 'warn', 'No face detected — face the camera');
      else setCheck('face', 'bad', `${faces} faces detected — only you may be in view`);
    } catch {
      /* frame not ready */
    }
    updateFaceHint();
    setTimeout(tick, 900);
  };
  tick();
}

// ---------- 2 & 3. Face and ID photos ----------
function updateFaceHint() {
  if (current !== 'face') return;
  const hint = $step('face').querySelector('[data-face-hint]');
  const btn = $step('face').querySelector('[data-capture]');
  const waited = Date.now() - faceStepStarted > 15000;
  if (detectorState === 'unavailable') {
    hint.textContent = 'Automatic face detection isn’t available on this device. Take your photo — a reviewer will check it.';
    btn.disabled = false;
    return;
  }
  if (detectorState === 'loading' || faces === null) hint.textContent = 'Looking for your face…';
  else if (faces === 1) hint.textContent = 'Face detected. Hold still and take your photo.';
  else if (faces > 1) hint.textContent = 'More than one face is in view. Only you may be in the room.';
  else hint.textContent = waited ? 'We still can’t detect your face. Improve the lighting, or take the photo anyway — it will be checked by a reviewer.' : 'Looking for your face…';
  btn.disabled = faces !== 1 && !(waited && faces === 0);
}

function photoStep(name, kind) {
  const step = $step(name);
  const wrap = step.querySelector('[data-preview-wrap]');
  const img = step.querySelector('[data-preview]');
  const [capture, retake, use] = ['[data-capture]', '[data-retake]', '[data-use]'].map((s) => step.querySelector(s));
  let blob = null;
  capture.addEventListener('click', async () => {
    if (!stream) return showError(name, 'Turn your camera on first.');
    blob = await captureFrame(video, { width: 960, quality: 0.88 });
    img.src = URL.createObjectURL(blob);
    wrap.hidden = false;
    capture.hidden = true;
    retake.hidden = false;
    use.hidden = false;
    if (name === 'face' && detectorState === 'ready' && faces !== 1) postEvent(attemptId, csrf, 'face_check_skipped', `faces=${faces}`);
  });
  retake.addEventListener('click', () => {
    wrap.hidden = true;
    capture.hidden = false;
    retake.hidden = true;
    use.hidden = true;
  });
  use.addEventListener('click', async () => {
    use.disabled = true;
    use.textContent = 'Uploading…';
    try {
      await uploadMedia(attemptId, csrf, kind, blob);
      done[name] = true;
      showError(name, null);
      go(nextAfter(name));
    } catch (err) {
      showError(name, err.message);
    } finally {
      use.disabled = false;
      use.textContent = 'Use this photo';
    }
  });
}
photoStep('face', 'face');
photoStep('id', 'id');

// ---------- 4. Room scan ----------
(() => {
  const step = $step('room');
  const [record, stop, retake, use] = ['[data-record]', '[data-stop]', '[data-retake]', '[data-use]'].map((s) => step.querySelector(s));
  const wrap = step.querySelector('[data-preview-wrap]');
  const preview = step.querySelector('[data-preview]');
  const badge = root.querySelector('[data-rec-badge]');
  const time = root.querySelector('[data-rec-time]');
  const MIN = 30;
  const MAX = 120;
  let rec = null;
  let blob = null;
  let timer = null;

  async function finish() {
    clearInterval(timer);
    badge.hidden = true;
    blob = await rec.stop();
    preview.src = URL.createObjectURL(blob);
    wrap.hidden = false;
    stop.hidden = true;
    retake.hidden = false;
    use.hidden = false;
  }
  record.addEventListener('click', () => {
    if (!stream) return showError('room', 'Turn your camera on first.');
    showError('room', null);
    rec = recordStream(stream);
    const started = Date.now();
    record.hidden = true;
    stop.hidden = false;
    stop.disabled = true;
    badge.hidden = false;
    timer = setInterval(() => {
      const s = Math.floor((Date.now() - started) / 1000);
      time.textContent = `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
      stop.disabled = s < MIN;
      stop.textContent = s < MIN ? `Keep going… ${MIN - s}s` : 'Stop recording';
      if (s >= MAX) finish();
    }, 250);
  });
  stop.addEventListener('click', finish);
  retake.addEventListener('click', () => {
    wrap.hidden = true;
    retake.hidden = true;
    use.hidden = true;
    record.hidden = false;
  });
  use.addEventListener('click', async () => {
    use.disabled = true;
    use.textContent = 'Uploading…';
    try {
      await uploadMedia(attemptId, csrf, 'room_scan', blob);
      done.room = true;
      go('confirm');
    } catch (err) {
      showError('room', err.message);
    } finally {
      use.disabled = false;
      use.textContent = 'Upload room scan';
    }
  });
})();

// ---------- 5. Begin ----------
(() => {
  const step = $step('confirm');
  const box = step.querySelector('[data-confirm]');
  const begin = step.querySelector('[data-begin]');
  box.addEventListener('change', () => { begin.disabled = !box.checked; });
  begin.addEventListener('click', async () => {
    if (!evaluateSystem()) {
      go('system');
      return;
    }
    begin.disabled = true;
    try {
      const res = await fetch(`/exam/${attemptId}/begin`, {
        method: 'POST',
        credentials: 'same-origin',
        headers: { 'Content-Type': 'application/json', Accept: 'application/json', 'x-csrf-token': csrf },
        body: JSON.stringify({ confirm: true }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || 'The exam could not be started.');
      window.location.assign(data.redirect);
    } catch (err) {
      showError('confirm', err.message);
      begin.disabled = false;
    }
  });
})();

go('system');
