// Browser-recorded WebM files carry no duration, so players can't seek them. Asking for a
// far-off position makes the browser scan the file and discover the real duration.
document.querySelectorAll('video[data-fix-duration]').forEach((video) => {
  video.addEventListener('loadedmetadata', function fix() {
    if (video.duration !== Infinity) return;
    video.addEventListener('durationchange', function reset() {
      if (video.duration === Infinity) return;
      video.removeEventListener('durationchange', reset);
      video.currentTime = 0;
    });
    video.currentTime = 1e101;
  }, { once: true });
});
