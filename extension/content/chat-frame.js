// Runs only inside chat popout frames. GhostPiP embeds these pages in its own PiP/overlay, so the
// marker lets chat-frame.css trim site chrome there without touching a popout the user opens directly.
if (window.top !== window) {
  document.documentElement.setAttribute("data-ghostpip-embed", "");
}
