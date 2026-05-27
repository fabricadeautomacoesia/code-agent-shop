import { ImageResponse } from 'next/og';

export const alt = 'Code & Agent Shop - Marketplace de Automacoes e IA';
export const size = { width: 1200, height: 630 };
export const contentType = 'image/png';

/**
 * OG image gerada dinamicamente para WhatsApp / Twitter / Facebook share.
 * Aparece quando alguem compartilha link da homepage.
 */
export default function OGImage() {
  return new ImageResponse(
    (
      <div
        style={{
          width: '100%',
          height: '100%',
          display: 'flex',
          flexDirection: 'column',
          alignItems: 'flex-start',
          justifyContent: 'center',
          padding: 80,
          background: '#0A0F1C',
          backgroundImage:
            'radial-gradient(circle at 20% 20%, rgba(236,72,153,0.15) 0%, transparent 50%), radial-gradient(circle at 80% 80%, rgba(124,58,237,0.15) 0%, transparent 50%)',
          color: 'white',
          fontFamily: 'system-ui, -apple-system, sans-serif',
        }}
      >
        <div style={{
          display: 'flex',
          alignItems: 'center',
          gap: 16,
          marginBottom: 32,
        }}>
          <div style={{
            width: 80, height: 80,
            background: 'linear-gradient(135deg, #EC4899 0%, #7C3AED 100%)',
            borderRadius: 18,
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            fontSize: 48,
            fontWeight: 800,
          }}>C&amp;</div>
          <div style={{ fontSize: 48, fontWeight: 700, letterSpacing: -2 }}>
            Code <span style={{ color: '#EC4899' }}>&amp;</span> Agent <span style={{ color: '#9CA3AF' }}>Shop</span>
          </div>
        </div>
        <div style={{ fontSize: 64, fontWeight: 700, lineHeight: 1.1, maxWidth: 1000 }}>
          Marketplace de automacoes,<br />agentes IA e workflows n8n
        </div>
        <div style={{
          fontSize: 28,
          color: '#9CA3AF',
          marginTop: 32,
        }}>
          QA automatizado por LLM. Pague em PIX/cartao 12x. CAS Pontos a cada compra.
        </div>
      </div>
    ),
    { ...size }
  );
}
