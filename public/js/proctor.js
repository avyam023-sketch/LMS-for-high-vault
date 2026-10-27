// Shared proctoring toolkit for the exam check-in and the live exam.
// Everything runs in the browser and talks only to this site: face detection uses a
// self-hosted model, and media is uploaded to the server (encrypted at rest there).

const FACE_API = '/vendor/face-api/face-api.esm.js';
const FACE_MODEL = '/vendor/face-api/model';

export function csrfHeaders(csrf, extra = {}) {
  return { 'x-csrf-token': csrf, Accept: 'application/json', ...extra };
}

/** Requirements we can check before the exam: desktop browser, camera API, single screen. */
export function environmentCheck() {
  const touchOnly = window.matchMedia('(pointer: coarse)').matches && !window.matchMedia('(any-pointer: fine)').matches;
  return {
    desktop: !touchOnly,
    mediaSupported: Boolean(navigator.mediaDevices?.getUserMedia && window.MediaRecorder),
    // Chromium browsers (Chrome, Edge) report whether more than one display is connected.
    screenCheckSupported: typeof window.screen.isExtended === 'boolean',
    singleScreen: window.screen.isExtended === false,
    fullscreenSupported: Boolean(document.documentElement.requestFullscreen),
  };
}

export async function startCamera(videoEl) {
  const stream = await navigator.mediaDevices.getUserMedia({
    video: { width: { ideal: 640 }, height: { ideal: 480 }, facingMode: 'user' },
    audio: { echoCancellation: false, noiseSuppression: false },
  });
  videoEl.srcObject = stream;
  videoEl.muted = true;
  await videoEl.play().catch(() => {});
  return stream;
}

export function stopStream(stream) {
  stream?.getTracks().forEach((t) => t.stop());
}

/** Grabs the current camera frame as a JPEG blob. */
export function captureFrame(videoEl, { width = 640, quality = 0.85 } = {}) {
  const w = Math.min(width, videoEl.videoWidth || width);
  const h = Math.round(w * ((videoEl.videoHeight || 480) / (videoEl.videoWidth || 640)));
  const canvas = document.createElement('canvas');
  canvas.width = w;
  canvas.height = h;
  canvas.getContext('2d').drawImage(videoEl, 0, 0, w, h);
  return new Promise((resolve) => canvas.toBlob(resolve, 'image/jpeg', quality));
}

export async function uploadMedia(attemptId, csrf, kind, blob, note = '') {
  const type = blob.type.split(';')[0] || 'application/octet-stream';
  const qs = new URLSearchParams({ kind, ...(note ? { note } : {}) });
  const res = await fetch(`/exam/${attemptId}/media?${qs}`, {
    method: 'POST',
    credentials: 'same-origin',
    headers: csrfHeaders(csrf, { 'Content-Type': type }),
    body: blob,
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || 'Upload failed. Check your connection and try again.');
  return data;
}

export async function postEvent(attemptId, csrf, kind, detail) {
  const res = await fetch(`/exam/${attemptId}/event`, {
    method: 'POST',
    credentials: 'same-origin',
    headers: csrfHeaders(csrf, { 'Content-Type': 'application/json' }),
    body: JSON.stringify(detail ? { kind, detail: String(detail).slice(0, 300) } : { kind }),
  });
  return res.json().catch(() => ({}));
}

/** Loads the self-hosted face detector. Resolves to null if the device can't run it. */
let detectorPromise;
export function loadFaceDetector() {
  detectorPromise ??= (async () => {
    try {
      const faceapi = await import(FACE_API);
      await faceapi.tf.setBackend('webgl').catch(() => {});
      await faceapi.tf.ready();
      await faceapi.nets.tinyFaceDetector.loadFromUri(FACE_MODEL);
      const options = new faceapi.TinyFaceDetectorOptions({ inputSize: 224, scoreThreshold: 0.55 });
      return { count: async (videoEl) => (await faceapi.detectAllFaces(videoEl, options)).length };
    } catch (err) {
      console.warn('Face detection unavailable', err);
      return null;
    }
  })();
  return detectorPromise;
}

/** Live microphone level (0–1). Used to flag sustained noise or talking for the reviewer. */
export function audioMeter(stream) {
  const track = stream.getAudioTracks()[0];
  if (!track) return null;
  const ctx = new (window.AudioContext || window.webkitAudioContext)();
  const source = ctx.createMediaStreamSource(new MediaStream([track]));
  const analyser = ctx.createAnalyser();
  analyser.fftSize = 1024;
  source.connect(analyser);
  const data = new Float32Array(analyser.fftSize);
  return {
    level() {
      analyser.getFloatTimeDomainData(data);
      let sum = 0;
      for (const v of data) sum += v * v;
      return Math.min(1, Math.sqrt(sum / data.length) * 4);
    },
    close: () => ctx.close(),
    resume: () => ctx.resume().catch(() => {}),
  };
}

/** Records the camera (with sound) for the room scan. */
export function recordStream(stream) {
  const type = ['video/webm;codecs=vp8,opus', 'video/webm', 'video/mp4'].find((t) => MediaRecorder.isTypeSupported(t));
  const recorder = new MediaRecorder(stream, { mimeType: type, videoBitsPerSecond: 450_000, audioBitsPerSecond: 48_000 });
  const chunks = [];
  recorder.ondataavailable = (e) => e.data.size && chunks.push(e.data);
  const done = new Promise((resolve) => {
    recorder.onstop = () => resolve(new Blob(chunks, { type: (type || 'video/webm').split(';')[0] }));
  });
  recorder.start(1000);
  return { stop: () => (recorder.state !== 'inactive' && recorder.stop(), done) };
}
