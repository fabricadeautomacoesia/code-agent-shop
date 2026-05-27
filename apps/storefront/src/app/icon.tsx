import { ImageResponse } from 'next/og';

export const size = { width: 32, height: 32 };
export const contentType = 'image/png';

/**
 * Favicon dinamico (Next gera PNG do JSX).
 * Aparece como icone da tab no browser + bookmark + PWA.
 */
export default function Icon() {
  return new ImageResponse(
    (
      <div
        style={{
          width: '100%',
          height: '100%',
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          background: 'linear-gradient(135deg, #EC4899 0%, #7C3AED 100%)',
          color: 'white',
          fontSize: 18,
          fontWeight: 700,
          fontFamily: 'system-ui, -apple-system, sans-serif',
          borderRadius: 7,
        }}
      >
        C&amp;
      </div>
    ),
    { ...size }
  );
}
