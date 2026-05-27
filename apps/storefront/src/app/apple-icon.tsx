import { ImageResponse } from 'next/og';

export const size = { width: 180, height: 180 };
export const contentType = 'image/png';

/**
 * Apple touch icon (iOS home screen / Safari favorites).
 */
export default function AppleIcon() {
  return new ImageResponse(
    (
      <div
        style={{
          width: '100%',
          height: '100%',
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          background: 'linear-gradient(135deg, #EC4899 0%, #7C3AED 50%, #3B82F6 100%)',
          color: 'white',
          fontSize: 90,
          fontWeight: 800,
          fontFamily: 'system-ui, -apple-system, sans-serif',
          borderRadius: 40,
        }}
      >
        C&amp;
      </div>
    ),
    { ...size }
  );
}
