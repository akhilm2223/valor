// RotateHint — shown when the phone is held in portrait orientation.
//
// Lives at very high z-index on top of the canvas + all controls. When the
// user rotates to landscape, the overlay hides and the spectator view shows
// through. Pure presentational — relies on the parent passing visibility.
//
// Also bakes in an iOS-Safari-only nudge to "Add to Home Screen" for a true
// fullscreen experience (Safari refuses to let web pages hide the URL bar /
// tabs in normal browsing mode; standalone PWA mode is the only way).

interface RotateHintProps {
  show: boolean;
  /** True if the device looks like iOS Safari (used to add the "Add to Home
   *  Screen" tip). */
  iosSafari: boolean;
}

export function RotateHint({ show, iosSafari }: RotateHintProps) {
  if (!show) return null;
  return (
    <div
      style={{
        position: "fixed",
        inset: 0,
        zIndex: 9999,
        background: "linear-gradient(180deg, #0e1115 0%, #1a1f29 100%)",
        color: "#fff",
        display: "flex",
        flexDirection: "column",
        alignItems: "center",
        justifyContent: "center",
        gap: 28,
        padding: "32px 24px",
        fontFamily: "system-ui, sans-serif",
        textAlign: "center",
        // Block all underlying gestures while visible — accidental joystick
        // pulls during rotation aren't useful.
        pointerEvents: "auto",
        touchAction: "none",
        userSelect: "none",
      }}
    >
      <div
        style={{
          fontSize: 84,
          // Slow ~90° twirl loop suggests the action.
          animation: "valor-rotate-hint 2.4s ease-in-out infinite",
        }}
      >
        📱
      </div>
      <div style={{ fontSize: 22, fontWeight: 600, letterSpacing: 0.3 }}>
        Rotate your phone
      </div>
      <div style={{ fontSize: 14, opacity: 0.7, maxWidth: 320, lineHeight: 1.5 }}>
        Spectator works best in landscape. Turn the phone sideways to watch the
        match.
      </div>
      {iosSafari ? (
        <div
          style={{
            marginTop: 18,
            padding: "12px 16px",
            background: "rgba(255,255,255,0.06)",
            border: "1px solid rgba(255,255,255,0.12)",
            borderRadius: 10,
            fontSize: 12,
            lineHeight: 1.5,
            maxWidth: 320,
            opacity: 0.85,
          }}
        >
          <span style={{ opacity: 0.7 }}>iPhone tip:</span> tap the{" "}
          <span style={{ fontWeight: 700 }}>Share</span> icon at the bottom,
          then <span style={{ fontWeight: 700 }}>Add to Home Screen</span>, and
          launch from there for a true fullscreen experience.
        </div>
      ) : null}
      <style>{`
        @keyframes valor-rotate-hint {
          0%   { transform: rotate(0deg); }
          40%  { transform: rotate(-90deg); }
          60%  { transform: rotate(-90deg); }
          100% { transform: rotate(0deg); }
        }
      `}</style>
    </div>
  );
}
